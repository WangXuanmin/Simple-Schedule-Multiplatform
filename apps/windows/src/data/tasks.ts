import type { Task, TaskUrgency } from "@simple-schedule/core";
import { applyTaskOperation, mergeTasks, normalizeTaskUrgency } from "@simple-schedule/core";
import type { User } from "@supabase/supabase-js";
import {
  deletePendingTaskWrite,
  getLocalTasks,
  getPendingTaskWriteCount,
  getPendingTaskWrites,
  markPendingTaskWriteFailed,
  mergeLocalTasks,
  saveLocalTask,
  savePendingTaskWrite,
  setSyncMetadata,
  type PendingTaskWrite
} from "./localDb";
import { supabase } from "./supabase";

type DbTask = {
  id: string;
  user_id: string;
  title: string;
  deadline_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  urgency?: TaskUrgency | string | null;
  created_at: string;
  updated_at: string;
};

export type SyncResult = {
  tasks: Task[];
  syncedAt: string;
  pendingWriteCount: number;
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

export async function syncFromCloud(user: User): Promise<SyncResult> {
  await flushPendingWrites(user);

  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: true });

  if (error) throw error;

  const cloudTasks = (data ?? []).map(fromDbTask);
  const localTasks = await getLocalTasks(user.id);
  const pendingWrites = await getPendingTaskWrites(user.id);
  const pendingTasks = pendingWrites.map((write) => write.task);
  const tasks = mergeTasks(cloudTasks, localTasks, pendingTasks);
  const syncedAt = new Date().toISOString();
  await mergeLocalTasks(tasks);
  await setSyncMetadata(syncedAt);

  return {
    tasks,
    syncedAt,
    pendingWriteCount: await getPendingTaskWriteCount(user.id)
  };
}

export async function createTask(user: User, input: TaskInput, currentTasks: Task[]): Promise<Task[]> {
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
    updatedAt: now
  };

  await saveLocalTask(task);
  await queueCloudWrite(task, user.id);
  return applyTaskOperation(currentTasks, { type: "task.create", task });
}

export async function updateTask(user: User, task: Task, input: TaskInput, currentTasks: Task[]): Promise<Task[]> {
  const updatedAt = new Date().toISOString();
  const nextTask: Task = {
    ...task,
    title: input.title,
    deadlineAt: input.deadlineAt,
    urgency: normalizeTaskUrgency(input.urgency),
    updatedAt
  };

  await saveLocalTask(nextTask);
  await queueCloudWrite(nextTask, user.id);
  return applyTaskOperation(currentTasks, {
    type: "task.update",
    taskId: task.id,
    patch: {
      title: nextTask.title,
      deadlineAt: nextTask.deadlineAt,
      urgency: nextTask.urgency
    },
    updatedAt
  });
}

export async function toggleTask(user: User, task: Task, currentTasks: Task[]): Promise<Task[]> {
  const updatedAt = new Date().toISOString();
  const nextTask = task.completedAt
    ? { ...task, completedAt: null, updatedAt }
    : { ...task, completedAt: updatedAt, updatedAt };

  await saveLocalTask(nextTask);
  await queueCloudWrite(nextTask, user.id);
  return applyTaskOperation(
    currentTasks,
    task.completedAt
      ? { type: "task.reopen", taskId: task.id, updatedAt }
      : { type: "task.complete", taskId: task.id, completedAt: updatedAt, updatedAt }
  );
}

export async function deleteTask(user: User, task: Task, currentTasks: Task[]): Promise<Task[]> {
  const updatedAt = new Date().toISOString();
  const nextTask = { ...task, deletedAt: updatedAt, updatedAt };
  await saveLocalTask(nextTask);
  await queueCloudWrite(nextTask, user.id);
  return applyTaskOperation(currentTasks, {
    type: "task.delete",
    taskId: task.id,
    deletedAt: updatedAt,
    updatedAt
  });
}

async function flushPendingWrites(user: User): Promise<void> {
  const writes = await getPendingTaskWrites(user.id);
  for (const write of writes) {
    try {
      await upsertCloudTask(write.task, user.id);
      await deletePendingTaskWrite(write.id);
    } catch (error) {
      await markPendingTaskWriteFailed(
        write.id,
        write.retryCount + 1,
        error instanceof Error ? error.message : "Cloud write failed"
      );
    }
  }
}

async function queueCloudWrite(task: Task, userId = task.userId): Promise<void> {
  const write = createPendingWrite(task, userId);
  await savePendingTaskWrite(write);
  void uploadPendingWrite(write).catch(() => undefined);
}

async function uploadPendingWrite(write: PendingTaskWrite): Promise<void> {
  if (!(await isCurrentPendingWrite(write))) return;
  try {
    await upsertCloudTask(write.task, write.userId);
    if (await isCurrentPendingWrite(write)) {
      await deletePendingTaskWrite(write.id);
    }
  } catch (error) {
    if (await isCurrentPendingWrite(write)) {
      await markPendingTaskWriteFailed(
        write.id,
        write.retryCount + 1,
        error instanceof Error ? error.message : "Cloud write failed"
      );
    }
  }
}

async function isCurrentPendingWrite(write: PendingTaskWrite): Promise<boolean> {
  const writes = await getPendingTaskWrites(write.userId);
  return writes.some((current) => current.id === write.id);
}

async function upsertCloudTask(task: Task, userId = task.userId): Promise<void> {
  const { data: existing, error: readError } = await supabase
    .from("tasks")
    .select("updated_at")
    .eq("id", task.id.toLowerCase())
    .maybeSingle<{ updated_at: string }>();
  if (readError) throw readError;
  if (existing && new Date(existing.updated_at).getTime() > new Date(task.updatedAt).getTime()) return;

  const { error } = await supabase.from("tasks").upsert(toDbTask({ ...task, userId }), { onConflict: "id" });
  if (error) throw error;
}

function createPendingWrite(task: Task, userId = task.userId): PendingTaskWrite {
  return {
    id: `${task.id}:${task.updatedAt}`,
    userId,
    taskId: task.id,
    task: { ...task, userId },
    createdAt: new Date().toISOString(),
    retryCount: 0,
    lastError: null
  };
}

function fromDbTask(task: DbTask): Task {
  return {
    id: task.id.toLowerCase(),
    userId: task.user_id.toLowerCase(),
    title: task.title,
    deadlineAt: task.deadline_at,
    completedAt: task.completed_at,
    deletedAt: task.deleted_at,
    urgency: normalizeTaskUrgency(task.urgency),
    createdAt: task.created_at,
    updatedAt: task.updated_at
  };
}

function toDbTask(task: Task): DbTask {
  return {
    id: task.id.toLowerCase(),
    user_id: task.userId.toLowerCase(),
    title: task.title,
    deadline_at: task.deadlineAt,
    completed_at: task.completedAt,
    deleted_at: task.deletedAt,
    urgency: normalizeTaskUrgency(task.urgency),
    created_at: task.createdAt,
    updated_at: task.updatedAt
  };
}
