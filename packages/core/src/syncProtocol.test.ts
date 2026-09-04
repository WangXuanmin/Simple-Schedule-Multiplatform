import assert from "node:assert/strict";
import test from "node:test";
import { uploadPendingWrites, pendingConflicts, type PendingWrite, type PendingStorage, type WriteResult } from "./syncProtocol.ts";
import { mergeTasks, type Task } from "./index.ts";

const task: Task = { id: "task", userId: "user", title: "first", deadlineAt: "2026-09-05T00:00:00Z", completedAt: null, deletedAt: null, urgency: "normal", createdAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z", version: 0 };
const write = (id: string, patch: Partial<PendingWrite> = {}): PendingWrite => ({ id, task, createdAt: task.createdAt, retryCount: 0, lastError: null, baseVersion: 0, ...patch });
function memory(initial: PendingWrite[]) {
  let writes = structuredClone(initial);
  const storage: PendingStorage = {
    getPendingTaskWrites: async () => structuredClone(writes),
    acknowledgePendingWrite: async (id, task) => {
      writes = writes.filter((write) => write.id !== id).map((write) => write.dependsOn === id ? { ...write, dependsOn: null, baseVersion: task.version } : write);
    },
    markPendingTaskWriteConflict: async (id, task, reason) => { writes = writes.map((write) => write.id === id ? { ...write, conflict: { task, reason } } : write); },
    markPendingTaskWriteFailed: async (id, retryCount, lastError) => { writes = writes.map((write) => write.id === id ? { ...write, retryCount, lastError } : write); }
  };
  return storage;
}

test("lost response retry keeps exact request identity and base before advancing dependent", async () => {
  const storage = memory([write("a"), write("b", { dependsOn: "a", baseVersion: null, task: { ...task, title: "second" } })]);
  const requests: string[] = [];
  let lost = false;
  const remote = { assertAccount: async () => {}, read: async () => null, write: async (write: PendingWrite): Promise<WriteResult> => {
    requests.push(`${write.id}:${write.baseVersion}`);
    if (!lost) { lost = true; throw new Error("response lost"); }
    return { status: write.id === "a" ? "duplicate" : "applied", task: { ...write.task, version: write.baseVersion! + 1 } };
  } };
  await assert.rejects(uploadPendingWrites("user", storage, remote), /response lost/);
  await uploadPendingWrites("user", storage, remote);
  assert.deepEqual(requests, ["a:0", "a:0", "b:1"]);
  assert.equal((await storage.getPendingTaskWrites("user")).length, 0);
});

test("conflict preserves latest draft, blocks descendants and allows unrelated task", async () => {
  const storage = memory([write("a"), write("b", { dependsOn: "a", baseVersion: null, task: { ...task, title: "latest" } }), write("c", { task: { ...task, id: "other" } })]);
  const called: string[] = [];
  await uploadPendingWrites("user", storage, { assertAccount: async () => {}, read: async () => null, write: async (write) => {
    called.push(write.id);
    return write.id === "a" ? { status: "conflict", task: { ...task, version: 5 } } : { status: "applied", task: { ...write.task, version: 1 } };
  } });
  assert.deepEqual(called, ["a", "c"]);
  const pending = await storage.getPendingTaskWrites("user");
  assert.equal(pending.length, 2);
  assert.equal(pendingConflicts(pending)[0].local.title, "latest");
});

test("legacy snapshots never acquire a fetched version and overwrite silently", async () => {
  const storage = memory([write("legacy", { baseVersion: null })]);
  await uploadPendingWrites("user", storage, { assertAccount: async () => {}, read: async () => ({ ...task, version: 9 }), write: async () => { throw new Error("must not upload legacy snapshot"); } });
  assert.equal(pendingConflicts(await storage.getPendingTaskWrites("user"))[0].remote?.version, 9);
});

test("higher server version wins over clock skew and stale tombstone", () => {
  const newer = { ...task, version: 3, updatedAt: "2000-01-01T00:00:00Z" };
  const older = { ...task, version: 2, updatedAt: "2099-01-01T00:00:00Z", deletedAt: "2099-01-01T00:00:00Z" };
  assert.deepEqual(mergeTasks([newer], [older]), [newer]);
});
