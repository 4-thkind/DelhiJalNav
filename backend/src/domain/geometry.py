"""Line / polygon tests for route filtering, in local metres.

GeoJSON order everywhere: [longitude, latitude]. Points are projected to a
local equirectangular plane around a reference point before any test, so no
distance is ever measured in degrees. Accurate to well under a metre over a
few kilometres, which is all a single corridor needs.
"""
from __future__ import annotations

import math

EARTH_M_PER_DEG = 111_320.0
#: Generous Delhi NCR box. Catches swapped [lat, lon] pairs (28, 77 -> 77, 28).
DELHI_BBOX = (76.80, 28.30, 77.60, 29.00)  # min lon, min lat, max lon, max lat
#: Two consecutive route vertices further apart than this mean a gap in geometry.
MAX_VERTEX_GAP_M = 1_000.0

Point = tuple[float, float]


def project(lonlat: list[float] | Point, ref: Point) -> Point:
    lon, lat = lonlat
    return (
        (lon - ref[0]) * EARTH_M_PER_DEG * math.cos(math.radians(ref[1])),
        (lat - ref[1]) * EARTH_M_PER_DEG,
    )


def distance_m(a: list[float] | Point, b: list[float] | Point) -> float:
    x, y = project(b, (a[0], a[1]))
    return math.hypot(x, y)


def validate_line(coords: object, bbox: tuple[float, float, float, float] = DELHI_BBOX) -> str | None:
    """Return an error code for malformed or implausible route geometry."""
    if not isinstance(coords, list) or len(coords) < 2:
        return "GEOMETRY_TOO_SHORT"
    for c in coords:
        if (
            not isinstance(c, (list, tuple)) or len(c) != 2
            or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in c)
        ):
            return "GEOMETRY_INVALID_COORDINATE"
        lon, lat = c
        if not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
            return "GEOMETRY_OUTSIDE_COVERAGE_OR_SWAPPED"
    for a, b in zip(coords, coords[1:]):
        if distance_m(a, b) > MAX_VERTEX_GAP_M:
            return "GEOMETRY_DISCONNECTED"
    return None


def _cross(o: Point, a: Point, b: Point) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _on_segment(p: Point, a: Point, b: Point) -> bool:
    return min(a[0], b[0]) - 1e-9 <= p[0] <= max(a[0], b[0]) + 1e-9 and \
        min(a[1], b[1]) - 1e-9 <= p[1] <= max(a[1], b[1]) + 1e-9


def segments_intersect(p1: Point, p2: Point, q1: Point, q2: Point) -> bool:
    """Proper or touching intersection, including collinear overlap."""
    d1, d2 = _cross(q1, q2, p1), _cross(q1, q2, p2)
    d3, d4 = _cross(p1, p2, q1), _cross(p1, p2, q2)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and d1 and d2 and d3 and d4:
        return True
    return (
        (d1 == 0 and _on_segment(p1, q1, q2)) or (d2 == 0 and _on_segment(p2, q1, q2))
        or (d3 == 0 and _on_segment(q1, p1, p2)) or (d4 == 0 and _on_segment(q2, p1, p2))
    )


def point_in_ring(p: Point, ring: list[Point]) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > p[1]) != (y2 > p[1]) and p[0] < (x2 - x1) * (p[1] - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def line_intersects_polygon(line: list[list[float]], ring: list[list[float]]) -> bool:
    """True when any part of the line touches the polygon - including a segment
    that passes straight through between two vertices that are both outside."""
    ref = (ring[0][0], ring[0][1])
    poly = [project(c, ref) for c in ring]
    if poly[0] == poly[-1]:
        poly = poly[:-1]
    pts = [project(c, ref) for c in line]
    if any(point_in_ring(p, poly) for p in pts):
        return True
    edges = list(zip(poly, poly[1:] + poly[:1]))
    return any(segments_intersect(a, b, c, d) for a, b in zip(pts, pts[1:]) for c, d in edges)


def point_in_polygon(p: list[float], ring: list[list[float]]) -> bool:
    ref = (ring[0][0], ring[0][1])
    return point_in_ring(project(p, ref), [project(c, ref) for c in ring])


def line_near_point(line: list[list[float]], p: list[float], radius_m: float) -> bool:
    """True when any segment of the line passes within radius_m of p."""
    ref = (p[0], p[1])
    pts = [project(c, ref) for c in line]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        dx, dy = x2 - x1, y2 - y1
        t = max(0.0, min(1.0, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
        if math.hypot(x1 + t * dx, y1 + t * dy) <= radius_m:
            return True
    return False
