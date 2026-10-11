"""Server-side adapters for the public OSRM router and Open-Meteo. stdlib only.

Both are bounded (timeouts) and raise ProviderError on any failure, so the
service can return an explicit unavailable state - never a silent mock.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request

OSRM = "https://router.project-osrm.org/route/v1/driving"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
UA = "DilliJalNav-Edge/0.3 (hackathon prototype)"


class ProviderError(Exception):
    pass


def _get(url: str, timeout: float) -> dict:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout) as r:
            return json.load(r)
    except Exception as exc:
        raise ProviderError(f"{type(exc).__name__}: {exc}") from exc


def instruction(step: dict) -> str:
    m = step.get("maneuver", {})
    kind, mod, name = m.get("type", ""), m.get("modifier", ""), step.get("name") or "the road"
    if kind == "depart":
        return f"Start on {name}"
    if kind == "arrive":
        return "Arrive at destination"
    if kind in ("roundabout", "rotary"):
        exit_ = m.get("exit")
        return f"At the roundabout take exit {exit_} onto {name}" if exit_ else f"Enter the roundabout onto {name}"
    if kind in ("merge", "on ramp", "off ramp", "fork"):
        return f"{kind.capitalize()} {mod} onto {name}".replace("  ", " ")
    if mod in ("straight", ""):
        return f"Continue on {name}"
    return f"{'Turn' if kind in ('turn', 'end of road') else 'Keep'} {mod} onto {name}"


def steps_from(route: dict) -> list[dict]:
    steps = []
    for leg in route["legs"]:
        for s in leg["steps"]:
            lanes = None
            for inter in s.get("intersections", [])[:1]:
                if inter.get("lanes"):
                    lanes = [{"indications": l.get("indications", []), "valid": bool(l.get("valid"))}
                             for l in inter["lanes"]]
            steps.append({
                "instruction": instruction(s),
                "name": s.get("name", ""),
                "type": s["maneuver"].get("type"),
                "modifier": s["maneuver"].get("modifier"),
                "location": [round(v, 6) for v in s["maneuver"]["location"]],
                "distanceM": round(s["distance"], 1),
                "durationS": round(s["duration"], 1),
                "lanes": lanes,
            })
    return steps


def osrm_route(points: list[list[float]], timeout: float = 4.0) -> dict:
    path = ";".join(f"{lon:.6f},{lat:.6f}" for lon, lat in points)
    data = _get(f"{OSRM}/{path}?overview=full&geometries=geojson&steps=true", timeout)
    if data.get("code") != "Ok" or not data.get("routes"):
        raise ProviderError(f"OSRM: {data.get('code')}")
    r = data["routes"][0]
    names: list[str] = []
    for leg in r["legs"]:
        for s in leg["steps"]:
            if s["name"] and (not names or names[-1] != s["name"]):
                names.append(s["name"])
    return {
        "coordinates": [[round(lon, 6), round(lat, 6)] for lon, lat in r["geometry"]["coordinates"]],
        "distanceM": round(r["distance"], 1),
        "durationS": round(r["duration"], 1),
        "roadNames": names,
        "steps": steps_from(r),
    }


_weather_cache: dict[str, tuple[float, dict]] = {}


def open_meteo(lat: float, lon: float, ttl_s: int = 600, timeout: float = 3.0) -> dict:
    """Model precipitation near a point. Cached; one call per cell per 10 min."""
    key = f"{lat:.2f},{lon:.2f}"
    hit = _weather_cache.get(key)
    if hit and time.time() - hit[0] < ttl_s:
        return hit[1]
    q = urllib.parse.urlencode({"latitude": lat, "longitude": lon, "current": "precipitation",
                                "hourly": "precipitation", "forecast_hours": 3, "timezone": "UTC"})
    data = _get(f"{OPEN_METEO}?{q}", timeout)
    try:
        current = data["current"]
        result = {
            "provider": "open-meteo",
            "kind": "MODEL_FORECAST",
            "location": [lon, lat],
            "currentPrecipitationMm": current["precipitation"],
            "currentIntervalS": current.get("interval"),
            "currentTime": current["time"] + "Z",
            "next3hPrecipitationMm": [round(v or 0, 2) for v in data["hourly"]["precipitation"][:3]],
            "units": data.get("current_units", {}).get("precipitation", "mm"),
        }
    except (KeyError, TypeError) as exc:
        raise ProviderError(f"unexpected Open-Meteo response: {exc}") from exc
    _weather_cache[key] = (time.time(), result)
    return result


NOMINATIM = "https://nominatim.openstreetmap.org/search"
_geo_cache: dict[str, tuple[float, list[dict]]] = {}
_geo_last = [0.0]
_geo_lock = __import__("threading").Lock()


def nominatim(q: str, centre: list[float], half_deg: float = 0.075, timeout: float = 4.0) -> list[dict]:
    """Place search bounded to the pilot area. Follows the Nominatim usage policy:
    identified User-Agent, at most 1 request/second from this process, results
    cached for a day, search-on-submit only (the client never autocompletes)."""
    key = q.strip().lower()
    hit = _geo_cache.get(key)
    if hit and time.time() - hit[0] < 86_400:
        return hit[1]
    lon, lat = centre
    params = urllib.parse.urlencode({
        "q": q, "format": "jsonv2", "limit": 6, "countrycodes": "in", "bounded": 1,
        "viewbox": f"{lon - half_deg},{lat + half_deg},{lon + half_deg},{lat - half_deg}",
    })
    with _geo_lock:  # ponytail: per-process limiter; one shared limiter (e.g. DynamoDB) if Lambda scales out
        wait = 1.1 - (time.time() - _geo_last[0])
        if wait > 0:
            time.sleep(wait)
        _geo_last[0] = time.time()
        data = _get(f"{NOMINATIM}?{params}", timeout)
    if not isinstance(data, list):
        raise ProviderError("unexpected Nominatim response")
    results = []
    for r in data:
        try:
            name, _, rest = r["display_name"].partition(",")
            results.append({"name": name.strip(), "address": rest.strip()[:120],
                            "coordinates": [round(float(r["lon"]), 6), round(float(r["lat"]), 6)]})
        except (KeyError, ValueError):
            continue
    _geo_cache[key] = (time.time(), results)
    return results


# ---------------------------------------------------------------- Google Routes API
GOOGLE_ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes"
GOOGLE_FIELDS = ",".join([
    "routes.distanceMeters", "routes.duration", "routes.polyline.encodedPolyline", "routes.description",
    "routes.legs.steps.distanceMeters", "routes.legs.steps.staticDuration", "routes.legs.steps.startLocation",
    "routes.legs.steps.navigationInstruction",
])
#: Google maneuver -> the OSRM-style (type, modifier) the app's arrows and cue sheet use.
MANEUVER = {
    "DEPART": ("depart", ""), "STRAIGHT": ("continue", "straight"), "NAME_CHANGE": ("new name", "straight"),
    "TURN_LEFT": ("turn", "left"), "TURN_RIGHT": ("turn", "right"),
    "TURN_SLIGHT_LEFT": ("turn", "slight left"), "TURN_SLIGHT_RIGHT": ("turn", "slight right"),
    "TURN_SHARP_LEFT": ("turn", "sharp left"), "TURN_SHARP_RIGHT": ("turn", "sharp right"),
    "UTURN_LEFT": ("turn", "uturn"), "UTURN_RIGHT": ("turn", "uturn"),
    "RAMP_LEFT": ("on ramp", "left"), "RAMP_RIGHT": ("on ramp", "right"), "MERGE": ("merge", "straight"),
    "FORK_LEFT": ("fork", "left"), "FORK_RIGHT": ("fork", "right"),
    "ROUNDABOUT_LEFT": ("roundabout", "left"), "ROUNDABOUT_RIGHT": ("roundabout", "right"),
    "ROUNDABOUT_CLOCKWISE": ("roundabout", "right"), "ROUNDABOUT_COUNTERCLOCKWISE": ("roundabout", "left"),
}
#: Routes API has two-wheeler routing for India; everything else drives.
TRAVEL_MODE = {"two_wheeler": "TWO_WHEELER"}


def decode_polyline(encoded: str) -> list[list[float]]:
    """Google encoded polyline -> [[lon, lat], ...]."""
    coords, index, lat, lon = [], 0, 0, 0
    while index < len(encoded):
        for axis in (0, 1):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if axis == 0:
                lat += delta
            else:
                lon += delta
        coords.append([round(lon / 1e5, 6), round(lat / 1e5, 6)])
    return coords


def _road(text: str) -> str:
    """Road name from an instruction like 'Turn left onto Minto Rd'."""
    for marker in (" onto ", " on ", " toward "):
        if marker in text:
            return text.split(marker, 1)[1].strip()
    return ""


def _seconds(value: str | None) -> float:
    return float((value or "0s").rstrip("s") or 0)


def google_routes(points: list[list[float]], vehicle: str, key: str, alternatives: bool = False,
                  timeout: float = 5.0, lang: str = "en") -> list[dict]:
    """Traffic-aware routes from the Google Routes API, in the same shape as osrm_route.
    Intermediate points are pass-through (via) waypoints, as for the bypass anchors."""
    ll = lambda p: {"location": {"latLng": {"latitude": p[1], "longitude": p[0]}}}  # noqa: E731
    body = {
        "origin": ll(points[0]), "destination": ll(points[-1]),
        "intermediates": [{**ll(p), "via": True} for p in points[1:-1]],
        "travelMode": TRAVEL_MODE.get(vehicle, "DRIVE"),
        "routingPreference": "TRAFFIC_AWARE",
        "computeAlternativeRoutes": alternatives and len(points) == 2,
        "languageCode": "hi" if lang == "hi" else "en-IN", "units": "METRIC",
    }
    req = urllib.request.Request(GOOGLE_ROUTES, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": GOOGLE_FIELDS, "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.load(r)
    except Exception as exc:
        raise ProviderError(f"Google Routes: {type(exc).__name__}: {exc}") from exc
    out = []
    for r in data.get("routes", []):
        try:
            coords = decode_polyline(r["polyline"]["encodedPolyline"])
            steps, names = [], []
            for leg in r.get("legs", []):
                for s in leg.get("steps", []):
                    nav = s.get("navigationInstruction", {})
                    text = (nav.get("instructions") or "Continue").split("\n")[0]
                    kind, mod = MANEUVER.get(nav.get("maneuver", ""), ("continue", "straight"))
                    name = _road(text)
                    if name and (not names or names[-1] != name):
                        names.append(name)
                    loc = s["startLocation"]["latLng"]
                    steps.append({"instruction": text, "name": name, "type": kind, "modifier": mod,
                                  "location": [round(loc["longitude"], 6), round(loc["latitude"], 6)],
                                  "distanceM": float(s.get("distanceMeters", 0)),
                                  "durationS": _seconds(s.get("staticDuration")), "lanes": None})
            steps.append({"instruction": "Arrive at destination", "name": "", "type": "arrive", "modifier": "",
                          "location": coords[-1], "distanceM": 0.0, "durationS": 0.0, "lanes": None})
            out.append({"coordinates": coords, "distanceM": float(r["distanceMeters"]),
                        "durationS": _seconds(r["duration"]), "roadNames": names or [r.get("description", "")],
                        "steps": steps, "source": "google-routes-live"})
        except (KeyError, TypeError, ValueError, IndexError):
            continue
    if not out:
        raise ProviderError(f"Google Routes: no route ({str(data)[:120]})")
    return out


def live_routes(points: list[list[float]], vehicle: str, alternatives: bool = False, lang: str = "en") -> list[dict]:
    """Google Routes (traffic-aware, two-wheeler mode) when GOOGLE_MAPS_API_KEY is set,
    falling back to public OSRM on any Google failure. Raises ProviderError if both fail."""
    import os
    key = os.environ.get("GOOGLE_MAPS_API_KEY", "")
    if key:
        try:
            return google_routes(points, vehicle, key, alternatives, lang=lang)
        except ProviderError:
            pass  # fall through to OSRM: a route without traffic beats no route
    return [{**osrm_route(points), "source": "osrm-live"}]
