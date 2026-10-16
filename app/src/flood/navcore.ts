/**
 * Pure navigation helpers for the guidance banner, the simulated drive and the
 * water-striped route segment. GeoJSON order: [lon, lat]. No DOM, no Leaflet.
 */
import type { RouteStep } from "./contracts.ts";

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a: [number, number], b: [number, number]): number {
  const dLon = rad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Cumulative metres at each vertex. */
export function cumulative(line: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + haversine(line[i - 1], line[i]));
  return out;
}

/** Point and heading after travelling `metres` along the line (clamped to its ends). */
export function along(line: [number, number][], cum: number[], metres: number): { point: [number, number]; heading: number } {
  const total = cum[cum.length - 1];
  const m = Math.max(0, Math.min(total, metres));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < m) i++;
  const a = line[i - 1];
  const b = line[i];
  const seg = cum[i] - cum[i - 1] || 1;
  const t = (m - cum[i - 1]) / seg;
  return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearing(a, b) };
}

/** Index of the first maneuver still ahead, by cumulative step distance. */
export function nextStep(steps: RouteStep[], travelled: number): { index: number; distanceToM: number } {
  let start = 0;
  for (let i = 0; i < steps.length; i++) {
    if (start >= travelled - 1 && i > 0) return { index: i, distanceToM: start - travelled };
    start += steps[i].distanceM;
  }
  return { index: steps.length - 1, distanceToM: Math.max(0, start - travelled) };
}

/** Even-odd point in polygon in lon/lat space (fine for drawing at city scale). */
export function inRing(p: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The part of a route inside a hazard polygon, densified to ~5 m, for the striped overlay. */
export function segmentInside(line: [number, number][], ring: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < line.length; i++) {
    const n = Math.max(1, Math.ceil(haversine(line[i - 1], line[i]) / 5));
    for (let k = 0; k <= n; k++) {
      const p: [number, number] = [
        line[i - 1][0] + ((line[i][0] - line[i - 1][0]) * k) / n,
        line[i - 1][1] + ((line[i][1] - line[i - 1][1]) * k) / n,
      ];
      if (inRing(p, ring)) out.push(p);
    }
  }
  return out;
}

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.max(10, Math.round(m / 10) * 10)} m`;
}

/** Glyph for a maneuver, used in the banner and cue sheet. */
export function arrow(type: string, modifier: string | null): string {
  if (type === "arrive") return "●";
  if (type === "roundabout" || type === "rotary") return "⟳";
  switch (modifier) {
    case "left": return "↰";
    case "sharp left": return "↰";
    case "slight left": return "↖";
    case "right": return "↱";
    case "sharp right": return "↱";
    case "slight right": return "↗";
    case "uturn": return "↶";
    default: return "↑";
  }
}

/** Snap a GPS point to the route: metres travelled along it and how far off it the point is. */
export function project(line: [number, number][], cum: number[], p: [number, number]): { travelled: number; offM: number } {
  let best = { travelled: 0, offM: Infinity };
  const k = Math.cos(rad(p[1]));
  for (let i = 1; i < line.length; i++) {
    // local planar projection, fine over one segment
    const ax = (line[i - 1][0] - p[0]) * k, ay = line[i - 1][1] - p[1];
    const bx = (line[i][0] - p[0]) * k, by = line[i][1] - p[1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-18;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + dx * t, ay + dy * t) * 111_320;
    if (off < best.offM) best = { travelled: cum[i - 1] + (cum[i] - cum[i - 1]) * t, offM: off };
  }
  return best;
}

export interface Fix {
  lon: number;
  lat: number;
  /** 1-sigma horizontal accuracy in metres, as reported by the device. */
  accuracyM: number;
  /** ms timestamp of the fix */
  t: number;
}

/** Fixes worse than this are flagged as weak (dimmed avatar, weak-GPS badge). */
export const MAX_USABLE_ACCURACY_M = 100;
/** Fixes worse than this are not used for guidance at all. Laptops on Wi-Fi location sit around 100-200 m. */
export const MAX_GUIDANCE_ACCURACY_M = 300;
/** Process noise: how far a rider can plausibly move between fixes, (m/s)^2 per second. */
const MOTION_VAR_PER_S = 36;

/**
 * Accuracy-weighted smoothing (a 1-D Kalman filter per axis). A precise fix moves
 * the estimate a lot, a vague one barely, and uncertainty grows with time so a
 * moving rider is not dragged back. Returns the new estimate.
 */
export function smoothFix(prev: Fix | undefined, next: Fix): Fix {
  if (!prev || next.t - prev.t > 15_000 || next.t < prev.t) return next;
  const dt = Math.max(0, (next.t - prev.t) / 1000);
  const pv = prev.accuracyM ** 2 + MOTION_VAR_PER_S * dt;
  const k = pv / (pv + next.accuracyM ** 2);
  return {
    lon: prev.lon + k * (next.lon - prev.lon),
    lat: prev.lat + k * (next.lat - prev.lat),
    accuracyM: Math.sqrt((1 - k) * pv),
    t: next.t,
  };
}
