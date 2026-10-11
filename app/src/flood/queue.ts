/**
 * Durable report outbox.
 *
 * The event ID is created before a report is queued and never changes, so a
 * retry after a lost response is recognised by the server as the same report
 * (idempotency), and a delayed upload keeps its original observedAt - it can
 * never "refresh" its age on reconnect. A record leaves the queue only after
 * the server acknowledges that event, or rejects it as invalid.
 */
import type { ObservationRequest, ObservationResult } from "./contracts.ts";

export type OutboxStatus = "queued" | "sending" | "waiting_retry" | "needs_sign_in";

export interface OutboxRecord {
  eventId: string;
  body: ObservationRequest;
  contributor: string;
  createdAt: number;
  attempts: number;
  retryAfter: number;
  status: OutboxStatus;
  lastError?: string;
}

export interface OutboxStorage {
  all(): Promise<OutboxRecord[]>;
  put(record: OutboxRecord): Promise<void>;
  delete(eventId: string): Promise<void>;
}

/** What the sender reports back; mirrors ApiFailure without importing fetch code. */
export interface SendFailure {
  status: number;
  code: string;
  retryable: boolean;
}

export type Outcome =
  | { eventId: string; kind: "accepted" | "duplicate"; result: ObservationResult }
  | { eventId: string; kind: "rejected"; code: string };

export const MAX_ITEMS = 50;

export class Outbox {
  private flushing: Promise<Outcome[]> | undefined;
  private store: OutboxStorage;
  private send: (record: OutboxRecord) => Promise<ObservationResult>;
  private now: () => number;
  private random: () => number;

  // plain fields, not parameter properties, so node can run the check without a build
  constructor(
    store: OutboxStorage,
    send: (record: OutboxRecord) => Promise<ObservationResult>,
    now: () => number = Date.now,
    random: () => number = Math.random,
  ) {
    this.store = store;
    this.send = send;
    this.now = now;
    this.random = random;
  }

  async add(body: ObservationRequest, contributor: string): Promise<OutboxRecord> {
    const existing = await this.store.all();
    if (existing.length >= MAX_ITEMS) throw new Error("OUTBOX_FULL");
    const record: OutboxRecord = {
      eventId: body.eventId,
      body,
      contributor,
      createdAt: this.now(),
      attempts: 0,
      retryAfter: 0,
      status: "queued",
    };
    await this.store.put(record);
    return record;
  }

  pending(): Promise<OutboxRecord[]> {
    return this.store.all();
  }

  remove(eventId: string): Promise<void> {
    return this.store.delete(eventId);
  }

  /** Single-flight: concurrent callers share one pass over the queue. */
  flush(): Promise<Outcome[]> {
    this.flushing ??= this.drain().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async drain(): Promise<Outcome[]> {
    const outcomes: Outcome[] = [];
    const records = (await this.store.all()).sort((a, b) => a.createdAt - b.createdAt);
    for (const record of records) {
      if (record.retryAfter > this.now()) continue;
      record.status = "sending";
      record.attempts += 1;
      await this.store.put(record);
      try {
        const result = await this.send(record);
        await this.store.delete(record.eventId);
        outcomes.push({ eventId: record.eventId, kind: result.duplicate ? "duplicate" : "accepted", result });
      } catch (err) {
        const failure = err as SendFailure;
        if (failure.status === 401) {
          // expired or missing sign-in: keep the report, explain, do not burn retries
          record.status = "needs_sign_in";
          record.lastError = failure.code;
          await this.store.put(record);
        } else if (failure.retryable || failure.status === 0 || failure.status === 429 || failure.status >= 500) {
          const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(record.attempts, 6));
          record.retryAfter = this.now() + backoff * (0.75 + 0.5 * this.random());
          record.status = "waiting_retry";
          record.lastError = failure.code;
          await this.store.put(record);
        } else {
          // invalid content will never succeed; drop it and tell the user why
          await this.store.delete(record.eventId);
          outcomes.push({ eventId: record.eventId, kind: "rejected", code: failure.code });
        }
      }
    }
    return outcomes;
  }
}

/** Memory storage: tests, and the fallback when IndexedDB is unavailable. */
export class MemoryStorage implements OutboxStorage {
  private items = new Map<string, OutboxRecord>();
  async all() {
    return [...this.items.values()].map((r) => structuredClone(r));
  }
  async put(record: OutboxRecord) {
    this.items.set(record.eventId, structuredClone(record));
  }
  async delete(eventId: string) {
    this.items.delete(eventId);
  }
}

/** IndexedDB storage. Any failure to open falls back to memory, visibly, via `durable`. */
export class IdbStorage implements OutboxStorage {
  private db: Promise<IDBDatabase>;
  private storeName: string;
  constructor(name = "dillijalnav-edge", storeName = "outbox") {
    this.storeName = storeName;
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(storeName, { keyPath: "eventId" });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  private async tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const request = run(db.transaction(this.storeName, mode).objectStore(this.storeName));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  }
  async all() {
    const rows = await this.tx<unknown[]>("readonly", (s) => s.getAll());
    // corrupt or old-schema rows are skipped instead of crashing the app (U02)
    return rows.filter(
      (r): r is OutboxRecord =>
        !!r && typeof (r as OutboxRecord).eventId === "string" && (r as OutboxRecord).body?.schemaVersion === "1.0",
    );
  }
  async put(record: OutboxRecord) {
    await this.tx("readwrite", (s) => s.put(record));
  }
  async delete(eventId: string) {
    await this.tx("readwrite", (s) => s.delete(eventId));
  }
}

export async function openStorage(): Promise<{ storage: OutboxStorage; durable: boolean }> {
  try {
    const storage = new IdbStorage();
    await storage.all();
    return { storage, durable: true };
  } catch {
    return { storage: new MemoryStorage(), durable: false };
  }
}
