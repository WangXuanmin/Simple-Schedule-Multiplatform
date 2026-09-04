import { localConflictCopy, mergeTasks, type Task, type PendingWrite } from "@simple-schedule/core";

const DB_NAME = "simple-schedule-pwa";
const DB_VERSION = 1;
const TASK_STORE = "tasks";
const META_STORE = "metadata";
const PENDING_STORE = "pendingWrites";

let dbPromise: Promise<IDBDatabase> | null = null;

export type SyncMetadata = {
  lastSyncAt: string | null;
};

export type PendingTaskWrite = PendingWrite;

// Both stores commit or roll back together. A request's success alone is not
// evidence that its surrounding IndexedDB transaction has committed.
export async function saveTaskAndQueue(task: Task): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([TASK_STORE, PENDING_STORE], "readwrite");
  const done = complete(tx);
  const pending = tx.objectStore(PENDING_STORE);
  const request = pending.getAll();
  request.onsuccess = () => {
    const writes = request.result as PendingTaskWrite[];
    // Preserve insertion order even with equal timestamps or a clock rollback.
    const previous = writes.reduce((latest, write) => Math.max(latest, Date.parse(write.createdAt) || 0), 0);
    const predecessor = writes.filter((write) => write.task.id === task.id && write.task.userId === task.userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    const write: PendingTaskWrite = {
      id: crypto.randomUUID(),
      task,
      createdAt: new Date(Math.max(Date.now(), previous + 1)).toISOString(),
      retryCount: 0,
      lastError: null,
      baseVersion: predecessor ? null : task.version ?? null,
      dependsOn: predecessor?.id ?? null
    };
    tx.objectStore(TASK_STORE).put(task);
    pending.add(write);
  };
  await done;
}

export async function acknowledgePendingWrite(id: string, confirmed: Task): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([TASK_STORE, PENDING_STORE], "readwrite");
  const done = complete(tx);
  const queue = tx.objectStore(PENDING_STORE);
  const request = queue.getAll();
  request.onsuccess = () => {
    const writes = request.result as PendingWrite[];
    const write = writes.find((item) => item.id === id);
    if (!write) return;
    if (write.task.id !== confirmed.id || write.task.userId !== confirmed.userId ||
        write.baseVersion == null || confirmed.version !== write.baseVersion + 1) { tx.abort(); return; }
    queue.delete(id);
    for (const next of writes) {
      if (next.dependsOn === id) queue.put({ ...next, dependsOn: null, baseVersion: confirmed.version });
    }
    const tasks = tx.objectStore(TASK_STORE);
    const current = tasks.get(confirmed.id);
    current.onsuccess = () => {
      const hasLater = writes.some((item) => item.id !== id && item.task.id === confirmed.id && item.task.userId === confirmed.userId);
      tasks.put(hasLater && current.result ? { ...current.result, version: confirmed.version } : confirmed);
    };
  };
  await done;
}

export async function markPendingTaskWriteConflict(id: string, task: Task | null, reason: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PENDING_STORE, "readwrite");
  const done = complete(tx);
  const store = tx.objectStore(PENDING_STORE);
  const request = store.get(id);
  request.onsuccess = () => {
    if (request.result) store.put({ ...request.result, conflict: { task, reason }, lastError: reason });
  };
  await done;
}

export async function resolvePendingConflict(userId: string, requestId: string, copy: boolean): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([TASK_STORE, PENDING_STORE], "readwrite");
  const done = complete(tx);
  const queue = tx.objectStore(PENDING_STORE);
  const request = queue.getAll();
  request.onsuccess = () => {
    const writes = request.result as PendingWrite[];
    const conflict = writes.find((write) => write.id === requestId && write.task.userId === userId);
    if (!conflict?.conflict) { tx.abort(); return; }
    const related = writes.filter((write) => write.task.userId === userId && write.task.id === conflict.task.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const store = tx.objectStore(TASK_STORE);
    if (copy) {
      const task = localConflictCopy(related.at(-1)!.task);
      store.put(task);
      queue.add({ id: crypto.randomUUID(), task, baseVersion: 0, dependsOn: null,
        createdAt: new Date(Math.max(Date.now(), ...writes.map((write) => Date.parse(write.createdAt) + 1))).toISOString(),
        retryCount: 0, lastError: null });
    }
    for (const write of related) queue.delete(write.id);
    if (conflict.conflict.task) store.put(conflict.conflict.task);
    else store.delete(conflict.task.id);
  };
  await done;
}

export async function getLocalTasks(userId: string): Promise<Task[]> {
  const db = await openDb();
  const tasks = await getAll<Task>(db, TASK_STORE);
  return tasks.filter((task) => task.userId === userId);
}


export async function saveLocalTasks(tasks: Task[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([TASK_STORE, PENDING_STORE], "readwrite");
  const done = complete(tx);
  const pending = tx.objectStore(PENDING_STORE).getAll();
  pending.onsuccess = () => {
    const writes = pending.result as PendingTaskWrite[];
    const store = tx.objectStore(TASK_STORE);
    for (const task of tasks) {
      // Check inside the write transaction, not before the network request.
      if (writes.some((write) => write.task.userId === task.userId && write.task.id === task.id)) continue;
      const current = store.get(task.id);
      current.onsuccess = () => {
        store.put(current.result ? mergeTasks([current.result as Task], [task])[0] : task);
      };
    }
  };
  await done;
}

export async function getSyncMetadata(userId: string): Promise<SyncMetadata> {
  const db = await openDb();
  const value = await get<{ key: string; value: SyncMetadata }>(db, META_STORE, `sync:${userId}`);
  return value?.value ?? { lastSyncAt: null };
}

export async function setSyncMetadata(userId: string, value: SyncMetadata): Promise<void> {
  const db = await openDb();
  await put(db, META_STORE, { key: `sync:${userId}`, value });
}

export async function getPendingTaskWrites(userId: string): Promise<PendingTaskWrite[]> {
  const db = await openDb();
  const writes = await getAll<PendingTaskWrite>(db, PENDING_STORE);
  return writes.filter((write) => write.task.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}


export async function markPendingTaskWriteFailed(id: string, retryCount: number, lastError: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PENDING_STORE, "readwrite");
  const done = complete(tx);
  const store = tx.objectStore(PENDING_STORE);
  const request = store.get(id);
  request.onsuccess = () => {
    if (request.result) store.put({ ...request.result, retryCount, lastError });
  };
  await done;
}

export async function deletePendingTaskWrite(id: string): Promise<void> {
  const db = await openDb();
  await remove(db, PENDING_STORE, id);
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TASK_STORE)) {
        const store = db.createObjectStore(TASK_STORE, { keyPath: "id" });
        store.createIndex("userId", "userId", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        const store = db.createObjectStore(PENDING_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        dbPromise = null;
      };
      resolve(request.result);
    };
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });

  return dbPromise;
}

function getAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

function get<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function put<T>(db: IDBDatabase, storeName: string, value: T): Promise<void> {
  const tx = db.transaction(storeName, "readwrite");
  const done = complete(tx);
  tx.objectStore(storeName).put(value);
  await done;
}

async function remove(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
  const tx = db.transaction(storeName, "readwrite");
  const done = complete(tx);
  tx.objectStore(storeName).delete(key);
  await done;
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
