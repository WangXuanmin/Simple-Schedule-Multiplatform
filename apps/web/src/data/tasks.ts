import type { Task } from "@simple-schedule/core";
import { applyTaskOperation } from "@simple-schedule/core";
import type { User } from "@supabase/supabase-js";
import {
  deletePendingTaskWrite,
  getLocalTasks,
  getPendingTaskWrites,
  saveLocalTask,
  saveLocalTasks,
  savePendingTaskWrite,
  setSyncMetadata
} from "./localDb";
import { supabase } from "./supabase";

type DbTask = {
  id: string;
  user_id: string;
  title: string;
  deadline_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SyncResult = {
  tasks: Task[];
  syncedAt: string;
};

export async function loadCachedTasks(user: User): Promise<Task[]> {
  return getLocalTasks(user.id);
}

export async function syncFromCloud(user: User): Promise<SyncResult> {
  await flushPendingWrites(user);

  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: true });

  if (error) throw error;

  const tasks = (data ?? []).map(fromDbTask);
  const syncedAt = new Date().toISOString();
  await saveLocalTasks(tasks);
  await setSyncMetadata({ lastSyncAt: syncedAt });
  return { tasks, syncedAt };
}

export async function createTask(user: User, title: string, deadlineAt: string, currentTasks: Task[]): Promise<Task[]> {
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(),
    userId: user.id,
    title,
    deadlineAt,
    completedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now
  };

  await saveLocalTask(task);
  await tryCloudWrite(task);
  return applyTaskOperation(currentTasks, { type: "task.create", task });
}

export async function toggleTask(user: User, task: Task, currentTasks: Task[]): Promise<Task[]> {
  const updatedAt = new Date().toISOString();
  const nextTask = task.completedAt
    ? { ...task, completedAt: null, updatedAt }
    : { ...task, completedAt: updatedAt, updatedAt };

  await saveLocalTask(nextTask);
  await tryCloudWrite(nextTask, user.id);
  return applyTaskOperation(currentTasks, task.completedAt
    ? { type: "task.reopen", taskId: task.id, updatedAt }
    : { type: "task.complete", taskId: task.id, completedAt: updatedAt, updatedAt });
}

export async function deleteTask(user: User, task: Task, currentTasks: Task[]): Promise<Task[]> {
  const updatedAt = new Date().toISOString();
  const nextTask = { ...task, deletedAt: updatedAt, updatedAt };
  await saveLocalTask(nextTask);
  await tryCloudWrite(nextTask, user.id);
  return applyTaskOperation(currentTasks, {
    type: "task.delete",
    taskId: task.id,
    deletedAt: updatedAt,
    updatedAt
  });
}

async function upsertCloudTask(task: Task, userId = task.userId): Promise<void> {
  const { error } = await supabase
    .from("tasks")
    .upsert(toDbTask({ ...task, userId }), { onConflict: "id" });

  if (error) throw error;
}

async function tryCloudWrite(task: Task, userId = task.userId): Promise<void> {
  try {
    await upsertCloudTask(task, userId);
  } catch (error) {
    await savePendingTaskWrite({
      id: `${task.id}:${task.updatedAt}`,
      task,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      lastError: error instanceof Error ? error.message : "Cloud write failed"
    });
  }
}

async function flushPendingWrites(user: User): Promise<void> {
  const writes = await getPendingTaskWrites(user.id);
  for (const write of writes) {
    await upsertCloudTask(write.task, user.id);
    await deletePendingTaskWrite(write.id);
  }
}

function fromDbTask(task: DbTask): Task {
  return {
    id: task.id,
    userId: task.user_id,
    title: task.title,
    deadlineAt: task.deadline_at,
    completedAt: task.completed_at,
    deletedAt: task.deleted_at,
    createdAt: task.created_at,
    updatedAt: task.updated_at
  };
}

function toDbTask(task: Task): DbTask {
  return {
    id: task.id,
    user_id: task.userId,
    title: task.title,
    deadline_at: task.deadlineAt,
    completed_at: task.completedAt,
    deleted_at: task.deletedAt,
    created_at: task.createdAt,
    updated_at: task.updatedAt
  };
}
