/** Self-check for the pothole log. Run with: `node src/potholeLog.check.ts` */
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
const { ahead, loadPotholes, loadWater, logPothole, logWater, WATER_TTL_MS } = await import("./potholeLog.ts");

const here: [number, number] = [77.2223, 28.6366];
const north = ahead(here, 0, 100);
assert.ok(Math.abs(north[1] - here[1] - 100 / 111_320) < 1e-9 && north[0] === here[0], "100 m north");
const east = ahead(here, 90, 100);
assert.ok(east[0] > here[0] && Math.abs(east[1] - here[1]) < 1e-9, "100 m east");

let list = logPothole([], { at: here, depthM: 0.04, severe: false, seen: 1 });
list = logPothole(list, { at: ahead(here, 45, 5), depthM: 0.09, severe: true, seen: 2 });
assert.equal(list.length, 1, "a second sighting 5 m away is the same pothole");
assert.equal(list[0].depthM, 0.09);
assert.equal(list[0].severe, true);
list = logPothole(list, { at: ahead(here, 0, 40), severe: false, seen: 3 });
assert.equal(list.length, 2, "40 m away is another pothole");
assert.equal(loadPotholes().length, 2, "persisted");
store.set("margsetu.potholes", "not json");
assert.deepEqual(loadPotholes(), [], "corrupt storage does not break the map");

let water = logWater([], { at: here, seen: 1000 });
water = logWater(water, { at: ahead(here, 90, 20), seen: 2000 });
assert.equal(water.length, 1, "water seen again 20 m away is the same spot");
water = logWater(water, { at: ahead(here, 0, 200), seen: 3000 });
assert.equal(water.length, 2, "200 m away is another spot");
assert.equal(loadWater(3000).length, 2, "water sightings persisted");
assert.equal(loadWater(2000 + WATER_TTL_MS).length, 1, "old sightings fade (waterlogging drains)");
store.set("margsetu.water", "{bad");
assert.deepEqual(loadWater(), [], "corrupt storage does not break the map");

console.log("potholeLog.check.ts: all assertions passed");
