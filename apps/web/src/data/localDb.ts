import type { Task } from "@simple-schedule/core";

const DB_NAME = "simple-schedule-pwa";
const DB_VERSION = 1;
const TASK_STORE = "tasks";
const META_STORE = "metadata";
const PENDING_STORE = "pendingWrites";

let dbPromise: Promise<IDBDatabase> | null = null;

export type SyncMetadata = {
  lastSyncAt: string | null;
};

export type PendingTaskWrite = {
  id: string;
  task: Task;
  createdAt: string;
  retryCount: number;
  lastError: string | null;
};

export async function getLocalTasks(userId: string): Promise<Task[]> {
  const db = await openDb();
  const tasks = await getAll<Task>(db, TASK_STORE);
  return tasks.filter((task) => task.userId === userId);
}

export async function saveLocalTask(task: Task): Promise<void> {
  const db = await openDb();
  await put(db, TASK_STORE, task);
}

export async function saveLocalTasks(tasks: Task[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(TASK_STORE, "readwrite");
  for (const task of tasks) tx.objectStore(TASK_STORE).put(task);
  await complete(tx);
}

export async function getSyncMetadata(): Promise<SyncMetadata> {
  const db = await openDb();
  const value = await get<{ key: string; value: SyncMetadata }>(db, META_STORE, "sync");
  return value?.value ?? { lastSyncAt: null };
}

export async function setSyncMetadata(value: SyncMetadata): Promise<void> {
  const db = await openDb();
  await put(db, META_STORE, { key: "sync", value });
}

export async function getPendingTaskWrites(userId: string): Promise<PendingTaskWrite[]> {
  const db = await openDb();
  const writes = await getAll<PendingTaskWrite>(db, PENDING_STORE);
  return writes.filter((write) => write.task.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function savePendingTaskWrite(write: PendingTaskWrite): Promise<void> {
  const db = await openDb();
  await put(db, PENDING_STORE, write);
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

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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

function put<T>(db: IDBDatabase, storeName: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readwrite").objectStore(storeName).put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function remove(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readwrite").objectStore(storeName).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
