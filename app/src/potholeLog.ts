/**
 * Potholes this phone's camera found, kept on this phone so they show on the map
 * on later rides (pings). Position = GPS position + the camera's distance
 * estimate along the heading, so it is approximate (tens of metres). Never
 * uploaded unless the rider turns on sharing in settings.
 */
const KEY = "margsetu.potholes";
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

// ---------------------------------------------------------------- camera water sightings
const WATER_KEY = "margsetu.water";
/** Waterlogging drains within hours, so a camera sighting fades after this. */
export const WATER_TTL_MS = 6 * 3_600_000;
/** Two sightings closer than this are the same waterlogged spot. */
export const SAME_WATER_M = 40;

export interface LoggedWater {
  at: [number, number];
  seen: number;
}

export function loadWater(now = Date.now()): LoggedWater[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(WATER_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((w): w is LoggedWater =>
          Array.isArray(w?.at) && w.at.length === 2 && w.at.every(Number.isFinite) && now - w.seen < WATER_TTL_MS)
      : [];
  } catch {
    return [];
  }
}

/** Add a camera water sighting (merged with one nearby); expired ones are dropped. */
export function logWater(list: LoggedWater[], w: LoggedWater): LoggedWater[] {
  const live = list.filter((q) => w.seen - q.seen < WATER_TTL_MS);
  const near = live.find((q) => metresBetween(q.at, w.at) < SAME_WATER_M);
  const next = near ? live.map((q) => (q === near ? { ...q, seen: w.seen } : q)) : [...live, w].slice(-100);
  try {
    localStorage.setItem(WATER_KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: this session still shows it */
  }
  return next;
}
