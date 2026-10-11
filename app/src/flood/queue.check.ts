/**
 * Self-check for the report outbox. Run with: `node src/flood/queue.check.ts`
 * Covers the client half of E03/E15/U04: retries reuse one event ID, a delayed
 * send keeps its original observedAt, sign-in failures keep the report.
 */
import assert from "node:assert/strict";

import type { ObservationRequest, ObservationResult } from "./contracts.ts";
import { MemoryStorage, Outbox, type OutboxRecord } from "./queue.ts";

let clock = 1_000_000;
const now = () => clock;
const body = (id: string): ObservationRequest => ({
  schemaVersion: "1.0",
  eventId: id,
  hotspotId: "MINTO_BRIDGE",
  kind: "WATER_OBSERVED",
  observedAt: "2026-10-10T06:00:00Z",
  location: { source: "selected_hotspot", accuracyM: null },
  description: null,
  clientMode: "LOCAL_DEMO",
});
const ok = (r: OutboxRecord, duplicate = false): ObservationResult => ({
  eventId: r.eventId, duplicate, hotspotId: r.body.hotspotId, revision: 1, state: "REPORTED",
  reasonCode: "SINGLE_FRESH_REPORT", receivedAt: "2026-10-10T06:30:00Z", provenance: "SYNTHETIC_DEMO",
});
const fail = (status: number, code: string, retryable = false) => Object.assign(new Error(code), { status, code, retryable });

// --- network failure: kept, backed off, same event ID and observedAt on retry
const seen: OutboxRecord[] = [];
let mode: "down" | "up" | "auth" | "invalid" = "down";
const storage = new MemoryStorage();
const outbox = new Outbox(storage, async (r) => {
  seen.push(structuredClone(r));
  if (mode === "down") throw fail(0, "NETWORK", true);
  if (mode === "auth") throw fail(401, "AUTH_REQUIRED");
  if (mode === "invalid") throw fail(422, "UNKNOWN_HOTSPOT");
  return ok(r, seen.length > 2);
}, now, () => 0.5);

await outbox.add(body("e-1"), "demo-a");
assert.deepEqual(await outbox.flush(), [], "nothing acknowledged while offline");
let [pending] = await outbox.pending();
assert.equal(pending.status, "waiting_retry");
assert.ok(pending.retryAfter > clock, "backs off instead of hammering");

assert.deepEqual(await outbox.flush(), [], "not retried before its retry time");
assert.equal(seen.length, 1);

clock = pending.retryAfter + 1;
mode = "up";
const [done] = await outbox.flush();
assert.equal(done.kind, "accepted");
assert.equal(seen.length, 2);
assert.equal(seen[0].eventId, seen[1].eventId, "a retry reuses the event ID (server idempotency)");
assert.equal(seen[1].body.observedAt, "2026-10-10T06:00:00Z", "a delayed send never refreshes its age");
assert.equal((await outbox.pending()).length, 0, "removed only after acknowledgement");

// --- single flight: concurrent flushes share one pass, one send per record
await outbox.add(body("e-2"), "demo-a");
const before = seen.length;
await Promise.all([outbox.flush(), outbox.flush(), outbox.flush()]);
assert.equal(seen.length - before, 1, "concurrent flushes must not double-send");

// --- expired sign-in keeps the report and says so
mode = "auth";
await outbox.add(body("e-3"), "demo-a");
await outbox.flush();
[pending] = await outbox.pending();
assert.equal(pending.status, "needs_sign_in");

// --- invalid content is dropped and reported, never retried forever
mode = "invalid";
await outbox.remove("e-3");
await outbox.add(body("e-4"), "demo-a");
const [rejected] = await outbox.flush();
assert.deepEqual([rejected.kind, rejected.kind === "rejected" && rejected.code], ["rejected", "UNKNOWN_HOTSPOT"]);
assert.equal((await outbox.pending()).length, 0);

// --- bounded size
for (let i = 0; i < 50; i++) await storage.put({ ...pending, eventId: "fill-" + i });
await assert.rejects(outbox.add(body("overflow"), "demo-a"), /OUTBOX_FULL/);

console.log("queue.check.ts: all assertions passed");
