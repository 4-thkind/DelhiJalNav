/**
 * Location, the offline-first report queue, and the crowdsourced hazard layer.
 *
 * Detections are reported as metadata only - coordinates, type, confidence.
 * Video never leaves the phone.
 */
export interface HazardReport {
  lat: number;
  lon: number;
  type: string;
  confidence: number;
  at: number;
}

export interface NetworkHazard extends HazardReport {
  id: number;
  reports: number;
  /** Consensus confidence from the backend, 0..1. */
  score: number;
}

const EARTH_R = 6371000;
const QUEUE_KEY = "margsetu.legacyPotholeQueue";
const LEGACY_QUEUE_KEY = "pathfinder.queue";
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing from a->b in degrees, 0 = north. */
export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLon = rad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(rad(bLat));
  const x =
    Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest signed angle between two bearings, -180..180. */
export function angleDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/** Fixes worse than this are shown but never used to estimate speed or heading. */
const MAX_ESTIMATE_ACCURACY_M = 50;

export class RideLocation {
  position?: GeolocationPosition;
  private watchId?: number;
  /** The last fix good enough to estimate speed and heading from. */
  private previous?: GeolocationPosition;
  /** Metres per second. Falls back to a positional estimate where the GPS gives none. */
  speedMps = 0;
  headingDeg = 0;
  onUpdate?: (position: GeolocationPosition) => void;
  /** Location off, denied, no signal or timed out - shown to the rider, never only logged. */
  onError?: (err: GeolocationPositionError) => void;

  start(): void {
    if (this.watchId !== undefined || !("geolocation" in navigator)) return;
    // a new ride must not estimate speed from where the last one ended
    this.previous = undefined;
    this.speedMps = 0;
    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        if (typeof position.coords.speed === "number" && position.coords.speed >= 0) {
          this.speedMps = position.coords.speed;
        } else if (this.previous && position.coords.accuracy <= MAX_ESTIMATE_ACCURACY_M) {
          const dt = (position.timestamp - this.previous.timestamp) / 1000;
          if (dt > 0.2) {
            this.speedMps =
              distanceM(
                this.previous.coords.latitude,
                this.previous.coords.longitude,
                position.coords.latitude,
                position.coords.longitude,
              ) / dt;
          }
        }
        if (typeof position.coords.heading === "number" && !Number.isNaN(position.coords.heading)) {
          this.headingDeg = position.coords.heading;
        } else if (this.previous && position.coords.accuracy <= MAX_ESTIMATE_ACCURACY_M) {
          this.headingDeg = bearingDeg(
            this.previous.coords.latitude,
            this.previous.coords.longitude,
            position.coords.latitude,
            position.coords.longitude,
          );
        }
        // the estimate above used the immediately preceding good fix; keep only good ones
        if (position.coords.accuracy <= MAX_ESTIMATE_ACCURACY_M) this.previous = position;
        this.position = position;
        this.onUpdate?.(position);
      },
      (err) => {
        console.warn("[geo]", err.message);
        this.onError?.(err);
      },
      // maximumAge 0: never accept a cached fix from before the ride
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }

  stop(): void {
    if (this.watchId !== undefined) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = undefined;
  }
}

/**
 * Buffers hazard reports locally and drains them to the backend when there is a
 * connection. A ride through a dead zone still contributes its data later.
 */
export class ReportQueue {
  /** Two detections of the same type within this radius are the same hazard. */
  static DEDUPE_M = 20;
  private queue: HazardReport[] = [];
  private sent: HazardReport[] = [];

