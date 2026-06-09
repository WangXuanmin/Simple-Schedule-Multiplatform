import assert from "node:assert/strict";
import test from "node:test";
import { mergeTasks, type Task } from "./index.ts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    userId: "user-1",
    title: "Original",
    deadlineAt: "2026-06-09T10:00:00.000Z",
    completedAt: null,
    deletedAt: null,
    urgency: "normal",
    createdAt: "2026-06-09T08:00:00.000Z",
    updatedAt: "2026-06-09T08:00:00.000Z",
    ...overrides
  };
}

test("mergeTasks keeps the newest snapshot for the same task", () => {
  const merged = mergeTasks(
    [task({ title: "Old", updatedAt: "2026-06-09T08:00:00.000Z" })],
    [task({ title: "New", updatedAt: "2026-06-09T09:00:00.000Z" })]
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.title, "New");
});

test("mergeTasks does not revive deleted tasks with older snapshots", () => {
  const deleted = task({
    deletedAt: "2026-06-09T09:00:00.000Z",
    updatedAt: "2026-06-09T09:00:00.000Z"
  });
  const staleLive = task({ updatedAt: "2026-06-09T08:30:00.000Z" });

  const merged = mergeTasks([deleted], [staleLive]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.deletedAt, deleted.deletedAt);
});
