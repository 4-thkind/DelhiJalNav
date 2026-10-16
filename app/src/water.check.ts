/** Self-check for the water decision logic. Run with: `node src/water.check.ts` */
import assert from "node:assert/strict";

import { WATER_CLASSES, WaterGate, waterFromLogits } from "./water.ts";

const C = 150, H = 16, W = 16, HORIZON = 0.45;

/** Logits where pixels matching `isWater(x, y)` win as class 21 (water), the rest as class 6 (road). */
function logits(isWater: (x: number, y: number) => boolean): Float32Array {
  const out = new Float32Array(C * H * W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      out[(isWater(x, y) ? 21 : 6) * H * W + i] = 5;
    }
  }
  return out;
}

const dry = waterFromLogits(logits(() => false), C, H, W, HORIZON);
assert.equal(dry.fraction, 0);
assert.equal(dry.box, null);

const flooded = waterFromLogits(logits((_, y) => y >= 10), C, H, W, HORIZON);
assert.ok(flooded.fraction > 0.5, `flooded road ${flooded.fraction}`);
assert.ok(flooded.box && flooded.box.y >= HORIZON, "box lies on the road below the horizon");

const skyOnly = waterFromLogits(logits((_, y) => y < 6), C, H, W, HORIZON);
assert.equal(skyOnly.fraction, 0, "water above the horizon (a river in the distance) does not count");
const kerb = waterFromLogits(logits((x) => x < 2), C, H, W, HORIZON);
assert.equal(kerb.fraction, 0, "water at the frame edge, outside the road region, does not count");
assert.ok(WATER_CLASSES.includes(21) && WATER_CLASSES.includes(26));

// muddy waterlogging: "road" wins every pixel, but water is a strong second (p ~ 0.24) - still water
const muddy = new Float32Array(C * H * W);
for (let i = 0; i < H * W; i++) { muddy[6 * H * W + i] = 5.6; muddy[21 * H * W + i] = 4.9; }
assert.ok(waterFromLogits(muddy, C, H, W, HORIZON).fraction > 0.9, "water as a strong second class counts");
// a faint water hint (p ~ 0.035) on a dry road does not
const faint = new Float32Array(C * H * W);
for (let i = 0; i < H * W; i++) { faint[6 * H * W + i] = 6; faint[21 * H * W + i] = 3; }
assert.equal(waterFromLogits(faint, C, H, W, HORIZON).fraction, 0, "a faint water hint is not water");

const gate = new WaterGate();
assert.equal(gate.update(0.4, 0), false, "one run is not enough");
assert.equal(gate.update(0.05, 500), false);
assert.equal(gate.update(0.3, 1000), true, "2 of the last 3 runs see water");
assert.equal(gate.update(0.5, 1500), false, "cooldown: no repeat warning");
assert.equal(gate.update(0.5, 22_000), true, "warns again after the cooldown");

console.log("water.check.ts: all assertions passed");
