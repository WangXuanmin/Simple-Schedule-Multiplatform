import type { Task, TaskUrgency, PendingWrite, SyncConflict, WriteResult } from "@simple-schedule/core";
import { createSyncScheduler, fromDbTask, toDbTask, pendingConflicts, uploadPendingWrites, normalizeTaskUrgency } from "@simple-schedule/core";
import type { User } from "@supabase/supabase-js";
import {
  getLocalTasks,
  getPendingTaskWrites,
  saveTaskAndQueue,
  saveLocalTasks,
  setSyncMetadata
} from "./localDb";
import * as storage from "./localDb";
import { supabase } from "./supabase";

export type SyncResult = {
  tasks: Task[];
  syncedAt: string;
  pendingWriteCount: number;
  conflicts: SyncConflict[];
  strictSync: boolean;
};

export async function loadCachedTasks(user: User): Promise<Task[]> {
  const tasks = await getLocalTasks(user.id);
  return tasks.map(normalizeTask);
}

export async function loadPendingWriteCount(user: User): Promise<number> {
  return (await getPendingTaskWrites(user.id)).length;
}

const scheduleSync = createSyncScheduler(async (userId) => {
  // IndexedDB is shared between tabs; the upload lock must be shared as well.
  if (navigator.locks) return navigator.locks.request(`tasks-sync:${userId}`, () => performSync({ id: userId }));
  return performSync({ id: userId });
});

export function syncFromCloud(user: User): Promise<SyncResult> {
  return scheduleSync(user.id);
}

async function assertActiveAccount(userId: string): Promise<void> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (data.session?.user.id !== userId) throw new Error("登录状态已改变，请重新同步");
}

async function performSync(user: Pick<User, "id">): Promise<SyncResult> {
  await assertActiveAccount(user.id);
  await uploadPendingWrites(user.id, storage, {
    assertAccount: () => assertActiveAccount(user.id),
    write: writeCloudTask,
    read: async (taskId) => {
      const { data, error, status } = await supabase.from("tasks").select("*").eq("id", taskId).eq("user_id", user.id)
        .abortSignal(AbortSignal.timeout(15000)).maybeSingle();
      if (error) throw Object.assign(error, { status });
      return data ? fromDbTask(data) : null;
    }
  });

  const { data, error, status } = await supabase
    .from("tasks")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: true })
    .abortSignal(AbortSignal.timeout(15000));

  if (error) throw Object.assign(error, { status });

  await assertActiveAccount(user.id);
  const cloudTasks = (data ?? []).map(fromDbTask);
  const { data: capabilities, error: capabilityError } = await supabase.rpc("task_sync_capabilities_v1").abortSignal(AbortSignal.timeout(15000));
  if (capabilityError) throw capabilityError;
  const conflicts = pendingConflicts(await getPendingTaskWrites(user.id));
  const strictSync = capabilities?.strict === true;
  const syncedAt = new Date().toISOString();
  await saveLocalTasks(cloudTasks);
  await setSyncMetadata(user.id, { lastSyncAt: syncedAt });
  return { tasks: await getLocalTasks(user.id), syncedAt, conflicts, strictSync, pendingWriteCount: (await getPendingTaskWrites(user.id)).length };
}

export async function createTask(user: User, title: string, deadlineAt: string): Promise<Task[]> {
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    userId: user.id,
    title,
    deadlineAt,
    completedAt: null,
    deletedAt: null,
    urgency: "normal",
    createdAt: now,
    updatedAt: now,
    version: 0
  };

  await saveTaskAndQueue(task);
  return getLocalTasks(user.id);
}

export async function toggleTask(user: User, task: Task): Promise<Task[]> {
  if (task.userId !== user.id) throw new Error("任务不属于当前账号");
  const updatedAt = new Date().toISOString();
  const nextTask = task.completedAt
    ? { ...task, completedAt: null, updatedAt }
    : { ...task, completedAt: updatedAt, updatedAt };

  await saveTaskAndQueue(nextTask);
  return getLocalTasks(user.id);
}

export async function deleteTask(user: User, task: Task): Promise<Task[]> {
  if (task.userId !== user.id) throw new Error("任务不属于当前账号");
  const updatedAt = new Date().toISOString();
  const nextTask = { ...task, deletedAt: updatedAt, updatedAt };
  await saveTaskAndQueue(nextTask);
  return getLocalTasks(user.id);
}

async function writeCloudTask(write: PendingWrite): Promise<WriteResult> {
  const { data, error, status } = await supabase.rpc("write_task_v1", {
    p_request_id: write.id, p_base_version: write.baseVersion, p_task: toDbTask(write.task)
  }).abortSignal(AbortSignal.timeout(15000));
  if (error) throw Object.assign(error, { status });
  if (!data || !["applied", "duplicate", "conflict"].includes(data.status)) throw new Error("无效的同步响应");
  if (data.status === "conflict") return { status: "conflict", task: data.task ? fromDbTask(data.task) : null };
  if (!data.task) throw new Error("云端确认缺少任务");
  return { status: data.status, task: fromDbTask(data.task) };
}

export async function loadConflicts(user: User): Promise<SyncConflict[]> {
  return pendingConflicts(await getPendingTaskWrites(user.id));
}

export async function resolveConflict(user: User, requestId: string, copy: boolean): Promise<Task[]> {
  await storage.resolvePendingConflict(user.id, requestId, copy);
  return getLocalTasks(user.id);
}

function normalizeTask(task: Task): Task {
  return { ...task, urgency: normalizeTaskUrgency(task.urgency) };
}
