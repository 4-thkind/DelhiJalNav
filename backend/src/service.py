"""Application service: one place for every API operation, independent of transport
(Lambda event or local HTTP) and of storage (DynamoDB or in-process)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from domain import routes as route_domain
from domain.geometry import DELHI_BBOX, distance_m, line_intersects_polygon, point_in_polygon
from domain.policy import POLICY_VERSION, Policy, check_clear_review, evaluate, iso
from domain.validation import ApiError, payload_hash, validate_observation
from providers import bedrock, external
from storage.local import DuplicateEvent, RevisionConflict

DATA_DIR = Path(__file__).resolve().parent / "data"
MODES = {
    # APP_MODE: (namespace, clientMode, provenance, label)
    "local-demo": ("demo-local", "LOCAL_DEMO", "SYNTHETIC_DEMO", "Live"),
    "aws-demo": ("demo-aws", "AWS_DEMO", "SYNTHETIC_DEMO", "Live"),
    "live-pilot": ("pilot", "LIVE_PILOT", "LIVE_USER_REPORT", "Live"),
}
DEMO_CONTRIBUTOR_RE = re.compile(r"^demo-[a-z0-9-]{1,32}$")
#: Evidence lookback for a read. Far longer than freshness, so stale/conflict context survives.
LOOKBACK = timedelta(hours=6)
RATE_PER_MINUTE = 10
RATE_PER_DAY = 100
MAX_REVISION_RETRIES = 3
#: Dynamic (tap-anywhere) routing is limited to this radius around the pilot hotspot.
PILOT_RADIUS_M = 40_000
VEHICLES = ("two_wheeler", "auto", "car", "suv", "ev")
DEPTH_ORDER = {"ankle": 1, "knee": 2, "waist": 3, "submerged": 4}
#: Hourly model rainfall at or above this (mm) shows a context advisory. Never a restriction.
RAIN_ADVISORY_MM_PER_H = 5.0


@dataclass
class Config:
    app_mode: str = "local-demo"
    freshness_minutes: int = 30
    poll_seconds: int = 15
    route_provider: str = "reviewed-fixtures"
    demo_admin_key: str = ""
    pseudonym_salt: str = "local-dev-salt"
    build: str = "dev"

    @classmethod
    def from_env(cls) -> "Config":
        mode = os.environ.get("APP_MODE", "local-demo")
        if mode not in MODES:
            raise RuntimeError(f"APP_MODE must be one of {sorted(MODES)}")
        salt = os.environ.get("PSEUDONYM_SALT", "")
        if mode != "local-demo" and len(salt) < 16:
            raise RuntimeError("PSEUDONYM_SALT (16+ chars) is required outside local-demo")
        return cls(
            app_mode=mode,
            freshness_minutes=int(os.environ.get("EVIDENCE_FRESHNESS_MINUTES", "30")),
            poll_seconds=int(os.environ.get("HAZARD_POLL_SECONDS", "15")),
            route_provider=os.environ.get("ROUTE_PROVIDER", "reviewed-fixtures"),
            demo_admin_key=os.environ.get("DEMO_ADMIN_KEY", ""),
            pseudonym_salt=salt or "local-dev-salt",
            build=os.environ.get("BUILD_ID", "dev"),
        )

    @property
    def namespace(self) -> str:
        return MODES[self.app_mode][0]

    @property
    def client_mode(self) -> str:
        return MODES[self.app_mode][1]

    @property
    def provenance(self) -> str:
        return MODES[self.app_mode][2]

    @property
    def is_demo(self) -> bool:
        return self.app_mode != "live-pilot"


@dataclass
class Principal:
    """Who is calling, as established by the transport - never by the request body."""
    kind: str = "anonymous"          # anonymous | demo | jwt | demo-admin
    subject: str | None = None
    groups: list[str] = field(default_factory=list)


def load_fixtures() -> tuple[dict, list[dict]]:
    corridor = json.loads((DATA_DIR / "routes" / "minto-corridor.json").read_text(encoding="utf-8"))
    hotspots = json.loads((DATA_DIR / "hotspots.geojson").read_text(encoding="utf-8"))["features"]
    return corridor, [h for h in hotspots if h["properties"]["enabledForRouting"]]


class Service:
    def __init__(self, store, config: Config, clock: Callable[[], datetime] | None = None) -> None:
        self.store, self.cfg = store, config
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self.policy = Policy(freshness=timedelta(minutes=config.freshness_minutes))
        self.corridor, self.hotspots = load_fixtures()
        self.hotspot_ids = {h["id"] for h in self.hotspots}
        self.landmarks = json.loads((DATA_DIR / "landmarks.json").read_text(encoding="utf-8"))["landmarks"]

    # ------------------------------------------------------------ helpers
    def _control(self) -> dict:
        return self.store.get_control(self.cfg.namespace) if self.cfg.is_demo else {}

    def now(self) -> datetime:
        offset = self._control().get("clockOffsetMinutes", 0)
        return self._clock() + timedelta(minutes=offset)

    def _source_key(self, subject: str, now: datetime) -> str:
        # pseudonymous, rotates daily, never derived from anything the body says
        raw = f"{self.cfg.namespace}|{subject}|{now.date().isoformat()}"
        return hmac.new(self.cfg.pseudonym_salt.encode(), raw.encode(), hashlib.sha256).hexdigest()[:20]

    def _check_corridor(self, corridor_id: str | None) -> None:
        if corridor_id != self.corridor["corridorId"]:
            raise ApiError(400, "UNSUPPORTED_CORRIDOR", "Only the pilot corridor is supported.")

    def _evaluate(self, hid: str, now: datetime) -> tuple[dict | None, list[dict], dict]:
        stored = self.store.get_state(self.cfg.namespace, hid)
        observations = self.store.list_observations(self.cfg.namespace, hid, iso(now - LOOKBACK))
        result = evaluate(
            observations, now, self.policy,
            last_known_positive_at=(stored or {}).get("lastKnownPositiveAt"),
            clear_review=(stored or {}).get("clearReview"),
        )
        return stored, observations, result

    def _require_contributor(self, p: Principal) -> str:
        if self.cfg.is_demo and p.kind == "demo" and p.subject:
            return p.subject
        if not self.cfg.is_demo and p.kind == "jwt" and p.subject:
            return p.subject
        raise ApiError(401, "AUTH_REQUIRED", "Sign in as a contributor to submit reports.")

    def _require_reviewer(self, p: Principal) -> str:
        if self.cfg.is_demo and p.kind == "demo-admin":
            return "demo-reviewer"
        if not self.cfg.is_demo and p.kind == "jwt" and "reviewers" in p.groups and p.subject:
            return p.subject
        if p.kind in ("demo", "jwt"):
            raise ApiError(403, "REVIEWER_ROLE_REQUIRED", "This action needs a reviewer.")
        raise ApiError(401, "AUTH_REQUIRED", "Sign in as a reviewer.")

    # ---------------------------------------------------------- endpoints
    def status(self) -> dict:
        control = self._control()
        return {
            "build": self.cfg.build,
            "appMode": self.cfg.app_mode,
            "clientMode": self.cfg.client_mode,
            "modeLabel": MODES[self.cfg.app_mode][3],
            "provenance": self.cfg.provenance,
            "serverTime": iso(self.now()),
            "policyVersion": POLICY_VERSION,
            "freshnessMinutes": self.cfg.freshness_minutes,
            "pollSeconds": self.cfg.poll_seconds,
            "capabilities": {
                "routing": self.cfg.route_provider,
                "reviewerActions": bool(self.cfg.demo_admin_key) if self.cfg.is_demo else True,
                "textExtraction": "bedrock" if os.environ.get("BEDROCK_MODEL_ID") else "rules",
                "weather": "open-meteo",
                "dynamicRouting": "google-routes+osrm-fallback" if os.environ.get("GOOGLE_MAPS_API_KEY") else "osrm-public",
            },
            "demo": {
                "clockOffsetMinutes": control.get("clockOffsetMinutes", 0),
                "simulateRouteProviderFailure": control.get("simulateRouteProviderFailure", False),
            } if self.cfg.is_demo else None,
        }

    def hotspots_view(self, corridor_id: str | None) -> dict:
        self._check_corridor(corridor_id)
        c = self.corridor
        return {
            "corridor": {k: c[k] for k in ("corridorId", "displayName", "geometryVersion", "provider",
                                           "profile", "retrievedAt", "verification", "reviewNotes")},
            "pairs": [{"id": p["id"], "origin": p["origin"], "destination": p["destination"]} for p in c["pairs"]],
            "landmarks": self.landmarks,
            "pilotRadiusM": PILOT_RADIUS_M,
            "hotspots": {"type": "FeatureCollection", "features": self.hotspots},
        }

    def hazards(self, corridor_id: str | None) -> dict:
        self._check_corridor(corridor_id)
        now = self.now()
        items = []
        for h in self.hotspots:
            stored, observations, result = self._evaluate(h["id"], now)
            items.append({"hotspotId": h["id"], "displayName": h["properties"]["displayName"],
                          "revision": (stored or {}).get("revision", 0), **result,
                          "claims": self._claims(observations, result)})
        return {"generatedAt": iso(now), "modeLabel": MODES[self.cfg.app_mode][3],
                "provenance": self.cfg.provenance, "hazards": items}

    def evidence(self, hid: str) -> dict:
        if hid not in self.hotspot_ids:
            raise ApiError(404, "UNKNOWN_HOTSPOT", "No such hotspot in the pilot.")
        now = self.now()
        stored, observations, result = self._evaluate(hid, now)
        labels: dict[str, str] = {}
        rows = []
        for o in sorted(observations, key=lambda o: o["observedAt"], reverse=True)[:50]:
            label = labels.setdefault(o["sourceKey"], f"Source {len(labels) + 1}")
            rows.append({
                "eventId": o["eventId"], "kind": o["kind"], "observedAt": o["observedAt"],
                "receivedAt": o["receivedAt"], "provenance": o["provenance"], "source": label,
                "effective": o["eventId"] in result["effectiveObservationIds"],
                "fresh": o["observedAt"] > iso(now - self.policy.freshness),
                "depthClaim": o.get("depthClaim"),
                "stalledVehicles": o.get("stalledVehicles"),
                # free text may hold personal details; only synthetic demo text is shown
                "description": o.get("description") if self.cfg.is_demo else None,
            })
        return {"hotspotId": hid, "revision": (stored or {}).get("revision", 0), **result,
                "clearReview": (stored or {}).get("clearReview"), "observations": rows}

    def submit(self, body: object, principal: Principal) -> tuple[int, dict]:
        subject = self._require_contributor(principal)
        now = self.now()
        clean = validate_observation(body, self.hotspot_ids, now, self.cfg.client_mode, self.policy)
        ns, digest = self.cfg.namespace, payload_hash(clean)
        source = self._source_key(subject, now)

        previous = self.store.get_idempotency(ns, source, clean["eventId"])
        if previous:
            return self._replay(previous, digest)
        if self.store.count_recent(ns, source, iso(now - timedelta(minutes=1))) >= RATE_PER_MINUTE or \
                self.store.count_recent(ns, source, iso(now - timedelta(days=1))) >= RATE_PER_DAY:
            raise ApiError(429, "RATE_LIMITED", "Too many reports from this contributor. Try later.", True)

        observation = {**clean, "sourceKey": source, "receivedAt": iso(now),
                       "provenance": self.cfg.provenance, "namespace": ns}
        hid = clean["hotspotId"]
        for _ in range(MAX_REVISION_RETRIES):
            stored, observations, _ = self._evaluate(hid, now)
            revision = (stored or {}).get("revision", 0)
            result = evaluate(observations + [observation], now, self.policy,
                              last_known_positive_at=(stored or {}).get("lastKnownPositiveAt"),
                              clear_review=(stored or {}).get("clearReview"))
            new_state = {"revision": revision + 1, "lastKnownPositiveAt": result["lastKnownPositiveAt"],
                         "clearReview": (stored or {}).get("clearReview"), "lastEvaluation": result,
                         "updatedAt": iso(now)}
            response = {"eventId": clean["eventId"], "duplicate": False, "hotspotId": hid,
                        "revision": revision + 1, "state": result["state"], "reasonCode": result["reasonCode"],
                        "receivedAt": iso(now), "provenance": self.cfg.provenance}
            idem = {"sourceKey": source, "eventId": clean["eventId"], "payloadHash": digest,
                    "createdAt": iso(now), "result": response}
            try:
                self.store.commit(ns, hid, revision, new_state, observation=observation, idempotency=idem)
                return 201, response
            except DuplicateEvent:
                return self._replay(self.store.get_idempotency(ns, source, clean["eventId"]), digest)
            except RevisionConflict:
                continue
        raise ApiError(409, "REVISION_CONFLICT", "Hotspot changed concurrently. Retry.", True)

    @staticmethod
    def _replay(previous: dict | None, digest: str) -> tuple[int, dict]:
        if not previous or previous["payloadHash"] != digest:
            raise ApiError(409, "EVENT_ID_REUSED", "This eventId was already used with a different report.")
        return 200, {**previous["result"], "duplicate": True}

    @staticmethod
    def _claims(observations: list[dict], result: dict) -> dict:
        """User CLAIMS attached to the evidence currently in effect. Never measurements."""
        effective = [o for o in observations if o["eventId"] in result["effectiveObservationIds"]
                     and o["kind"] in ("WATER_OBSERVED", "ROAD_BLOCKED_REPORTED")]
        levels = [o["depthClaim"]["level"] for o in effective if (o.get("depthClaim") or {}).get("level")]
        stalled = [o["stalledVehicles"] for o in effective if o.get("stalledVehicles") is not None]
        return {
            "highestDepthClaim": max(levels, key=DEPTH_ORDER.__getitem__) if levels else None,
            "depthClaimCount": len(levels),
            "stalledVehiclesClaimedMax": max(stalled) if stalled else None,
            "basis": "user_claim",
        }

    def _states(self, now: datetime) -> tuple[dict, dict, dict]:
        states, revisions, claims = {}, {}, {}
        for h in self.hotspots:
            stored, observations, result = self._evaluate(h["id"], now)
            states[h["id"]], revisions[h["id"]] = result, (stored or {}).get("revision", 0)
            claims[h["id"]] = self._claims(observations, result)
        return states, revisions, claims

    def _dynamic_pair(self, origin: object, destination: object, states: dict, vehicle: str = "two_wheeler",
                      avoid: list | None = None, lang: str = "en") -> dict:
        """Live routes (Google Routes traffic-aware, else OSRM) for tap-anywhere endpoints near
        the pilot, with the provider's alternatives. If the fastest route crosses a restricted
        hotspot - or a basin where the rider's camera flagged water - request a detour through
        that hotspot's bypass anchor. Every candidate is then validated by route_domain.compare
        like a reviewed fixture: a waypoint alone never proves avoidance."""
        centre = self.hotspots[0]["properties"]["centroid"]
        for point in (origin, destination):
            if (not isinstance(point, list) or len(point) != 2
                    or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in point)
                    or distance_m(centre, point) > PILOT_RADIUS_M):
                raise ApiError(422, "OUTSIDE_PILOT_COVERAGE",
                               f"Pick points within {PILOT_RADIUS_M // 1000} km of the pilot underpass.")
        try:
            found = external.live_routes([origin, destination], vehicle, alternatives=True, lang=lang)
        except external.ProviderError as exc:
            raise ApiError(503, "ROUTE_PROVIDER_UNAVAILABLE", "Live routing is unavailable.", True) from exc

        def cand(cid: str, label: str, r: dict) -> dict:
            return {"id": cid, "label": label, "roadNames": r["roadNames"], "steps": r["steps"],
                    "geometry": {"type": "LineString", "coordinates": r["coordinates"]},
                    "distanceM": r["distanceM"], "durationS": r["durationS"], "source": r.get("source", "osrm-live"),
                    "sourceTime": iso(datetime.now(timezone.utc)), "separatedFrom": []}

        def via(r: dict) -> str:
            named = [st for st in r["steps"] if st["name"]]
            if named:
                return max(named, key=lambda st: st["distanceM"])["name"]
            return next((n for n in r["roadNames"] if n), "main road")

        found.sort(key=lambda r: r["durationS"])
        base = found[0]
        candidates = [cand("LIVE_FASTEST", "Fastest: via " + via(base), base)]
        candidates += [cand(f"LIVE_ALT_{i}", "Alternative: via " + via(r), r) for i, r in enumerate(found[1:], 1)]
        camera_basins = {h["id"] for h in self.hotspots for p in avoid or []
                         if point_in_polygon(p, h["geometry"]["coordinates"][0])}
        for h in self.hotspots:
            if not (states[h["id"]]["restricts"] or h["id"] in camera_basins):
                continue
            if not line_intersects_polygon(base["coordinates"], h["geometry"]["coordinates"][0]):
                continue
            for i, anchor in enumerate(h["properties"].get("bypassAnchors", [])):
                try:
                    alt = external.live_routes([origin, anchor["coordinates"], destination], vehicle, lang=lang)[0]
                except external.ProviderError:
                    continue  # the decision then honestly reports no admissible route
                candidates.append(cand(f"LIVE_BYPASS_{i + 1}", "Bypass via " + anchor["name"], alt))
        return {"id": "LIVE_CUSTOM", "origin": {"name": "Chosen start", "coordinates": origin},
                "destination": {"name": "Chosen destination", "coordinates": destination},
                "candidates": candidates}

    def compare(self, body: object) -> dict:
        if not isinstance(body, dict):
            raise ApiError(400, "INVALID_JSON", "Request body must be a JSON object.")
        self._check_corridor(body.get("corridorId"))
        if self._control().get("simulateRouteProviderFailure"):
            raise ApiError(503, "ROUTE_PROVIDER_UNAVAILABLE", "Route comparison is temporarily unavailable.", True)
        vehicle = body.get("vehicle", "two_wheeler")
        if vehicle not in VEHICLES:
            raise ApiError(422, "UNSUPPORTED_VEHICLE", "vehicle must be one of " + ", ".join(VEHICLES))
        avoid = body.get("avoid") or []
        centre = self.hotspots[0]["properties"]["centroid"]
        if (not isinstance(avoid, list) or len(avoid) > 3 or not all(
                isinstance(p, list) and len(p) == 2
                and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in p)
                and distance_m(centre, p) <= PILOT_RADIUS_M for p in avoid)):
            raise ApiError(422, "INVALID_AVOID", "avoid must be up to 3 [lon, lat] points inside the pilot area.")
        now = self.now()
        states, revisions, claims = self._states(now)
        pair = route_domain.match_pair(self.corridor, body)
        if pair is None:
            if body.get("routePairId") or "origin" not in body:
                raise ApiError(422, "OUTSIDE_PILOT_COVERAGE", "Unknown route pair.")
            lang = "hi" if body.get("lang") == "hi" else "en"
            pair = self._dynamic_pair(body.get("origin"), body.get("destination"), states, vehicle, avoid, lang)
        decision = route_domain.compare(pair, self.hotspots, states, revisions, now,
                                        self.cfg.provenance, self.corridor, avoid)
        decision["vehicle"] = vehicle
        decision["claims"] = claims
        if any(s["restricts"] for s in states.values()):
            # prototype policy: no vehicle is cleared through reported water (brief 7.2)
            decision["explanationCodes"].append("ALL_VEHICLES_AVOID_REPORTED_WATER")
        return decision

    def report_draft(self, body: object, principal: Principal) -> dict:
        self._require_contributor(principal)  # model calls cost money: no anonymous drafts
        if not isinstance(body, dict) or not isinstance(body.get("text"), str) or not body["text"].strip():
            raise ApiError(422, "TEXT_REQUIRED", "Send a JSON body with a non-empty text field.")
        if len(body["text"]) > 1000:
            raise ApiError(422, "TEXT_TOO_LONG", "Up to 1000 characters.")
        result = bedrock.extract(body["text"])
        result["inPilot"] = result["location_matched"] in self.hotspot_ids
        return result

    def geocode(self, q: str | None, near: str | None = None) -> dict:
        """Place lookup inside the coverage area: Photon (typo-tolerant, ranked near the user),
        Nominatim when Photon is down or finds nothing."""
        if not isinstance(q, str) or not 2 <= len(q.strip()) <= 100:
            raise ApiError(422, "QUERY_REQUIRED", "Search for 2-100 characters.")
        centre = self.hotspots[0]["properties"]["centroid"]
        bias = centre
        try:
            lon, lat = (float(v) for v in (near or "").split(","))
            if distance_m(centre, [lon, lat]) <= PILOT_RADIUS_M:
                bias = [lon, lat]
        except ValueError:
            pass
        found: list[dict] = []
        try:
            found = external.photon(q.strip(), bias, DELHI_BBOX)
        except external.ProviderError:
            pass
        try:
            found = found or external.nominatim(q.strip(), centre, half_deg=PILOT_RADIUS_M / 100_000)
        except external.ProviderError:
            raise ApiError(503, "GEOCODER_UNAVAILABLE", "Place search is unavailable. Pick on the map instead.", True) from None
        results: list[dict] = []
        for r in found:
            if distance_m(centre, r["coordinates"]) > PILOT_RADIUS_M:
                continue
            # OSM often has several objects for one place: same name within 50 m is one result
            if any(x["name"] == r["name"] and distance_m(x["coordinates"], r["coordinates"]) < 50 for x in results):
                continue
            results.append(r)
        return {"results": results[:5], "attribution": "© OpenStreetMap contributors (Nominatim)"}

    def weather(self) -> dict:
        lon, lat = self.hotspots[0]["properties"]["centroid"]
        simulated = self._control().get("simulateRainMmPerHour")
        if simulated is not None:
            w = {"provider": "SIMULATED (demo control)", "kind": "SYNTHETIC_DEMO", "location": [lon, lat],
                 "currentPrecipitationMm": round(simulated / 4, 2), "currentIntervalS": 900,
                 "currentTime": iso(self.now()), "next3hPrecipitationMm": [simulated] * 3, "units": "mm"}
        else:
            try:
                w = external.open_meteo(lat, lon)
            except external.ProviderError:
                return {"available": False, "message": "Weather context unavailable."}
        per_hour_now = w["currentPrecipitationMm"] * 3600 / (w["currentIntervalS"] or 3600)
        heavy = max(w["next3hPrecipitationMm"] + [per_hour_now])
        return {"available": True, **w, "advisory": heavy >= RAIN_ADVISORY_MM_PER_H,
                "advisoryThresholdMmPerH": RAIN_ADVISORY_MM_PER_H,
                "note": "Model rainfall is context only. It never confirms or clears waterlogging."}

    def review(self, body: object, principal: Principal) -> dict:
        reviewer = self._require_reviewer(principal)
        if not isinstance(body, dict) or set(body) - {"hotspotId", "action", "citedObservationIds",
                                                      "reason", "inspectedRevision"}:
            raise ApiError(422, "INVALID_REVIEW", "Unsupported review fields.")
        hid = body.get("hotspotId")
        if hid not in self.hotspot_ids:
            raise ApiError(422, "UNKNOWN_HOTSPOT", "hotspotId is not in the pilot catalog.")
        if body.get("action") != "CLEAR":
            raise ApiError(422, "UNSUPPORTED_ACTION", "Only CLEAR reviews exist in P0.")
        reason = body.get("reason")
        cited = body.get("citedObservationIds")
        if not isinstance(reason, str) or not 3 <= len(reason) <= 500:
            raise ApiError(422, "REASON_REQUIRED", "Give a reason (3-500 characters).")
        if not isinstance(cited, list) or not all(isinstance(c, str) for c in cited) or len(cited) > 20:
            raise ApiError(422, "INVALID_CITATIONS", "citedObservationIds must be a list of event IDs.")

        now = self.now()
        stored, observations, _ = self._evaluate(hid, now)
        revision = (stored or {}).get("revision", 0)
        if body.get("inspectedRevision") != revision:
            raise ApiError(409, "STALE_REVISION", "New evidence arrived since you inspected it. Re-check.")
        error = check_clear_review(cited, observations, now, self.policy,
                                   (stored or {}).get("lastKnownPositiveAt"))
        if error:
            raise ApiError(422, error, "The cited evidence does not support a clear decision.")

        review = {"reviewId": str(uuid.uuid4()), "reviewedAt": iso(now), "action": "CLEAR",
                  "citedObservationIds": cited, "reason": reason, "reviewer": reviewer,
                  "inspectedRevision": revision}
        result = evaluate(observations, now, self.policy, (stored or {}).get("lastKnownPositiveAt"), review)
        new_state = {"revision": revision + 1, "lastKnownPositiveAt": result["lastKnownPositiveAt"],
                     "clearReview": review, "lastEvaluation": result, "updatedAt": iso(now)}
        try:
            self.store.commit(self.cfg.namespace, hid, revision, new_state, review=review)
        except RevisionConflict:
            raise ApiError(409, "STALE_REVISION", "New evidence arrived while saving. Re-check.") from None
        return {"hotspotId": hid, "revision": revision + 1, **result}

    def demo_control(self, body: object, principal: Principal) -> dict:
        if not self.cfg.is_demo:
            raise ApiError(404, "NOT_FOUND", "No such route.")
        if principal.kind != "demo-admin":
            raise ApiError(401, "AUTH_REQUIRED", "Demo control needs the demo admin key.")
        if not isinstance(body, dict):
            raise ApiError(400, "INVALID_JSON", "Request body must be a JSON object.")
        ns = self.cfg.namespace
        if body.get("reset"):
            self.store.reset(ns)
        control = self.store.get_control(ns)
        if "clockOffsetMinutes" in body:
            offset = body["clockOffsetMinutes"]
            if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 24 * 60:
                raise ApiError(422, "INVALID_OFFSET", "clockOffsetMinutes must be 0..1440.")
            control["clockOffsetMinutes"] = offset
        if "simulateRouteProviderFailure" in body:
            control["simulateRouteProviderFailure"] = bool(body["simulateRouteProviderFailure"])
        if "simulateRainMmPerHour" in body:
            rain = body["simulateRainMmPerHour"]
            if rain is not None and (not isinstance(rain, (int, float)) or isinstance(rain, bool) or not 0 <= rain <= 200):
                raise ApiError(422, "INVALID_RAIN", "simulateRainMmPerHour must be 0..200 or null.")
            control["simulateRainMmPerHour"] = rain
        self.store.set_control(ns, control)
        return self.status()

    # ------------------------------------------------- principal helpers
    def principal_from(self, headers: dict, jwt_claims: dict | None) -> Principal:
        """Map transport credentials to a Principal. Header names are lowercase."""
        if self.cfg.is_demo:
            key = headers.get("x-demo-admin-key", "")
            if key and self.cfg.demo_admin_key and hmac.compare_digest(key, self.cfg.demo_admin_key):
                return Principal("demo-admin", "demo-reviewer")
            contributor = headers.get("x-demo-contributor", "")
            if DEMO_CONTRIBUTOR_RE.match(contributor):
                return Principal("demo", contributor)
            return Principal()
        if jwt_claims and jwt_claims.get("sub"):
            groups = jwt_claims.get("cognito:groups") or []
            if isinstance(groups, str):  # API Gateway flattens arrays to "[a b]"
                groups = groups.strip("[]").split()
            return Principal("jwt", jwt_claims["sub"], list(groups))
        return Principal()
