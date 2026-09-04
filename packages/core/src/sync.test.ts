import assert from "node:assert/strict";
import test from "node:test";
import { createSyncScheduler, errorMessage, isRetryableSyncError, syncRetryDelay } from "./sync.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("bursts during sync coalesce into one follow-up without overlap", async () => {
  const gate = deferred();
  let calls = 0;
  let running = 0;
  let peak = 0;
  const schedule = createSyncScheduler(async () => {
    calls++;
    peak = Math.max(peak, ++running);
    await gate.promise;
    running--;
    return calls;
  });
  const first = schedule("a");
  await Promise.resolve();
  const burst = Array.from({ length: 30 }, () => schedule("a"));
  gate.resolve();
  assert.deepEqual(await Promise.all([first, ...burst]), Array(31).fill(2));
  assert.equal(peak, 1);
  assert.equal(calls, 2);
});

test("a failed pass stops coalesced retries and releases its account", async () => {
  const gate = deferred();
  let calls = 0;
  const schedule = createSyncScheduler(async () => {
    calls++;
    await gate.promise;
    if (calls === 1) throw new Error("offline");
    return calls;
  });
  const first = schedule("a");
  await Promise.resolve();
  const second = schedule("a");
  gate.resolve();
  await assert.rejects(first, /offline/);
  await assert.rejects(second, /offline/);
  assert.equal(calls, 1);
  assert.equal(await schedule("a"), 2);
});

test("different accounts do not share promises or results", async () => {
  const gate = deferred();
  const schedule = createSyncScheduler(async (id) => { if (id === "a") await gate.promise; return id; });
  const first = schedule("a");
  assert.equal(await schedule("b"), "b");
  gate.resolve();
  assert.equal(await first, "a");
});

test("only transient failures retry, with a finite exponential schedule", () => {
  for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(isRetryableSyncError({ status }), false);
  for (const status of [429, 500, 502, 503]) assert.equal(isRetryableSyncError({ status }), true);
  assert.equal(isRetryableSyncError(new TypeError("Failed to fetch")), true);
  assert.equal(isRetryableSyncError(new Error("permission denied")), false);
  assert.equal(isRetryableSyncError({ name: "TimeoutError" }), true);
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => syncRetryDelay(i)), [1000, 2000, 4000, 8000, 16000, null, null]);
  assert.equal(errorMessage({ message: "permission denied" }), "permission denied");
});
