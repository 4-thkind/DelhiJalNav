"""Route decision: apply hazard states to reviewed candidate geometry.

Deterministic server-side code. The UI never decides which route is admissible.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta

from domain.geometry import distance_m, line_intersects_polygon, line_near_point, point_in_polygon, validate_line
from domain.policy import iso, parse_iso

#: Origin/destination further than this from a preset endpoint is outside the pilot.
PAIR_MATCH_M = 400.0
#: A route passing this close to water the rider's own camera flagged is not offered.
AVOID_RADIUS_M = 30.0
#: Upper bound on how long a route decision may be reused without a new evaluation.
MAX_DECISION_TTL = timedelta(seconds=60)


def match_pair(corridor: dict, request: dict) -> dict | None:
    if request.get("routePairId"):
        return next((p for p in corridor["pairs"] if p["id"] == request["routePairId"]), None)
    origin, destination = request.get("origin"), request.get("destination")
    if validate_line([origin, destination], (-180, -90, 180, 90)) in ("GEOMETRY_TOO_SHORT", "GEOMETRY_INVALID_COORDINATE",
                                                                      "GEOMETRY_OUTSIDE_COVERAGE_OR_SWAPPED"):
        return None
    for pair in corridor["pairs"]:
        if (
            distance_m(pair["origin"]["coordinates"], origin) <= PAIR_MATCH_M
            and distance_m(pair["destination"]["coordinates"], destination) <= PAIR_MATCH_M
        ):
            return pair
    return None


def compare(
    pair: dict,
    hotspots: list[dict],
    states: dict[str, dict],
    revisions: dict[str, int],
    now: datetime,
    data_mode: str,
    corridor: dict,
    avoid: list[list[float]] | None = None,
) -> dict:
    """Pick the fastest admissible candidate.

    avoid: points where the rider's own camera flagged possible water. Personal to
    this request - never stored, never shown to anyone else. Inside a known basin
    the whole basin is avoided; elsewhere, the road within AVOID_RADIUS_M.

    hotspots: GeoJSON features (properties + Polygon) enabled for routing.
    states: hotspotId -> evaluated policy state.
    """
    restricted = {h["id"]: h for h in hotspots if states.get(h["id"], {}).get("restricts")}
    routes, rejected = [], []

    for cand in pair["candidates"]:
        coords = cand["geometry"]["coordinates"]
        reasons: list[dict] = []
        error = validate_line(coords)
        if error:
            reasons.append({"code": error})
        elif (
            distance_m(coords[0], pair["origin"]["coordinates"]) > PAIR_MATCH_M
            or distance_m(coords[-1], pair["destination"]["coordinates"]) > PAIR_MATCH_M
        ):
            reasons.append({"code": "GEOMETRY_DOES_NOT_CONNECT_ENDPOINTS"})
        else:
            for hid, h in restricted.items():
                if not line_intersects_polygon(coords, h["geometry"]["coordinates"][0]):
                    continue
                if hid in cand.get("separatedFrom", []):
                    continue  # reviewed: this candidate passes on a separate road level
                level = h["properties"].get("roadLevel", "unknown")
                reasons.append({
                    "code": "AMBIGUOUS_ROAD_LEVEL" if level == "unknown" else "CROSSES_RESTRICTED_HOTSPOT",
                    "hotspotId": hid,
                    "state": states[hid]["state"],
                })
            for p in avoid or []:
                basin = next((h for h in hotspots if point_in_polygon(p, h["geometry"]["coordinates"][0])), None)
                if basin and basin["id"] in cand.get("separatedFrom", []):
                    continue
                if (basin and line_intersects_polygon(coords, basin["geometry"]["coordinates"][0])) \
                        or line_near_point(coords, p, AVOID_RADIUS_M):
                    reasons.append({"code": "RIDER_CAMERA_WATER", **({"hotspotId": basin["id"]} if basin else {})})
                    break
        entry = {
            "id": cand["id"],
            "label": cand["label"],
            "roadNames": cand.get("roadNames", []),
            "geometry": cand["geometry"],
            "steps": cand.get("steps", []),
            "distanceM": cand["distanceM"],
            "durationS": cand["durationS"],
            "source": cand["source"],
            "sourceTime": cand["sourceTime"],
            "admissible": not reasons,
            "rejectionReasons": reasons,
        }
        routes.append(entry)
        if reasons:
            rejected.append({"id": cand["id"], "reasons": reasons})

    order = lambda r: (r["durationS"], r["distanceM"])  # noqa: E731 - stable tie-break on distance
    baseline = min(routes, key=order)
    admissible = sorted((r for r in routes if r["admissible"]), key=order)
    selected = admissible[0] if admissible else None

    codes = []
    if selected is None:
        codes.append("NO_ADMISSIBLE_ROUTE")
    elif selected["id"] != baseline["id"]:
        codes.append("BASELINE_REJECTED_ALTERNATIVE_SELECTED")
    else:
        codes.append("BASELINE_ADMISSIBLE")
    if any(x["code"] == "RIDER_CAMERA_WATER" for r in routes for x in r["rejectionReasons"]):
        codes.append("RIDER_CAMERA_WATER_AVOIDED")
    if any(s["state"] == "STALE" for s in states.values()):
        codes.append("STALE_EVIDENCE_KEPT_CAUTIOUS")
    if not any(s["state"] != "UNKNOWN" for s in states.values()):
        codes.append("NO_CURRENT_REPORTS_ON_ASSESSED_SEGMENTS")
    if corridor.get("verification") != "field_reviewed":
        codes.append("GEOMETRY_REVIEW_PENDING")

    boundaries = [parse_iso(s["nextTransitionAt"]) for s in states.values() if s.get("nextTransitionAt")]
    valid_until = min([now + MAX_DECISION_TTL, *boundaries])
    snapshot = hashlib.sha256(
        json.dumps({"revisions": revisions, "states": {k: v["state"] for k, v in states.items()}},
                   sort_keys=True).encode()
    ).hexdigest()[:16]
    decision_id = hashlib.sha256(f"{snapshot}:{pair['id']}:{iso(now)}".encode()).hexdigest()[:16]

    return {
        "decisionId": decision_id,
        "dataMode": data_mode,
        "snapshotId": snapshot,
        "revisions": revisions,
        "states": {k: {"state": v["state"], "reasonCode": v["reasonCode"]} for k, v in states.items()},
        "generatedAt": iso(now),
        "validUntil": iso(valid_until),
        "coverage": {
            "corridorId": corridor["corridorId"],
            "label": "Pilot coverage: selected corridor",
            "geometryVersion": corridor["geometryVersion"],
            "geometryVerification": corridor.get("verification", "candidate"),
            "assessedHotspots": [h["id"] for h in hotspots],
            "note": "Only the listed hotspots are assessed. Other roads on these routes are not.",
        },
        "pairId": pair["id"],
        "baselineRouteId": baseline["id"],
        "selectedRouteId": selected["id"] if selected else None,
        "extraMetres": round(selected["distanceM"] - baseline["distanceM"]) if selected else None,
        "extraSeconds": round(selected["durationS"] - baseline["durationS"]) if selected else None,
        "routes": routes,
        "rejectedCandidates": rejected,
        "explanationCodes": codes,
    }
