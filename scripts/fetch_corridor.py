"""Fetch the pilot corridor's candidate route geometry and write the fixtures.

    python scripts/fetch_corridor.py

Retrieves two road-following candidates from the public OSRM demo server
(OpenStreetMap data, ODbL) for one origin/destination pair:

  A  baseline   Jawaharlal Nehru Marg -> Vivekanand Marg (Minto Bridge underpass) -> Connaught Place
  B  detour     Jawaharlal Nehru Marg -> Maharaja Ranjeet Singh Marg -> Shivaji Flyover -> Barakhamba Road -> CP

and builds the Minto Bridge underpass hazard corridor as a 15 m buffer around
the part of candidate A that lies within 70 m of the OSM "Minto Bridge"
railway-bridge centroid.

The output is *candidate* geometry: retrieved by a script, not yet reviewed by
a person on a map or in the field. The files say so, and the app shows it.
Run once; the fixtures are committed so the demo never depends on OSRM.
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend" / "src"))
from providers.external import OSRM, osrm_route  # noqa: E402
OUT_ROUTES = ROOT / "backend" / "src" / "data" / "routes" / "minto-corridor.json"
OUT_HOTSPOTS = ROOT / "backend" / "src" / "data" / "hotspots.geojson"


ORIGIN = (77.2275, 28.6420)        # lon, lat - JLN Marg near Ajmeri Gate
DESTINATION = (77.2190, 28.6315)   # lon, lat - Connaught Place, Outer Circle (west)
DETOUR_VIA = (77.2300, 28.6330)    # lon, lat - forces Shivaji Flyover / Barakhamba Road
# OSM way 596346053 "Minto Bridge" (man_made=bridge, the railway bridge over Vivekanand Marg)
MINTO = (77.2223103, 28.6365576)
CORRIDOR_RADIUS_M = 70
BUFFER_M = 15


def fetch(coords: list[tuple[float, float]]) -> dict:
    route = osrm_route([list(c) for c in coords], timeout=20)
    path = ";".join(f"{lon},{lat}" for lon, lat in coords)
    return {**route, "requestUrl": f"{OSRM}/{path}?overview=full&geometries=geojson&steps=true"}


def to_xy(lon: float, lat: float) -> tuple[float, float]:
    """Local equirectangular metres around the Minto centroid; fine at this scale."""
    k = 111_320.0
    return (lon - MINTO[0]) * k * math.cos(math.radians(MINTO[1])), (lat - MINTO[1]) * k


def to_lonlat(x: float, y: float) -> list[float]:
    k = 111_320.0
    return [round(MINTO[0] + x / (k * math.cos(math.radians(MINTO[1]))), 6), round(MINTO[1] + y / k, 6)]


def buffer_polygon(line: list[tuple[float, float]], width: float) -> list[list[float]]:
    """Flat-ended buffer of a short, gently curving polyline (left side out, right side back)."""
    left, right = [], []
    for i, (x, y) in enumerate(line):
        ax, ay = line[max(0, i - 1)]
        bx, by = line[min(len(line) - 1, i + 1)]
        dx, dy = bx - ax, by - ay
        n = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / n * width, dx / n * width
        # extend the two ends along the road so the cap is not flush with a vertex
        ex, ey = (dx / n * width, dy / n * width)
        if i == 0:
            x, y = x - ex, y - ey
        elif i == len(line) - 1:
            x, y = x + ex, y + ey
        left.append(to_lonlat(x + nx, y + ny))
        right.append(to_lonlat(x - nx, y - ny))
    ring = left + right[::-1]
    return ring + [ring[0]]


def main() -> None:
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    a = fetch([ORIGIN, DESTINATION])
    b = fetch([ORIGIN, DETOUR_VIA, DESTINATION])

    # OSRM leaves straight road with few vertices, so densify to 5 m before clipping
    dense: list[tuple[float, float]] = []
    pts = [to_xy(*c) for c in a["coordinates"]]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        n = max(1, int(math.hypot(x2 - x1, y2 - y1) // 5))
        dense += [(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n) for i in range(n)]
    near = [p for p in dense if math.hypot(*p) <= CORRIDOR_RADIUS_M]
    if len(near) < 2:
        raise SystemExit("baseline does not pass the Minto Bridge underpass any more - review manually")
    polygon = buffer_polygon(near, BUFFER_M)

    source = "OpenStreetMap data (c) OpenStreetMap contributors, ODbL 1.0, via the public OSRM demo server"
    candidate = lambda rid, label, r: {  # noqa: E731
        "id": rid,
        "label": label,
        "roadNames": r["roadNames"],
        "geometry": {"type": "LineString", "coordinates": r["coordinates"]},
        "steps": r["steps"],
        "distanceM": r["distanceM"],
        "durationS": r["durationS"],
        "source": "osrm-demo-driving",
        "sourceTime": now,
        "requestUrl": r["requestUrl"],
        "separatedFrom": [],
    }
    routes = {
        "corridorId": "MINTO_CP",
        "displayName": "Ajmeri Gate (JLN Marg) to Connaught Place",
        "geometryVersion": "minto-cp-2026-10-08",
        "provider": source,
        "profile": "OSRM 'driving' (car) profile - the public server has no two-wheeler profile",
        "retrievedAt": now,
        "verification": "candidate",
        "reviewNotes": "Retrieved by scripts/fetch_corridor.py. NOT yet reviewed by a person on a map or in the field.",
        "redistribution": "ODbL 1.0 - attribute OpenStreetMap contributors; derived database terms apply",
        "pairs": [{
            "id": "AJMERI_GATE_TO_CP",
            "origin": {"name": "JLN Marg, near Ajmeri Gate", "coordinates": list(ORIGIN)},
            "destination": {"name": "Connaught Place (Outer Circle)", "coordinates": list(DESTINATION)},
            "candidates": [
                candidate("A_VIA_MINTO", "Via Minto Road underpass", a),
                candidate("B_VIA_SHIVAJI_FLYOVER", "Via Shivaji Flyover and Barakhamba Road", b),
            ],
        }],
    }
    hotspots = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "id": "MINTO_BRIDGE",
            "geometry": {"type": "Polygon", "coordinates": [polygon]},
            "properties": {
                "id": "MINTO_BRIDGE",
                "displayName": "Minto Bridge underpass",
                "displayNameHi": "मिंटो ब्रिज अंडरपास",
                "aliases": ["Minto", "Minto Bridge", "Minto Road", "मिंटो", "मिंटो ब्रिज", "Vivekanand Marg underpass"],
                "corridorId": "MINTO_CP",
                "centroid": list(MINTO),
                "roadLevel": "underpass",
                "direction": "both",
                "geometryVersion": routes["geometryVersion"],
                "geometrySource": f"{CORRIDOR_RADIUS_M} m of the OSRM baseline around OSM way 596346053, buffered {BUFFER_M} m. {source}",
                "sourceAccessedAt": now,
                "reviewedAt": None,
                "reviewNotes": "Candidate. Historical waterlogging site named in the original brief; not surveyed.",
                "verification": "candidate",
                "enabledForRouting": True,
                # a dynamic route that crosses this hotspot is re-requested through this point,
                # and the detour is then validated like any other candidate
                "bypassAnchors": [{"name": "Shivaji Flyover / Barakhamba Road", "coordinates": list(DETOUR_VIA)}],
            },
        }],
    }

    OUT_ROUTES.parent.mkdir(parents=True, exist_ok=True)
    OUT_ROUTES.write_text(json.dumps(routes, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    OUT_HOTSPOTS.write_text(json.dumps(hotspots, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for c in routes["pairs"][0]["candidates"]:
        print(f"{c['id']}: {c['distanceM']} m, {c['durationS']} s, {len(c['geometry']['coordinates'])} pts, {c['roadNames']}")
    print(f"wrote {OUT_ROUTES.relative_to(ROOT)} and {OUT_HOTSPOTS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
