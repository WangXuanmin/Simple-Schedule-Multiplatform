import type { Task, TaskUrgency, PendingWrite, SyncConflict, WriteResult } from "@simple-schedule/core";
import { createSyncScheduler, fromDbTask, toDbTask, pendingConflicts, uploadPendingWrites, normalizeTaskUrgency } from "@simple-schedule/core";
import type { User } from "@supabase/supabase-js";
import {
  getLocalTasks,
  getPendingTaskWriteCount,
  getPendingTaskWrites,
  mergeLocalTasks,
  savePendingTaskWrite,
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

export type TaskInput = {
  title: string;
  deadlineAt: string;
  urgency: TaskUrgency;
};

export async function loadCachedTasks(user: User): Promise<Task[]> {
  return getLocalTasks(user.id);
}

export async function loadPendingWriteCount(user: User): Promise<number> {
  return getPendingTaskWriteCount(user.id);
}

export async function loadPendingTaskIds(user: User): Promise<string[]> {
  const writes = await getPendingTaskWrites(user.id);
  return writes.map((write) => write.taskId);
}

const scheduleSync = createSyncScheduler(async (userId) => performSync({ id: userId }));

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
  // Cache writes check pending records in the same SQL statement.
  await mergeLocalTasks((data ?? []).map(fromDbTask));
  const { data: capabilities, error: capabilityError } = await supabase.rpc("task_sync_capabilities_v1").abortSignal(AbortSignal.timeout(15000));
  if (capabilityError) throw capabilityError;
  const conflicts = pendingConflicts(await getPendingTaskWrites(user.id));
  const strictSync = capabilities?.strict === true;
  const syncedAt = new Date().toISOString();
  await setSyncMetadata(user.id, syncedAt);
  return {
    tasks: await getLocalTasks(user.id),
    syncedAt, conflicts, strictSync,
    pendingWriteCount: await getPendingTaskWriteCount(user.id)
  };
}

export async function createTask(user: User, input: TaskInput): Promise<Task[]> {
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID().toLowerCase(),
    userId: user.id.toLowerCase(),
    title: input.title,
    deadlineAt: input.deadlineAt,
    completedAt: null,
    deletedAt: null,
    urgency: normalizeTaskUrgency(input.urgency),
    createdAt: now,
    updatedAt: now,
    version: 0
  };

  await queueCloudWrite(task, user.id);
  return getLocalTasks(user.id);
}

export async function updateTask(user: User, task: Task, input: TaskInput): Promise<Task[]> {
  if (task.userId !== user.id) throw new Error("任务不属于当前账号");
  const updatedAt = new Date().toISOString();
  const nextTask: Task = {
    ...task,
    title: input.title,
    deadlineAt: input.deadlineAt,
    urgency: normalizeTaskUrgency(input.urgency),
    updatedAt
  };

  await queueCloudWrite(nextTask, user.id);
  return getLocalTasks(user.id);
}

export async function toggleTask(user: User, task: Task): Promise<Task[]> {
  if (task.userId !== user.id) throw new Error("任务不属于当前账号");
  const updatedAt = new Date().toISOString();
  const nextTask = task.completedAt
    ? { ...task, completedAt: null, updatedAt }
    : { ...task, completedAt: updatedAt, updatedAt };

  await queueCloudWrite(nextTask, user.id);
  return getLocalTasks(user.id);
}

export async function deleteTask(user: User, task: Task): Promise<Task[]> {
  if (task.userId !== user.id) throw new Error("任务不属于当前账号");
  const updatedAt = new Date().toISOString();
  const nextTask = { ...task, deletedAt: updatedAt, updatedAt };
  await queueCloudWrite(nextTask, user.id);
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

async function queueCloudWrite(task: Task, userId = task.userId): Promise<void> {
  await savePendingTaskWrite({ id: crypto.randomUUID(), userId, taskId: task.id,
    task: { ...task, userId }, createdAt: new Date().toISOString(), retryCount: 0, lastError: null });
}
