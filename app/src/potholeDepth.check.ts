/** Self-check for the pothole depth estimate. Run with: `node src/potholeDepth.check.ts` */
import assert from "node:assert/strict";

import { DEFAULT_CAMERA } from "./hazards.ts";
import { estimatePotholeDepth, severityOf } from "./potholeDepth.ts";

const W = 48, H = 48, MARGIN = 0.5;
let seed = 3;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

/** Textured asphalt crop; the central box region gets the given floor. */
function patch(floor: "deep" | "shallow" | "none") {
  const lum = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inBox = x >= 12 && x < 36 && y >= 12 && y < 36;
      let v = 110 + rand() * 50;
      if (inBox && floor === "deep") v = 45 + rand() * 8; // dark, smooth (shadow + silt)
      if (inBox && floor === "shallow") v = 118 + rand() * 40; // barely darker, still rough
      lum[y * W + x] = v;
    }
  }
  return { lum, w: W, h: H, margin: MARGIN };
}

const frameW = 1280, frameH = 720;
const near = { x: 560, y: 560, w: 180, h: 70, score: 0.8, cls: 0 }; // ~5 m ahead, ~0.6 m wide
const deep = estimatePotholeDepth(near, frameW, frameH, DEFAULT_CAMERA, patch("deep"))!;
const shallow = estimatePotholeDepth(near, frameW, frameH, DEFAULT_CAMERA, patch("shallow"))!;

assert.ok(deep.distanceM > 2 && deep.distanceM < 10, `distance ${deep.distanceM}`);
assert.ok(deep.depthM >= 0.03 && deep.depthM <= 0.2, `deep crater in 0.03..0.20 m, got ${deep.depthM}`);
assert.equal(deep.severity, "CRITICAL", "dark smooth wide crater is critical");
assert.ok(shallow.depthM < deep.depthM, "a faint scrape reads shallower than a dark crater");
assert.notEqual(shallow.severity, "CRITICAL", "a faint scrape is not critical");

const small = estimatePotholeDepth({ ...near, x: 620, w: 40, h: 16 }, frameW, frameH, DEFAULT_CAMERA, patch("deep"))!;
assert.ok(small.widthM < deep.widthM && small.depthM < deep.depthM, "a small hole reads shallower than a big one");

assert.equal(estimatePotholeDepth({ ...near, y: 200, h: 100 }, frameW, frameH, DEFAULT_CAMERA, patch("deep")), null,
  "a box ending above the horizon has no ground distance");
assert.deepEqual([severityOf(0.029), severityOf(0.03), severityOf(0.06), severityOf(0.061)], ["MINOR", "MODERATE", "MODERATE", "CRITICAL"]);

console.log(`potholeDepth.check.ts: all assertions passed (deep ${deep.depthM} m at ${deep.distanceM.toFixed(1)} m, shallow ${shallow.depthM} m)`);