  constructor(private apiBase: string) {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? localStorage.getItem(LEGACY_QUEUE_KEY) ?? "[]");
      this.queue = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.queue = [];
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  private persist(): void {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue.slice(-500)));
    } catch {
      /* storage full or blocked - the ride matters more than the report */
    }
  }

  add(report: HazardReport): boolean {
    const duplicate = [...this.queue, ...this.sent].some(
      (r) =>
        r.type === report.type &&
        distanceM(r.lat, r.lon, report.lat, report.lon) < ReportQueue.DEDUPE_M,
    );
    if (duplicate) return false;
    this.queue.push(report);
    this.persist();
    return true;
  }

  async flush(): Promise<number> {
    if (!this.queue.length || !navigator.onLine) return 0;
    const batch = this.queue.slice(0, 100);
    try {
      const res = await fetch(`${this.apiBase}/api/hazards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reports: batch }),
      });
      if (!res.ok) return 0;
      this.queue = this.queue.slice(batch.length);
      this.sent.push(...batch);
      if (this.sent.length > 500) this.sent.splice(0, this.sent.length - 500);
      this.persist();
      return batch.length;
    } catch {
      return 0; // stay queued, try again next time
    }
  }
}

/**
 * Hazards other riders have already mapped. This is what lets the app warn
 * about a pothole around a blind corner, before the camera can possibly see it.
 */
export class HazardNetwork {
  hazards: NetworkHazard[] = [];
  private warned = new Set<number>();

  constructor(private apiBase: string) {}

  async refresh(lat: number, lon: number, radiusM = 3000): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/api/hazards?lat=${lat}&lon=${lon}&radius=${radiusM}`);
      if (res.ok) this.hazards = (await res.json()).hazards ?? [];
    } catch {
      /* offline: keep whatever was cached from the last refresh */
    }
  }

  /**
   * The nearest mapped hazard the rider is actually heading towards, once per
   * hazard per ride.
   */
  upcoming(lat: number, lon: number, headingDeg: number, withinM = 120): NetworkHazard | undefined {
    let best: NetworkHazard | undefined;
    let bestDistance = withinM;
    for (const hazard of this.hazards) {
      if (this.warned.has(hazard.id) || hazard.score < 0.5) continue;
      const d = distanceM(lat, lon, hazard.lat, hazard.lon);
      if (d > bestDistance || d < 15) continue;
      // only count it if it lies ahead, not behind or off to the side
      if (Math.abs(angleDelta(headingDeg, bearingDeg(lat, lon, hazard.lat, hazard.lon))) > 40) continue;
      best = hazard;
      bestDistance = d;
    }
    if (best) this.warned.add(best.id);
    return best;
  }

  reset(): void {
    this.warned.clear();
  }
}

/**
 * Compass heading from the magnetometer.
 *
 * GPS only knows which way you are facing while you are actually moving, so a
 * rider stopped at a light or turning the bars in place would have a frozen
 * arrow. The orientation sensor keeps pointing the right way when stationary.
 */
export class Compass {
  /** Degrees clockwise from north, or undefined until the sensor reports. */
  headingDeg?: number;
  private handler?: (event: DeviceOrientationEvent) => void;

  /** Must be called from a user gesture on iOS, which gates the sensor. */
  async start(): Promise<void> {
    if (this.handler) return;

    const requestPermission = (
      DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
    ).requestPermission;
    if (typeof requestPermission === "function") {
      try {
        if ((await requestPermission()) !== "granted") return;
      } catch {
        return; // denied or unavailable; the GPS heading still works while moving
      }
    }

    this.handler = (event) => {
      // iOS reports a true compass heading directly; elsewhere alpha is
      // counter-clockwise from north, so it has to be flipped
      const ios = (event as DeviceOrientationEvent & { webkitCompassHeading?: number })
        .webkitCompassHeading;
      if (typeof ios === "number" && !Number.isNaN(ios)) {
        this.headingDeg = ios;
      } else if (event.absolute && typeof event.alpha === "number") {
        this.headingDeg = (360 - event.alpha) % 360;
      }
    };

    addEventListener("deviceorientationabsolute", this.handler as EventListener);
    addEventListener("deviceorientation", this.handler as EventListener);
  }

  stop(): void {
    if (!this.handler) return;
    removeEventListener("deviceorientationabsolute", this.handler as EventListener);
    removeEventListener("deviceorientation", this.handler as EventListener);
    this.handler = undefined;
  }
}
