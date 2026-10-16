"""Self-check for the aggregation logic. Run: `python server/test_server.py`

Clustering and scoring are the only non-obvious code on the backend, and both
are easy to break silently - a bad radius merges half a city into one marker, a
bad score makes single unverified sightings look authoritative.
"""
import os
import sys
import tempfile
from pathlib import Path

os.environ["MARGSETU_DB"] = str(Path(tempfile.mkdtemp()) / "test.db")
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

client = TestClient(main.app)

BENGALURU = (12.9716, 77.5946)


def post(*reports):
    body = {"reports": [
        {"lat": lat, "lon": lon, "type": kind, "confidence": conf}
        for lat, lon, kind, conf in reports
    ]}
    res = client.post("/api/hazards", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def nearby(radius=1000, min_score=0.0):
    res = client.get("/api/hazards", params={
        "lat": BENGALURU[0], "lon": BENGALURU[1], "radius": radius, "min_score": min_score,
    })
    assert res.status_code == 200, res.text
    return res.json()["hazards"]


lat, lon = BENGALURU

# --- clustering ----------------------------------------------------------
assert post((lat, lon, "pothole", 0.8))["created"] == 1

# ~11 m away: the same pothole seen again, not a new one
assert post((lat + 0.0001, lon, "pothole", 0.9))["merged"] == 1
assert len(nearby()) == 1, "nearby sightings must collapse into one hazard"

# ~110 m away: genuinely a different pothole
assert post((lat + 0.001, lon, "pothole", 0.8))["created"] == 1
assert len(nearby()) == 2, "distant sightings must stay separate"

# same spot, different hazard type: also separate
assert post((lat, lon, "speed_breaker", 0.8))["created"] == 1
assert len(nearby()) == 3, "hazard types are clustered independently"

# --- scoring -------------------------------------------------------------
first = next(h for h in nearby() if h["reports"] == 2)
lonely = next(h for h in nearby() if h["type"] == "speed_breaker")
assert first["score"] > lonely["score"], "corroborated hazards outrank single sightings"
assert lonely["score"] < 0.7, "a single unverified sighting is not authoritative"

for _ in range(8):
    post((lat, lon, "speed_breaker", 0.9))
confirmed = next(h for h in nearby() if h["type"] == "speed_breaker")
assert confirmed["score"] >= 0.7, "many independent sightings should become confirmed"
assert confirmed["score"] <= 1.0, "score must stay a probability"

# a year-old marker fades even with plenty of reports
stale = main.consensus_score(20, 0.95, int((__import__("time").time() - 365 * 86400) * 1000))
assert stale < 0.15, f"stale hazards must decay, got {stale}"

# --- filtering -----------------------------------------------------------
assert nearby(radius=5, min_score=0.0) != nearby(radius=1000), "radius must actually filter"
assert all(h["score"] >= 0.6 for h in nearby(min_score=0.6)), "min_score must actually filter"

stats = client.get("/api/stats").json()
assert stats["hazards"] == 3 and stats["reports"] == 12, stats

print("test_server.py: all assertions passed")
