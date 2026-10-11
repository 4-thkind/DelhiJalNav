/**
 * Pothole depth ESTIMATE from one camera frame. A heuristic, not a measurement:
 * a single camera cannot see depth directly, and these constants are not yet
 * calibrated against measured Delhi potholes. It ranks potholes so a shallow
 * scrape is not announced like a rim-bending crater.
 *
 * 1. Size on the ground. Flat-road geometry (the same model as the distance
 *    warning) turns the box into metres: lateral size from the slant range,
 *    length from the ground distance of its top and bottom edges.
 * 2. How sunken it looks. Inside a deep pothole the floor sits in shadow
 *    (darker than the surrounding asphalt: luminance contrast) and is often
 *    smooth with silt or water (less texture: Laplacian ratio).
 * 3. depth = K * sqrt(area) * (0.7 * contrast + 0.3 * smoothness), clamped to
 *    0.01..0.20 m. Wider + darker + smoother = deeper. K is the calibration knob.
 *
 * Pure (no DOM): feed it the luminance of a crop around the box.
 */
import { estimateDistance, type CameraModel } from "./hazards.ts";
import type { Detection } from "./types.ts";

export type Severity = "MINOR" | "MODERATE" | "CRITICAL";

export interface DepthResult {
  /** Estimated depth in metres. */
  depthM: number;
  distanceM: number;
  widthM: number;
  lengthM: number;
  severity: Severity;
  /** 0..1: how much darker the floor is than the road around it. */
  contrast: number;
  /** 0..1: how much smoother the floor is than the road around it. */
  smoothness: number;
}

/** Luminance crop: the box sits in the middle with `margin` x box size of road on each side. */
export interface Patch {
  lum: ArrayLike<number>;
  w: number;
  h: number;
  margin: number;
}

/** Calibration: metres of depth per metre of sqrt(area) at full contrast. Prototype value. */
export const DEPTH_K = 0.3;
export const MODERATE_M = 0.03;
export const CRITICAL_M = 0.06;

export function severityOf(depthM: number): Severity {
  return depthM > CRITICAL_M ? "CRITICAL" : depthM >= MODERATE_M ? "MODERATE" : "MINOR";
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

export function estimatePotholeDepth(box: Detection, frameW: number, frameH: number, cam: CameraModel, patch: Patch): DepthResult | null {
  const distanceM = estimateDistance(box.y + box.h, frameH, cam);
  if (!Number.isFinite(distanceM) || frameW <= 0) return null;
  const fy = frameH / 2 / Math.tan((cam.vFovDeg * Math.PI) / 360);
  const slant = Math.hypot(distanceM, cam.heightM);
  const widthM = (box.w * slant) / fy;
  const far = estimateDistance(box.y, frameH, cam);
  const lengthM = Math.min(Number.isFinite(far) ? far - distanceM : Infinity, widthM * 3);
  const areaM2 = (Math.PI / 4) * widthM * Math.max(0.01, lengthM);

  // split the crop into the box interior and the road ring around it
  const { lum, w, h, margin } = patch;
  const inner = (n: number) => Math.round((n * margin) / (1 + 2 * margin));
  const x0 = inner(w), x1 = w - inner(w), y0 = inner(h), y1 = h - inner(h);
  const floor: number[] = [], road: number[] = [];
  let lapIn = 0, nIn = 0, lapOut = 0, nOut = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w]);
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        floor.push(lum[i]);
        lapIn += lap;
        nIn++;
      } else {
        road.push(lum[i]);
        lapOut += lap;
        nOut++;
      }
    }
  }
  if (!nIn || !nOut) return null;
  const roadLum = median(road);
  const contrast = Math.min(1, Math.max(0, (roadLum - median(floor)) / Math.max(1, roadLum)));
  const smoothness = Math.min(1, Math.max(0, 1 - lapIn / nIn / Math.max(1e-6, lapOut / nOut)));

  const raw = DEPTH_K * Math.sqrt(areaM2) * (0.7 * contrast + 0.3 * smoothness);
  const depthM = Math.round(Math.min(0.2, Math.max(0.01, raw)) * 1000) / 1000;
  return { depthM, distanceM, widthM, lengthM, severity: severityOf(depthM), contrast, smoothness };
}
