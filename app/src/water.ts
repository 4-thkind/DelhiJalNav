/**
 * Water on the road ahead, from a semantic segmentation model.
 *
 * The model (SegFormer-b0 trained on ADE20K, waterModel.ts) labels every pixel
 * with one of 150 scene classes; four of them are water (water, sea, river,
 * lake). This file is the pure part: from the model's logits, how much of the
 * road ahead (below the horizon, central 70 % of the frame) is water, and when
 * that is sustained enough to warn. Tested on photos: 6 of 7 outdoor flooded
 * streets read 17-94 % water, 6 dry Delhi roads read 0 %. Not trained on Delhi
 * monsoon footage, so the app still says "possible water" and never files a
 * report by itself.
 */

/** ADE20K class ids (0-based, reduced labels) that mean standing or open water. */
export const WATER_CLASSES = [21, 26, 60, 128];

export interface WaterBox {
  /** Fractions of the frame, 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WaterFrame {
  /** Share of the road region labelled water, 0..1. */
  fraction: number;
  box: WaterBox | null;
}

/**
 * logits: [classes, h, w] row-major (batch dimension dropped). Argmax per
 * pixel, only inside the road region.
 */
export function waterFromLogits(logits: ArrayLike<number>, classes: number, h: number, w: number, horizonFrac: number): WaterFrame {
  const plane = h * w;
  const top = Math.min(h - 1, Math.floor(horizonFrac * h));
  const left = Math.floor(w * 0.15), right = Math.ceil(w * 0.85);
  let total = 0, hits = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = top; y < h; y++) {
    for (let x = left; x < right; x++) {
      const i = y * w + x;
      let best = 0, bestV = -Infinity;
      for (let c = 0; c < classes; c++) {
        const v = logits[c * plane + i];
        if (v > bestV) [bestV, best] = [v, c];
      }
      total++;
      if (WATER_CLASSES.includes(best)) {
        hits++;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
  }
  const fraction = total ? hits / total : 0;
  return { fraction, box: hits ? { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h } : null };
}

/** Warn when 2 of the last 3 model runs see enough water; then stay quiet for a while. */
export class WaterGate {
  cfg = { minFraction: 0.15, need: 2, window: 3, cooldownMs: 20_000 };
  private recent: boolean[] = [];
  private lastAlertAt = -Infinity;

  reset(): void {
    this.recent = [];
    this.lastAlertAt = -Infinity;
  }

  /** Feed one model run; true when the rider should be warned now. */
  update(fraction: number, nowMs: number): boolean {
    this.recent = [...this.recent, fraction >= this.cfg.minFraction].slice(-this.cfg.window);
    const seen = this.recent.filter(Boolean).length >= this.cfg.need;
    if (!seen || nowMs - this.lastAlertAt < this.cfg.cooldownMs) return false;
    this.lastAlertAt = nowMs;
    return true;
  }
}
