import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mergeTasks } from "../packages/core/src/index.ts";

// The previous array findIndex + slice implementation, kept only as a
// reproducible benchmark reference. Use identical inputs and compare outputs.
function previousMerge(...groups) {
  return groups.flat().reduce((merged, incoming) => {
    const index = merged.findIndex((task) => task.id === incoming.id);
    if (index === -1) return [...merged, incoming];
    const next = merged.slice();
    const current = next[index];
    next[index] = current.deletedAt && !incoming.deletedAt ? current
      : incoming.deletedAt && !current.deletedAt ? incoming
      : Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt) ? incoming : current;
    return next;
  }, []);
}
function medianTime(fn) {
  fn();
  const samples = Array.from({ length: 7 }, () => {
    const start = performance.now(); fn(); return performance.now() - start;
  }).sort((a, b) => a - b);
  return Number(samples[3].toFixed(3));
}
console.log(`Node ${process.version}; 7 samples after warmup; median milliseconds; local merge only`);
for (const size of [100, 1000, 5000]) {
  const initial = Array.from({ length: size }, (_, id) => ({
    id: `task-${id}`, userId: "user", title: "original", deadlineAt: "2026-09-04T10:00:00Z",
    completedAt: null, deletedAt: null, urgency: "normal", createdAt: "2026-09-04T09:00:00Z", updatedAt: "2026-09-04T09:00:00Z"
  }));
  const updates = initial.map((task, index) => ({ ...task, title: "updated", updatedAt: "2026-09-04T09:30:00Z", deletedAt: index % 11 ? null : "2026-09-04T09:30:00Z" }));
  assert.deepEqual(mergeTasks(initial, updates), previousMerge(initial, updates));
  console.log(JSON.stringify({ tasks: size, inputSnapshots: size * 2, beforeMs: medianTime(() => previousMerge(initial, updates)), afterMs: medianTime(() => mergeTasks(initial, updates)) }));
}
