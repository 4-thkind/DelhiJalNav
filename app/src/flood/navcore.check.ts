/** Self-check for navcore. Run with: `node src/flood/navcore.check.ts` */
import assert from "node:assert/strict";

import type { RouteStep } from "./contracts.ts";
import { along, bearing, cumulative, haversine, nextStep, segmentInside } from "./navcore.ts";

// ~111 m per 0.001 deg latitude
const line: [number, number][] = [[77.22, 28.63], [77.22, 28.631], [77.221, 28.631]];
const cum = cumulative(line);
assert.ok(Math.abs(cum[1] - 111.2) < 1, "north leg ~111 m");
assert.ok(Math.abs(bearing(line[0], line[1]) - 0) < 0.5, "due north");
assert.ok(Math.abs(bearing(line[1], line[2]) - 90) < 1, "due east");

const mid = along(line, cum, cum[1] / 2);
assert.ok(Math.abs(mid.point[1] - 28.6305) < 1e-6 && mid.heading < 1, "halfway up the first leg, heading north");
assert.deepEqual(along(line, cum, -50).point, line[0], "clamped at start");
assert.ok(haversine(along(line, cum, 1e9).point, line[2]) < 0.01, "clamped at end");

const step = (d: number, i: string): RouteStep => ({
  instruction: i, name: "", type: "turn", modifier: "left", location: [0, 0], distanceM: d, durationS: 0, lanes: null,
});
const steps = [step(100, "start"), step(200, "turn A"), step(0, "arrive")];
assert.deepEqual(nextStep(steps, 0), { index: 1, distanceToM: 100 });
assert.deepEqual(nextStep(steps, 60), { index: 1, distanceToM: 40 });
assert.deepEqual(nextStep(steps, 150), { index: 2, distanceToM: 150 });

// a box around the middle of the first leg: only points inside are kept
const ring: [number, number][] = [[77.219, 28.6302], [77.221, 28.6302], [77.221, 28.6308], [77.219, 28.6308], [77.219, 28.6302]];
const inside = segmentInside(line, ring);
assert.ok(inside.length > 5 && inside.every(([, lat]) => lat >= 28.6302 && lat <= 28.6308), "striped segment clipped to polygon");

console.log("navcore.check.ts: all assertions passed");

// --- project: GPS snapped to the route
import { project } from "./navcore.ts";
const onLeg = project(line, cum, [77.2201, 28.6305]); // ~10 m east of the first leg, halfway up
assert.ok(Math.abs(onLeg.travelled - cum[1] / 2) < 2 && onLeg.offM > 5 && onLeg.offM < 15, `snapped mid-leg, got ${JSON.stringify(onLeg)}`);
assert.ok(project(line, cum, [77.23, 28.64]).offM > 500, "far away is off route");
console.log("navcore.check.ts: project assertions passed");

// --- smoothFix: accuracy-weighted
import { smoothFix } from "./navcore.ts";
const a = { lon: 77.22, lat: 28.63, accuracyM: 5, t: 0 };
const noisy = smoothFix(a, { lon: 77.221, lat: 28.63, accuracyM: 80, t: 1000 }); // ~98 m east, vague
assert.ok(haversine([noisy.lon, noisy.lat], [a.lon, a.lat]) < 10, "a vague fix barely moves a precise estimate");
const sharp = smoothFix({ ...a, accuracyM: 60 }, { lon: 77.221, lat: 28.63, accuracyM: 5, t: 1000 });
assert.ok(haversine([sharp.lon, sharp.lat], [77.221, 28.63]) < 5, "a precise fix wins over a vague estimate");
assert.ok(noisy.accuracyM < 80 && noisy.accuracyM > 0, "uncertainty shrinks after fusing");
assert.deepEqual(smoothFix(a, { ...a, t: 60_000 }), { ...a, t: 60_000 }, "a long gap resets");
console.log("navcore.check.ts: smoothFix assertions passed");
