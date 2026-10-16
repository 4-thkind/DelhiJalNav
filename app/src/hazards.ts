import { CLASS_WEIGHT, className, type Detection } from "./types.ts";

/**
 * Alert engine: turns a stream of per-frame detections into a small number of
 * trustworthy warnings.
 *
 * A raw detection is not a warning. A detection becomes a warning only when it
 * (1) persists across frames, (2) sits inside the rider's projected path, and
 * (3) is close enough that the rider still has time to react but near enough to
 * still be relevant.
 */

/**
 * Camera geometry, used for the flat-road distance approximation. These are
 * defaults for a phone clamped to a handlebar; the setup screen lets the rider
 * calibrate them, because mount height and tilt vary a lot between bikes.
 */
export interface CameraModel {
  /** Lens height above the road, metres. */
  heightM: number;
  /** Vertical field of view of the camera, degrees. */
  vFovDeg: number;
  /** Where the horizon falls in the frame, 0 = top edge, 1 = bottom edge. */
  horizonFrac: number;
}

export const DEFAULT_CAMERA: CameraModel = { heightM: 1.0, vFovDeg: 55, horizonFrac: 0.45 };

export interface TunableConfig {
  /** Minimum detector confidence for a box to start a new track. */
  minScore: number;
  /**
   * Lower confidence that still keeps an existing track alive (hysteresis): a pothole
   * blurs or shrinks for a frame or two at speed, and should not be lost and re-found.
   * Never starts a track, so it adds no new false alarms on its own.
   */
  keepScore: number;
  /** Consecutive-ish frames a track must be seen before it can raise an alert. */
  minHits: number;
  /** Frames a track survives without a match before it is dropped. */
  maxMisses: number;
  /** Warn when the rider is this many seconds away from the hazard. */
  warnSeconds: number;
  /** Never warn about something already this close - it is too late to help. */
  minReactionSeconds: number;
  /** Minimum gap between any two spoken alerts. */
  cooldownMs: number;
  /** Assumed speed when GPS has no fix yet, m/s (~29 km/h). */
  fallbackSpeedMps: number;
  /** Severity below this is logged but never announced. */
  alertSeverity: number;
}

export const DEFAULT_CONFIG: TunableConfig = {
  minScore: 0.4,
  keepScore: 0.25,
  minHits: 3,
  maxMisses: 5,
  warnSeconds: 3.5,
  minReactionSeconds: 0.4,
  cooldownMs: 3000,
  fallbackSpeedMps: 8,
  alertSeverity: 0.35,
};

export interface Track {
  id: number;
  cls: number;
  box: Detection;
  hits: number;
  misses: number;
  firstSeen: number;
  lastSeen: number;
  alerted: boolean;
  /** Estimated distance ahead in metres. */
  distanceM: number;
  /** Seconds until the bike reaches it at the current speed. */
  ttcSeconds: number;
  inPath: boolean;
  severity: number;
}

export interface Alert {
  track: Track;
  label: string;
  distanceM: number;
  severity: number;
  spoken: string;
}

const IOU_MATCH = 0.3;

function boxIou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - overlap;
  return union > 0 ? overlap / union : 0;
}

/**
 * Flat-road distance from where the bottom of the box sits in the frame.
 *
 * The road is assumed flat and the camera level, so the angle below the horizon
 * maps directly to a ground distance: d = height / tan(angle). Anything at or
 * above the horizon is effectively infinitely far away.
 */
export function estimateDistance(bottomY: number, frameH: number, cam: CameraModel): number {
  const belowHorizon = bottomY / frameH - cam.horizonFrac;
  if (belowHorizon <= 0.002) return Infinity;
  const radPerFrac = (cam.vFovDeg * Math.PI) / 180;
  return cam.heightM / Math.tan(belowHorizon * radPerFrac);
}

/**
 * Half-width of the rider's path corridor, as a fraction of frame width.
 *
 * Under perspective a fixed-width corridor is a trapezoid in the image: narrow
 * at the horizon, wide at the bottom of the frame. `depth` runs 0 at the horizon
 * to 1 at the bottom edge.
 *
 * Exported so the AR overlay draws exactly the corridor the engine tests
 * against - if the two ever disagree, the rider sees hazards inside the lines
 * that never trigger a warning.
 */
export const CORRIDOR_AT_HORIZON = 0.06;
export const CORRIDOR_AT_BUMPER = 0.4;

export function corridorHalfWidth(depth: number): number {
  const clamped = Math.min(1, Math.max(0, depth));
  return CORRIDOR_AT_HORIZON + (CORRIDOR_AT_BUMPER - CORRIDOR_AT_HORIZON) * clamped;
}

