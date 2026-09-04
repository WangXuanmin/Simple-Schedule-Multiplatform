import type { Task } from "./index.ts";
import { errorMessage } from "./sync.ts";

export type PendingWrite = {
  id: string;
  task: Task;
  createdAt: string;
  retryCount: number;
  lastError: string | null;
  baseVersion?: number | null;
  dependsOn?: string | null;
  conflict?: { task: Task | null; reason: string } | null;
};
export type SyncConflict = { requestId: string; local: Task; remote: Task | null; reason: string };
export type WriteResult = { status: "applied" | "duplicate"; task: Task } | { status: "conflict"; task: Task | null };
export type PendingStorage = {
  getPendingTaskWrites(userId: string): Promise<PendingWrite[]>;
  acknowledgePendingWrite(id: string, task: Task): Promise<void>;
  markPendingTaskWriteConflict(id: string, remote: Task | null, reason: string): Promise<void>;
  markPendingTaskWriteFailed(id: string, retries: number, message: string): Promise<void>;
};

export function pendingConflicts(writes: PendingWrite[]): SyncConflict[] {
  const conflicts = new Map<string, SyncConflict>();
  for (const write of writes) {
    if (write.conflict) conflicts.set(write.task.id, { requestId: write.id, local: write.task, remote: write.conflict.task, reason: write.conflict.reason });
    const conflict = conflicts.get(write.task.id);
    if (conflict) conflict.local = write.task;
  }
  return [...conflicts.values()];
}

export async function uploadPendingWrites(userId: string, storage: PendingStorage, remote: {
  assertAccount(): Promise<void>;
  write(write: PendingWrite): Promise<WriteResult>;
  read(taskId: string): Promise<Task | null>;
}): Promise<void> {
  const writes = await storage.getPendingTaskWrites(userId);
  const blocked = new Set<string>();
  for (const write of writes) {
    if (write.task.userId !== userId) throw new Error("待同步记录账号不匹配");
    if (write.conflict || blocked.has(write.task.id)) { blocked.add(write.task.id); continue; }
    if (write.dependsOn) continue;
    await remote.assertAccount();
    try {
      if (write.baseVersion === null || write.baseVersion === undefined) {
        await storage.markPendingTaskWriteConflict(write.id, await remote.read(write.task.id), "旧版离线修改缺少基准版本，请选择云端内容或另存本地副本");
        blocked.add(write.task.id);
        continue;
      }
      const result = await remote.write(write);
      if (result.status === "conflict") {
        await storage.markPendingTaskWriteConflict(write.id, result.task, "其他设备已修改此任务，本地内容已保留");
        blocked.add(write.task.id);
        continue;
      }
      if (result.task.id !== write.task.id || result.task.userId !== userId ||
          result.task.version !== write.baseVersion + 1) throw new Error("云端确认与请求不匹配");
      await storage.acknowledgePendingWrite(write.id, result.task);
      // Only a not-yet-sent dependent gets the predecessor's confirmed version.
      for (const next of writes) {
        if (next.dependsOn === write.id) { next.dependsOn = null; next.baseVersion = result.task.version; }
      }
    } catch (error) {
      await storage.markPendingTaskWriteFailed(write.id, write.retryCount + 1, errorMessage(error));
      throw error;
    }
  }
}

export type DbTask = {
  id: string; user_id: string; title: string; deadline_at: string;
  completed_at: string | null; deleted_at: string | null; urgency?: string;
  created_at: string; updated_at: string; version?: number;
};
export function fromDbTask(task: DbTask): Task {
  return { id: task.id.toLowerCase(), userId: task.user_id.toLowerCase(), title: task.title,
    deadlineAt: task.deadline_at, completedAt: task.completed_at, deletedAt: task.deleted_at,
    urgency: task.urgency === "rush" || task.urgency === "urgent" ? task.urgency : "normal",
    createdAt: task.created_at, updatedAt: task.updated_at, version: task.version };
}
export function toDbTask(task: Task): Omit<DbTask, "version"> {
  return { id: task.id, user_id: task.userId, title: task.title, deadline_at: task.deadlineAt,
    completed_at: task.completedAt, deleted_at: task.deletedAt, urgency: task.urgency,
    created_at: task.createdAt, updated_at: task.updatedAt };
}

export function localConflictCopy(task: Task): Task {
  const now = new Date().toISOString();
  return { ...task, id: crypto.randomUUID(), title: `${task.title}（本地副本）`,
    completedAt: null, deletedAt: null, version: 0, createdAt: now, updatedAt: now };
}
