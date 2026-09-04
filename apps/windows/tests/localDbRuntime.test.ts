import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { Task } from "@simple-schedule/core";

test("production storage upgrades an old database without losing its offline edits", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const previousWindow = globalThis.window;
  const task: Task = { id: "legacy-task", userId: "owner", title: "offline edit", urgency: "normal",
    deadlineAt: "2026-09-05T09:00:00Z", createdAt: "2026-09-04T09:00:00Z",
    updatedAt: "2026-09-04T09:00:00Z", completedAt: null, deletedAt: null };
  sqlite.exec(`create table tasks (id text primary key, user_id text not null, title text not null,
    deadline_at text not null, completed_at text, deleted_at text, urgency text not null,
    created_at text not null, updated_at text not null);
    create table pending_task_writes (id text primary key, user_id text not null, task_id text not null,
    task_json text not null, created_at text not null, retry_count integer not null default 0, last_error text);`);
  sqlite.prepare("insert into tasks values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(task.id, task.userId, task.title,
    task.deadlineAt, null, null, task.urgency, task.createdAt, task.updatedAt);
  sqlite.prepare("insert into pending_task_writes values (?, ?, ?, ?, ?, ?, ?)").run(
    "legacy-request", task.userId, task.id, JSON.stringify(task), task.updatedAt, 2, "offline");
  // Exercise the installed SQL plugin and production migration/storage code.
  // Only the native IPC transport is replaced with a real SQLite connection.
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: async (command: string, args: { db: string; query: string; values: unknown[] }) => {
      if (command === "plugin:sql|load") return args.db;
      const statement = sqlite.prepare(args.query);
      const values = Object.fromEntries((args.values ?? []).map((value, index) => [`$${index + 1}`, value]));
      if (command === "plugin:sql|select") return statement.all(values);
      if (command === "plugin:sql|execute") {
        const result = statement.run(values);
        return [Number(result.changes), Number(result.lastInsertRowid)];
      }
      throw new Error(`Unexpected command ${command}`);
    } }
  } });
  try {
    const storage = await import("../src/data/localDb.ts");
    assert.deepEqual(await storage.getLocalTasks(task.userId), [{ ...task, version: undefined }]);
    const legacy = (await storage.getPendingTaskWrites(task.userId))[0];
    assert.equal(legacy.baseVersion, null);
    assert.equal(legacy.retryCount, 2);
    assert.deepEqual(legacy.task, task);

    await storage.markPendingTaskWriteConflict(legacy.id, { ...task, title: "cloud", version: 4 }, "legacy baseline unknown");
    await storage.resolvePendingConflict(task.userId, legacy.id, true);
    const pending = await storage.getPendingTaskWrites(task.userId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].baseVersion, 0);
    assert.equal(pending[0].task.title, "offline edit（本地副本）");
    assert.equal((await storage.getLocalTasks(task.userId)).find((item) => item.id === task.id)?.title, "cloud");
    await storage.acknowledgePendingWrite(pending[0].id, { ...pending[0].task, version: 1 });
    assert.equal(await storage.getPendingTaskWriteCount(task.userId), 0);
    assert.equal((await storage.getLocalTasks(task.userId)).find((item) => item.id === pending[0].task.id)?.version, 1);
  } finally {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    sqlite.close();
  }
});
