"""Observation request validation (schema 1.0). Strict: unknown fields are rejected,
so a browser cannot smuggle in `verified`, `official`, `confidence` and the like."""
from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timedelta

from domain.policy import KINDS, Policy, iso, parse_iso

MAX_TEXT = 1_000
MAX_BODY_BYTES = 8 * 1024
MAX_AGE = timedelta(days=7)
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DEPTH_UNITS = {"cm": 1.0, "m": 100.0, "in": 2.54, "ft": 30.48}

ALLOWED = {"schemaVersion", "eventId", "hotspotId", "kind", "observedAt", "location",
           "description", "depthClaim", "stalledVehicles", "clientMode"}
DEPTH_LEVELS = ("ankle", "knee", "waist", "submerged")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.status, self.code, self.message, self.retryable = status, code, message, retryable


def _bad(code: str, message: str) -> ApiError:
    return ApiError(422, code, message)


def _finite(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate_observation(body: object, hotspot_ids: set[str], now: datetime, client_mode: str,
                         policy: Policy = Policy()) -> dict:
    """Return the canonical client payload, or raise ApiError."""
    if not isinstance(body, dict):
        raise ApiError(400, "INVALID_JSON", "Request body must be a JSON object.")
    extra = set(body) - ALLOWED
    if extra:
        raise _bad("UNKNOWN_FIELDS", "Unsupported fields: " + ", ".join(sorted(extra)))
    if body.get("schemaVersion") != "1.0":
        raise _bad("UNSUPPORTED_SCHEMA", "schemaVersion must be \"1.0\".")
    if not isinstance(body.get("eventId"), str) or not UUID_RE.match(body["eventId"]):
        raise _bad("INVALID_EVENT_ID", "eventId must be a lowercase UUID.")
    if body.get("hotspotId") not in hotspot_ids:
        raise _bad("UNKNOWN_HOTSPOT", "hotspotId is not in the pilot catalog.")
    if body.get("kind") not in KINDS:
        raise _bad("UNSUPPORTED_KIND", "kind must be one of " + ", ".join(sorted(KINDS)) + ".")
    if body.get("clientMode") != client_mode:
        raise ApiError(409, "MODE_MISMATCH", f"This server accepts {client_mode} reports only.")

    try:
        observed = parse_iso(body["observedAt"]) if isinstance(body.get("observedAt"), str) else None
    except ValueError:
        observed = None
    if observed is None:
        raise _bad("INVALID_TIME", "observedAt must be an ISO 8601 UTC timestamp.")
    if observed > now + policy.future_tolerance:
        raise _bad("TIME_IN_FUTURE", "observedAt is later than the server clock allows.")
    if observed < now - MAX_AGE:
        raise _bad("TIME_TOO_OLD", "observedAt is too old to accept.")

    location = body.get("location") or {"source": "selected_hotspot", "accuracyM": None}
    if not isinstance(location, dict) or location.get("source") not in ("selected_hotspot", "gps"):
        raise _bad("INVALID_LOCATION", "location.source must be selected_hotspot or gps.")
    if set(location) - {"source", "accuracyM", "lat", "lon", "fixAt"}:
        raise _bad("INVALID_LOCATION", "Unsupported location fields.")
    acc = location.get("accuracyM")
    if acc is not None and (not _finite(acc) or acc < 0):
        raise _bad("INVALID_LOCATION", "accuracyM must be a non-negative number or null.")
    if location["source"] == "gps":
        lat, lon = location.get("lat"), location.get("lon")
        if not (_finite(lat) and _finite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
            raise _bad("INVALID_LOCATION", "gps location needs finite lat/lon.")

    description = body.get("description")
    if description is not None and (not isinstance(description, str) or len(description) > MAX_TEXT):
        raise _bad("INVALID_DESCRIPTION", f"description must be text up to {MAX_TEXT} characters.")

    depth = body.get("depthClaim")
    if depth is not None:
        # either a quoted number ("3 foot") or a qualitative level ("ghutne tak" -> knee)
        numeric = isinstance(depth, dict) and depth.get("value") is not None
        if (
            not isinstance(depth, dict) or set(depth) - {"value", "unit", "level", "sourcePhrase"}
            or not isinstance(depth.get("sourcePhrase"), str) or len(depth["sourcePhrase"]) > 200
            or (numeric and (depth.get("unit") not in DEPTH_UNITS or not _finite(depth["value"])
                             or not 0 < depth["value"] <= 1000))
            or (not numeric and depth.get("level") not in DEPTH_LEVELS)
        ):
            raise _bad("INVALID_DEPTH_CLAIM", "depthClaim needs sourcePhrase and either value+unit or a level.")
        if numeric:
            cm = round(depth["value"] * DEPTH_UNITS[depth["unit"]], 1)
            level = "ankle" if cm < 15 else "knee" if cm < 30 else "waist" if cm <= 45 else "submerged"
            depth = {"value": depth["value"], "unit": depth["unit"], "sourcePhrase": depth["sourcePhrase"],
                     "normalizedCm": cm, "level": level, "basis": "user_claim"}
        else:
            depth = {"level": depth["level"], "sourcePhrase": depth["sourcePhrase"], "basis": "user_claim"}

    stalled = body.get("stalledVehicles")
    if stalled is not None and (not isinstance(stalled, int) or isinstance(stalled, bool) or not 0 <= stalled <= 50):
        raise _bad("INVALID_STALLED_COUNT", "stalledVehicles must be a whole number 0-50.")

    return {
        "schemaVersion": "1.0",
        "eventId": body["eventId"],
        "hotspotId": body["hotspotId"],
        "kind": body["kind"],
        "observedAt": iso(observed),
        "location": location,
        "description": description,
        "depthClaim": depth,
        "stalledVehicles": stalled,
        "clientMode": client_mode,
    }


def payload_hash(canonical: dict) -> str:
    return hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()
