import Database from "@tauri-apps/plugin-sql";
import type { Task } from "@simple-schedule/core";

const DB_URL = "sqlite:simple-schedule-windows.db";

let dbPromise: Promise<Database> | null = null;

export type PendingTaskWrite = {
  id: string;
  userId: string;
  taskId: string;
  task: Task;
  createdAt: string;
  retryCount: number;
  lastError: string | null;
};

type TaskRow = {
  id: string;
  userId: string;
  title: string;
  deadlineAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  urgency: string;
  createdAt: string;
  updatedAt: string;
};

type PendingTaskWriteRow = {
  id: string;
  userId: string;
  taskId: string;
  taskJson: string;
  createdAt: string;
  retryCount: number;
  lastError: string | null;
};

export async function getLocalTasks(userId: string): Promise<Task[]> {
  const db = await openDb();
  const rows = await db.select<TaskRow[]>(
    `select
      id,
      user_id as userId,
      title,
      deadline_at as deadlineAt,
      completed_at as completedAt,
      deleted_at as deletedAt,
      urgency,
      created_at as createdAt,
      updated_at as updatedAt
    from tasks
    where user_id = $1`,
    [userId]
  );
  return rows.map(fromTaskRow);
}

export async function saveLocalTask(task: Task): Promise<void> {
  const db = await openDb();
  await upsertTask(db, task);
}

export async function replaceLocalTasks(userId: string, tasks: Task[]): Promise<void> {
  const db = await openDb();
  await db.execute("delete from tasks where user_id = $1", [userId]);
  for (const task of tasks) {
    await upsertTask(db, task);
  }
}

export async function mergeLocalTasks(tasks: Task[]): Promise<void> {
  const db = await openDb();
  for (const task of tasks) {
    await upsertTask(db, task);
  }
}

export async function getPendingTaskWrites(userId: string): Promise<PendingTaskWrite[]> {
  const db = await openDb();
  const rows = await db.select<PendingTaskWriteRow[]>(
    `select
      id,
      user_id as userId,
      task_id as taskId,
      task_json as taskJson,
      created_at as createdAt,
      retry_count as retryCount,
      last_error as lastError
    from pending_task_writes
    where user_id = $1
    order by created_at asc`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    taskId: row.taskId,
    task: JSON.parse(row.taskJson) as Task,
    createdAt: row.createdAt,
    retryCount: row.retryCount,
    lastError: row.lastError
  }));
}

export async function getPendingTaskWriteCount(userId: string): Promise<number> {
  const db = await openDb();
  const rows = await db.select<Array<{ count: number }>>(
    "select count(*) as count from pending_task_writes where user_id = $1",
    [userId]
  );
  return rows[0]?.count ?? 0;
}

export async function savePendingTaskWrite(write: PendingTaskWrite): Promise<void> {
  const db = await openDb();
  await db.execute("delete from pending_task_writes where user_id = $1 and task_id = $2 and id <> $3", [
    write.userId,
    write.taskId,
    write.id
  ]);
  await db.execute(
    `insert into pending_task_writes (
      id,
      user_id,
      task_id,
      task_json,
      created_at,
      retry_count,
      last_error
    )
    values ($1, $2, $3, $4, $5, $6, $7)
    on conflict(id) do update set
      task_json = excluded.task_json,
      retry_count = excluded.retry_count,
      last_error = excluded.last_error`,
    [
      write.id,
      write.userId,
      write.taskId,
      JSON.stringify(write.task),
      write.createdAt,
      write.retryCount,
      write.lastError
    ]
  );
}

export async function markPendingTaskWriteFailed(id: string, retryCount: number, lastError: string): Promise<void> {
  const db = await openDb();
  await db.execute("update pending_task_writes set retry_count = $1, last_error = $2 where id = $3", [
    retryCount,
    lastError,
    id
  ]);
}

export async function deletePendingTaskWrite(id: string): Promise<void> {
  const db = await openDb();
  await db.execute("delete from pending_task_writes where id = $1", [id]);
}

export async function setSyncMetadata(lastSyncAt: string): Promise<void> {
  const db = await openDb();
  await db.execute(
    `insert into sync_metadata (key, value)
    values ('lastSyncAt', $1)
    on conflict(key) do update set value = excluded.value`,
    [lastSyncAt]
  );
}

async function openDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL).then(async (db) => {
      await ensureSchema(db);
      return db;
    });
  }
  return dbPromise;
}

async function ensureSchema(db: Database): Promise<void> {
  await db.execute(`
    create table if not exists tasks (
      id text primary key,
      user_id text not null,
      title text not null,
      deadline_at text not null,
      completed_at text,
      deleted_at text,
      urgency text not null default 'normal',
      created_at text not null,
      updated_at text not null
    )
  `);
  await db.execute("create index if not exists tasks_user_idx on tasks (user_id)");
  await db.execute("create index if not exists tasks_user_updated_idx on tasks (user_id, updated_at)");
  await db.execute(`
    create table if not exists pending_task_writes (
      id text primary key,
      user_id text not null,
      task_id text not null,
      task_json text not null,
      created_at text not null,
      retry_count integer not null default 0,
      last_error text
    )
  `);
  await db.execute("create index if not exists pending_task_writes_user_idx on pending_task_writes (user_id, created_at)");
  await db.execute(`
    create table if not exists sync_metadata (
      key text primary key,
      value text
    )
  `);
  await db.execute(`
    create table if not exists auth_session (
      key text primary key,
      value text
    )
  `);
}

async function upsertTask(db: Database, task: Task): Promise<void> {
  await db.execute(
    `insert into tasks (
      id,
      user_id,
      title,
      deadline_at,
      completed_at,
      deleted_at,
      urgency,
      created_at,
      updated_at
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    on conflict(id) do update set
      user_id = excluded.user_id,
      title = excluded.title,
      deadline_at = excluded.deadline_at,
      completed_at = excluded.completed_at,
      deleted_at = excluded.deleted_at,
      urgency = excluded.urgency,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at`,
    [
      task.id.toLowerCase(),
      task.userId.toLowerCase(),
      task.title,
      task.deadlineAt,
      task.completedAt,
      task.deletedAt,
      task.urgency,
      task.createdAt,
      task.updatedAt
    ]
  );
}

function fromTaskRow(row: TaskRow): Task {
  return {
    id: row.id.toLowerCase(),
    userId: row.userId.toLowerCase(),
    title: row.title,
    deadlineAt: row.deadlineAt,
    completedAt: row.completedAt,
    deletedAt: row.deletedAt,
    urgency: row.urgency === "rush" || row.urgency === "urgent" ? row.urgency : "normal",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
