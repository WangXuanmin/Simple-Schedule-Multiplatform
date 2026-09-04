import Database from "@tauri-apps/plugin-sql";
import { localConflictCopy, type Task, type PendingWrite } from "@simple-schedule/core";
import { TASK_TABLE_SQL, PENDING_TABLE_SQL, QUEUE_INSERT_SQL, CACHE_UPSERT_SQL, QUEUE_TASK_TRIGGER, ACK_TRIGGER, RESOLUTION_TRIGGER } from "./localSchema.ts";

const DB_URL = "sqlite:simple-schedule-windows.db";

let dbPromise: Promise<Database> | null = null;

export type PendingTaskWrite = PendingWrite & { userId: string; taskId: string };

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
  version: number | null;
};

type PendingTaskWriteRow = {
  id: string;
  userId: string;
  taskId: string;
  taskJson: string;
  createdAt: string;
  retryCount: number;
  lastError: string | null;
  baseVersion: number | null;
  dependsOn: string | null;
  conflictJson: string | null;
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
      updated_at as updatedAt, version
    from tasks
    where user_id = $1`,
    [userId]
  );
  return rows.map(fromTaskRow);
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
      last_error as lastError,
      base_version as baseVersion, depends_on as dependsOn, conflict_json as conflictJson
    from pending_task_writes
    where user_id = $1
    order by rowid asc`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    taskId: row.taskId,
    task: JSON.parse(row.taskJson) as Task,
    createdAt: row.createdAt,
    retryCount: row.retryCount,
    lastError: row.lastError,
    baseVersion: row.baseVersion, dependsOn: row.dependsOn,
    conflict: row.conflictJson ? JSON.parse(row.conflictJson) : null
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
  await db.execute(
    QUEUE_INSERT_SQL,
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

export async function setSyncMetadata(userId: string, lastSyncAt: string): Promise<void> {
  const db = await openDb();
  await db.execute(
    `insert into sync_metadata (key, value)
    values ($1, $2)
    on conflict(key) do update set value = excluded.value`,
    [`lastSyncAt:${userId}`, lastSyncAt]
  );
}

async function openDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL).then(async (db) => {
      await ensureSchema(db);
      return db;
    }).catch((error) => { dbPromise = null; throw error; });
  }
  return dbPromise;
}

async function ensureSchema(db: Database): Promise<void> {
  await db.execute(TASK_TABLE_SQL);
  await db.execute("create index if not exists tasks_user_idx on tasks (user_id)");
  await db.execute("create index if not exists tasks_user_updated_idx on tasks (user_id, updated_at)");
  await db.execute(PENDING_TABLE_SQL);
  await db.execute("create index if not exists pending_task_writes_user_idx on pending_task_writes (user_id, created_at)");
  // Additive upgrades preserve all legacy tasks and pending snapshots.
  for (const [table, columns] of Object.entries({ tasks: { version: "integer" }, pending_task_writes: {
    base_version: "integer", depends_on: "text", conflict_json: "text", ack_json: "text", resolution_json: "text"
  } })) {
    const existing = await db.select<Array<{ name: string }>>(`pragma table_info(${table})`);
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.some((column) => column.name === name)) await db.execute(`alter table ${table} add column ${name} ${type}`);
    }
  }
  await db.execute("drop trigger if exists persist_queued_task");
  await db.execute(QUEUE_TASK_TRIGGER);
  await db.execute(ACK_TRIGGER);
  await db.execute(RESOLUTION_TRIGGER);
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
    CACHE_UPSERT_SQL,
    [
      task.id.toLowerCase(),
      task.userId.toLowerCase(),
      task.title,
      task.deadlineAt,
      task.completedAt,
      task.deletedAt,
      task.urgency,
      task.createdAt,
      task.updatedAt, task.version ?? null
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
    updatedAt: row.updatedAt, version: row.version ?? undefined
  };
}

export async function acknowledgePendingWrite(id: string, task: Task): Promise<void> {
  const db = await openDb();
  await db.execute("update pending_task_writes set ack_json = $1 where id = $2", [JSON.stringify(task), id]);
}

export async function markPendingTaskWriteConflict(id: string, task: Task | null, reason: string): Promise<void> {
  const db = await openDb();
  await db.execute("update pending_task_writes set conflict_json = $1, last_error = $2 where id = $3", [JSON.stringify({ task, reason }), reason, id]);
}

export async function resolvePendingConflict(userId: string, requestId: string, copy: boolean): Promise<void> {
  const db = await openDb();
  const writes = await getPendingTaskWrites(userId);
  const conflict = writes.find((write) => write.id === requestId);
  if (!conflict?.conflict) throw new Error("冲突状态已变化，请重新同步");
  const latest = writes.filter((write) => write.taskId === conflict.taskId).at(-1)!;
  const resolution = { expectedLatestId: latest.id, copy: copy ? localConflictCopy(latest.task) : null, requestId: crypto.randomUUID() };
  const result = await db.execute("update pending_task_writes set resolution_json = $1 where id = $2 and user_id = $3", [JSON.stringify(resolution), requestId, userId]);
  if (!result.rowsAffected) throw new Error("冲突状态已变化，请重新同步");
}
