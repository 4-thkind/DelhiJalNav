/**
 * Self-check for the alert engine. Run with: `node src/hazards.check.ts`
 * (no test framework - the engine is the only non-obvious logic in the app,
 * and these are the properties that must never silently break).
 */
import assert from "node:assert/strict";

import { AlertEngine, DEFAULT_CAMERA, DEFAULT_CONFIG, estimateDistance, isInPath, severityOf } from "./hazards.ts";
import type { Detection } from "./types.ts";

const W = 1280;
const H = 720;
const cam = DEFAULT_CAMERA;

/** A box whose bottom edge sits at `bottomFrac` of the frame height. */
const box = (centreXFrac: number, bottomFrac: number, score = 0.8): Detection => ({
  x: centreXFrac * W - 60,
  y: bottomFrac * H - 80,
  w: 120,
  h: 80,
  score,
  cls: 0,
});

// --- distance ------------------------------------------------------------
assert.equal(estimateDistance(cam.horizonFrac * H, H, cam), Infinity, "at the horizon, distance is unbounded");
const near = estimateDistance(0.9 * H, H, cam);
const far = estimateDistance(0.55 * H, H, cam);
assert.ok(near < far, "lower in the frame must mean closer");
assert.ok(near > 1 && near < 4, `handlebar-mounted phone: bottom of frame is a couple of metres, got ${near}`);

// --- path relevance ------------------------------------------------------
assert.ok(isInPath(box(0.5, 0.9), W, H, cam), "dead ahead is in path");
assert.ok(!isInPath(box(0.05, 0.9), W, H, cam), "far kerb-side is not in path");
assert.ok(!isInPath(box(0.5, 0.3), W, H, cam), "above the horizon is not road");

// --- severity ------------------------------------------------------------
assert.equal(severityOf(0, 0.9, Infinity, DEFAULT_CONFIG), 0, "unknown distance carries no severity");
assert.equal(severityOf(0, 0.9, 60, DEFAULT_CONFIG), 0, "a hazard a minute away is not urgent");
assert.ok(
  severityOf(0, 0.9, 1, DEFAULT_CONFIG) > severityOf(0, 0.4, 1, DEFAULT_CONFIG),
  "a more confident detection is more severe",
);

// --- engine --------------------------------------------------------------
const engine = new AlertEngine();
const ahead = box(0.5, 0.55);
let t = 0;
const step = (dets: Detection[]) => engine.update(dets, W, H, 8, (t += 100));

assert.equal(step([ahead]).length, 0, "a single frame is never enough to warn");
assert.equal(step([ahead]).length, 0, "two frames is still not enough");
const fired = step([ahead]);
assert.equal(fired.length, 1, "warns once the track has persisted");
assert.match(fired[0].spoken, /pothole ahead, \d+ metres/, "announcement is speakable");
assert.equal(step([ahead]).length, 0, "the same hazard is never announced twice");

// a second, distinct hazard arriving inside the cooldown stays quiet
const other = box(0.52, 0.6);
engine.reset();
const a = box(0.5, 0.55);
t = 0;
for (let i = 0; i < 3; i++) step([a]);
const second = [step([a, other]), step([a, other]), step([a, other])].flat();
assert.equal(second.length, 0, "cooldown suppresses back-to-back announcements");

// hysteresis: a weak box never starts a track, but keeps a confirmed one alive
engine.reset();
t = 0;
for (let i = 0; i < 5; i++) step([box(0.3, 0.7, 0.3)]);
const weakOnly = engine.active.length; // a local: asserting on engine.active.length would narrow its type below
assert.equal(weakOnly, 0, "boxes below minScore never start a track");
engine.reset();
t = 0;
for (let i = 0; i < 3; i++) step([box(0.5, 0.55, 0.8)]);
const id = engine.active[0].id;
for (let i = 0; i < 8; i++) step([box(0.5, 0.55, 0.3)]); // blurred at speed: weaker, but the same pothole
assert.equal(engine.active[0]?.id, id, "a weak box keeps the confirmed track (not lost, not re-announced)");

// peripheral hazards are tracked but never announced
engine.reset();
const kerb = box(0.05, 0.9);
t = 0;
for (let i = 0; i < 10; i++) assert.equal(step([kerb]).length, 0, "kerb-side hazard stays silent");
assert.ok(engine.active.length === 1, "...but it is still tracked");

console.log("hazards.check.ts: all assertions passed");
