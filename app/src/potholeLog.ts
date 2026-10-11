/**
 * Potholes this phone's camera found, kept on this phone so they show on the map
 * on later rides (pings). Position = GPS position + the camera's distance
 * estimate along the heading, so it is approximate (tens of metres). Never
 * uploaded unless the rider turns on sharing in settings.
 */
const KEY = "dillijalnav.potholes";
const MAX = 200;
/** Two sightings closer than this are the same pothole. */
export const SAME_POTHOLE_M = 12;

export interface LoggedPothole {
  at: [number, number];
  depthM?: number;
  severe: boolean;
  seen: number;
}

/** Point `metres` from `from` along `bearingDeg` (flat-earth; fine for tens of metres). */
export function ahead(from: [number, number], bearingDeg: number, metres: number): [number, number] {
  const b = (bearingDeg * Math.PI) / 180;
  const lat = from[1] + (metres * Math.cos(b)) / 111_320;
  const lon = from[0] + (metres * Math.sin(b)) / (111_320 * Math.cos((from[1] * Math.PI) / 180));
  return [lon, lat];
}

function metresBetween(a: [number, number], b: [number, number]): number {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * 111_320 * k, (a[1] - b[1]) * 111_320);
}

export function loadPotholes(): LoggedPothole[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((p): p is LoggedPothole => Array.isArray(p?.at) && p.at.length === 2 && p.at.every(Number.isFinite))
      : [];
  } catch {
    return [];
  }
}

/** Add a sighting; merges with one already logged nearby (keeps the deeper estimate). */
export function logPothole(list: LoggedPothole[], p: LoggedPothole): LoggedPothole[] {
  const near = list.find((q) => metresBetween(q.at, p.at) < SAME_POTHOLE_M);
  const next = near
    ? list.map((q) => (q === near ? { ...q, seen: p.seen, severe: q.severe || p.severe, depthM: Math.max(q.depthM ?? 0, p.depthM ?? 0) || undefined } : q))
    : [...list, p].slice(-MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: this session still shows it */
  }
  return next;
}
