"""DilliJalNav Edge legacy backend: the original crowdsourced pothole map.

Phones send hazard *metadata* only - coordinates, type, confidence. No video, no
account, no identifier. Independent sightings of the same hazard are merged into
one cluster whose confidence grows with corroboration and decays with age.
"""
from __future__ import annotations

import math
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("DILLIJALNAV_DB") or os.environ.get("PATHFINDER_DB") or ROOT / "hazards.db")
APP_DIST = ROOT.parent / "app" / "dist"

#: Two sightings of the same hazard type within this radius are the same hazard.
CLUSTER_RADIUS_M = 25.0
#: A hazard nobody has re-reported for this long is probably repaired.
HALF_LIFE_DAYS = 45.0

EARTH_R = 6_371_000.0


class Report(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    type: str = Field(min_length=1, max_length=40)
    confidence: float = Field(ge=0, le=1)
    at: int | None = None


class ReportBatch(BaseModel):
    reports: list[Report] = Field(max_length=200)


def haversine_m(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    d_lat = math.radians(b_lat - a_lat)
    d_lon = math.radians(b_lon - a_lon)
    h = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(a_lat)) * math.cos(math.radians(b_lat)) * math.sin(d_lon / 2) ** 2
    )
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(h)))


def consensus_score(reports: int, mean_confidence: float, last_seen_ms: int) -> float:
    """How much should a rider trust this marker?

    One sighting from one phone is a rumour; several independent sightings at the
    same spot are a fact. Corroboration saturates quickly - the difference
    between 6 and 60 reports does not matter to the rider - and old markers fade
    so repaired roads stop generating warnings.
    """
    corroboration = 1 - 0.55**reports
    age_days = max(0.0, (time.time() * 1000 - last_seen_ms) / 86_400_000)
    freshness = 0.5 ** (age_days / HALF_LIFE_DAYS)
    return round(min(1.0, mean_confidence * corroboration * 1.25) * freshness, 4)


SCHEMA = """
CREATE TABLE IF NOT EXISTS hazards (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    lat          REAL NOT NULL,
    lon          REAL NOT NULL,
    type         TEXT NOT NULL,
    reports      INTEGER NOT NULL DEFAULT 1,
    confidence   REAL NOT NULL,
    first_seen   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hazards_bbox ON hazards (lat, lon);
"""


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


with db() as conn:
    conn.executescript(SCHEMA)

app = FastAPI(title="DilliJalNav Edge (legacy pothole API)", version="0.1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


def bbox(lat: float, lon: float, radius_m: float) -> tuple[float, float, float, float]:
    """Degree-space bounding box, used to narrow the rows before exact distance."""
    d_lat = radius_m / 111_320
    d_lon = radius_m / (111_320 * max(0.05, math.cos(math.radians(lat))))
    return lat - d_lat, lat + d_lat, lon - d_lon, lon + d_lon


@app.post("/api/hazards")
def submit(batch: ReportBatch) -> dict:
    """Merge a batch of sightings into the hazard map."""
    now = int(time.time() * 1000)
    merged = created = 0

    with db() as conn:
        for report in batch.reports:
            lat_min, lat_max, lon_min, lon_max = bbox(report.lat, report.lon, CLUSTER_RADIUS_M)
            # ponytail: bounding box + python haversine. Swap for PostGIS/GiST
            # if this ever holds more than a city's worth of hazards.
            candidates = conn.execute(
                "SELECT * FROM hazards WHERE type = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                (report.type, lat_min, lat_max, lon_min, lon_max),
            ).fetchall()

            match = min(
                (row for row in candidates
                 if haversine_m(report.lat, report.lon, row["lat"], row["lon"]) <= CLUSTER_RADIUS_M),
                key=lambda row: haversine_m(report.lat, report.lon, row["lat"], row["lon"]),
                default=None,
            )

            at = report.at or now
            if match is None:
                conn.execute(
                    "INSERT INTO hazards (lat, lon, type, reports, confidence, first_seen, last_seen)"
                    " VALUES (?, ?, ?, 1, ?, ?, ?)",
                    (report.lat, report.lon, report.type, report.confidence, at, at),
                )
                created += 1
                continue

            n = match["reports"]
            # running mean of confidence, and the cluster centre drifts towards
            # the new sighting so repeated reports sharpen the position
            conn.execute(
                "UPDATE hazards SET reports = ?, confidence = ?, lat = ?, lon = ?, last_seen = ?"
                " WHERE id = ?",
                (
                    n + 1,
                    (match["confidence"] * n + report.confidence) / (n + 1),
                    (match["lat"] * n + report.lat) / (n + 1),
                    (match["lon"] * n + report.lon) / (n + 1),
                    max(match["last_seen"], at),
                    match["id"],
                ),
            )
            merged += 1

    return {"accepted": len(batch.reports), "created": created, "merged": merged}


@app.get("/api/hazards")
def nearby(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    radius: float = Query(3000, gt=0, le=20_000_000),  # earth-scale allowed for the dashboard
    min_score: float = Query(0.0, ge=0, le=1),
) -> dict:
    """Every mapped hazard within `radius` metres, newest and strongest first."""
    lat_min, lat_max, lon_min, lon_max = bbox(lat, lon, radius)
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM hazards WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 2000",
            (lat_min, lat_max, lon_min, lon_max),
        ).fetchall()

    hazards = []
    for row in rows:
        if haversine_m(lat, lon, row["lat"], row["lon"]) > radius:
            continue
        score = consensus_score(row["reports"], row["confidence"], row["last_seen"])
        if score < min_score:
            continue
        hazards.append({
            "id": row["id"],
            "lat": row["lat"],
            "lon": row["lon"],
            "type": row["type"],
            "reports": row["reports"],
            "confidence": round(row["confidence"], 4),
            "score": score,
            "at": row["last_seen"],
        })

    hazards.sort(key=lambda h: h["score"], reverse=True)
    return {"hazards": hazards}


@app.get("/api/stats")
def stats() -> dict:
    """Feeds the municipal dashboard."""
    with db() as conn:
        rows = conn.execute("SELECT * FROM hazards").fetchall()
    scored = [
        dict(row, score=consensus_score(row["reports"], row["confidence"], row["last_seen"]))
        for row in map(dict, rows)
    ]
    by_type: dict[str, int] = {}
    for hazard in scored:
        by_type[hazard["type"]] = by_type.get(hazard["type"], 0) + 1
    return {
        "hazards": len(scored),
        "reports": sum(h["reports"] for h in scored),
        "confirmed": sum(1 for h in scored if h["score"] >= 0.7),
        "by_type": by_type,
    }


@app.get("/dashboard")
def dashboard() -> FileResponse:
    return FileResponse(ROOT / "dashboard.html")


# Serving the built PWA from the same origin keeps the demo to one process and
# one URL. Absent in development, where vite serves the app instead.
if APP_DIST.is_dir():
    app.mount("/", StaticFiles(directory=APP_DIST, html=True), name="app")
