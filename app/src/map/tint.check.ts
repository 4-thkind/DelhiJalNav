/** Self-check for the tilted-map colour compensation. Run with: `node src/map/tint.check.ts` */
import assert from "node:assert/strict";

import { TINT_FORWARD, untint } from "./tint.ts";

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const filter = (rgb: number[]) => TINT_FORWARD.map((row) => Math.round(Math.min(255, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]))));

// measured in Chrome: pure red under hue-rotate(-70deg) saturate(.75) renders as (144, 15, 182)
assert.deepEqual(filter([255, 0, 0]), [144, 15, 182]);
// palette colours drawn through untint come out of the filter as themselves (within rounding)
for (const c of ["#F7F4D5", "#839958", "#D3968C", "#6E7B70"]) {
  const shown = filter(hex(untint(c)));
  hex(c).forEach((v, i) => assert.ok(Math.abs(v - shown[i]) <= 2, `${c} -> ${shown}`));
}
console.log("tint.check.ts: all assertions passed");