/**
 * Is the hazard in the lane the bike is actually going to occupy? Anything
 * outside the corridor is on the periphery: tracked, drawn, never announced.
 */
export function isInPath(box: Detection, frameW: number, frameH: number, cam: CameraModel): boolean {
  const bottomY = box.y + box.h;
  const depth = (bottomY / frameH - cam.horizonFrac) / (1 - cam.horizonFrac);
  if (depth <= 0) return false;
  const centreX = (box.x + box.w / 2) / frameW;
  return Math.abs(centreX - 0.5) <= corridorHalfWidth(depth);
}

/**
 * Severity blends what the hazard is, how sure we are, and how urgent it is.
 * Urgency peaks in the window where a warning is actually actionable: a hazard
 * 15 seconds out is noise, one already under the wheel is too late.
 */
export function severityOf(cls: number, score: number, ttc: number, cfg: TunableConfig): number {
  const weight = CLASS_WEIGHT[className(cls)] ?? 1;
  if (!Number.isFinite(ttc) || ttc > cfg.warnSeconds * 3) return 0;
  const urgency = ttc <= cfg.warnSeconds
    ? 1
    : Math.max(0, 1 - (ttc - cfg.warnSeconds) / (cfg.warnSeconds * 2));
  return weight * score * urgency;
}

export class AlertEngine {
  private tracks: Track[] = [];
  private nextId = 1;
  private lastAlertAt = -Infinity;

  cfg: TunableConfig;
  cam: CameraModel;

  constructor(cfg: Partial<TunableConfig> = {}, cam: Partial<CameraModel> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.cam = { ...DEFAULT_CAMERA, ...cam };
  }

  get active(): Track[] {
    return this.tracks.filter((t) => t.hits >= this.cfg.minHits && t.misses === 0);
  }

  reset(): void {
    this.tracks = [];
    this.lastAlertAt = -Infinity;
  }

  /**
   * Fold one frame of detections into the tracker and return any alerts that
   * should fire right now.
   */
  update(dets: Detection[], frameW: number, frameH: number, speedMps: number, now: number): Alert[] {
    const unmatched = new Set(this.tracks);

    // strongest boxes claim tracks first
    for (const det of [...dets].sort((a, b) => b.score - a.score)) {
      let best: Track | undefined;
      let bestIou = IOU_MATCH;
      for (const track of unmatched) {
        if (track.cls !== det.cls) continue;
        const score = boxIou(track.box, det);
        if (score > bestIou) {
          bestIou = score;
          best = track;
        }
      }
      if (best) {
        unmatched.delete(best);
        best.box = det;
        best.hits++;
        best.misses = 0;
        best.lastSeen = now;
      } else if (det.score >= this.cfg.minScore) {
        this.tracks.push({
          id: this.nextId++,
          cls: det.cls,
          box: det,
          hits: 1,
          misses: 0,
          firstSeen: now,
          lastSeen: now,
          alerted: false,
          distanceM: Infinity,
          ttcSeconds: Infinity,
          inPath: false,
          severity: 0,
        });
      }
    }

    for (const track of unmatched) track.misses++;
    this.tracks = this.tracks.filter((t) => t.misses <= this.cfg.maxMisses);

    const speed = speedMps > 1 ? speedMps : this.cfg.fallbackSpeedMps;
    const alerts: Alert[] = [];

    for (const track of this.tracks) {
      track.distanceM = estimateDistance(track.box.y + track.box.h, frameH, this.cam);
      track.ttcSeconds = track.distanceM / speed;
      track.inPath = isInPath(track.box, frameW, frameH, this.cam);
      track.severity = track.inPath ? severityOf(track.cls, track.box.score, track.ttcSeconds, this.cfg) : 0;

      const ready =
        !track.alerted &&
        track.hits >= this.cfg.minHits &&
        track.misses === 0 &&
        track.inPath &&
        track.ttcSeconds <= this.cfg.warnSeconds &&
        track.ttcSeconds >= this.cfg.minReactionSeconds &&
        track.severity >= this.cfg.alertSeverity;

      if (ready && now - this.lastAlertAt >= this.cfg.cooldownMs) {
        track.alerted = true;
        this.lastAlertAt = now;
        const label = className(track.cls).replace(/_/g, " ");
        alerts.push({
          track,
          label,
          distanceM: track.distanceM,
          severity: track.severity,
          spoken: `${label} ahead, ${Math.max(5, Math.round(track.distanceM / 5) * 5)} metres`,
        });
      }
    }

    return alerts;
  }
}
