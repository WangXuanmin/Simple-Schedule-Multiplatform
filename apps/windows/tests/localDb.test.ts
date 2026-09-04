import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { TASK_TABLE_SQL, PENDING_TABLE_SQL, QUEUE_INSERT_SQL, CACHE_UPSERT_SQL, QUEUE_TASK_TRIGGER, ACK_TRIGGER, RESOLUTION_TRIGGER } from "../src/data/localSchema.ts";

const task = (patch = {}) => ({ id: "task-a", userId: "user-a", title: "first", deadlineAt: "2026-09-04T10:00:00Z", completedAt: null, deletedAt: null, urgency: "normal", createdAt: "2026-09-04T09:00:00Z", updatedAt: "2026-09-04T09:00:00Z", ...patch });
function open(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(TASK_TABLE_SQL); db.exec(PENDING_TABLE_SQL); db.exec(QUEUE_TASK_TRIGGER); db.exec(ACK_TRIGGER); db.exec(RESOLUTION_TRIGGER);
  return db;
}
function enqueue(db: DatabaseSync, id: string, value = task()) {
  db.prepare(QUEUE_INSERT_SQL).run(bind([id, value.userId, value.id, JSON.stringify(value), value.updatedAt, 0, null]));
}
function cache(db: DatabaseSync, value = task()) {
  db.prepare(CACHE_UPSERT_SQL).run(bind([value.id, value.userId, value.title, value.deadlineAt, value.completedAt, value.deletedAt, value.urgency, value.createdAt, value.updatedAt, (value as { version?: number }).version ?? null]));
}
const bind = (values: Array<string | number | null>) => Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]));

test("enqueue commits task and immutable queue snapshots together", () => {
  const db = open();
  try {
    enqueue(db, "request-1");
    enqueue(db, "request-2", task({ title: "second" }));
    assert.equal(db.prepare("select title from tasks").get()?.title, "second");
    const rows = db.prepare("select id, task_json from pending_task_writes order by rowid").all();
    assert.equal(rows.length, 2);
    assert.equal(JSON.parse(String(rows[0].task_json)).title, "first");
    db.prepare("delete from pending_task_writes where id = ?").run("request-1");
    assert.equal(db.prepare("select id from pending_task_writes").get()?.id, "request-2");
  } finally { db.close(); }
});

test("failure after trigger writes rolls back both changes", () => {
  const db = open();
  try {
    enqueue(db, "request-1");
    db.exec("create trigger fail_after_task after update on tasks begin select raise(abort, 'injected failure'); end");
    assert.throws(() => enqueue(db, "request-2", task({ title: "lost" })), /injected failure/);
    assert.equal(db.prepare("select title from tasks").get()?.title, "first");
    assert.equal(db.prepare("select count(*) as n from pending_task_writes").get()?.n, 1);
  } finally { db.close(); }
});

test("invalid task fails without leaving a queue orphan", () => {
  const db = open();
  try {
    assert.throws(() => enqueue(db, "bad", task({ title: null })), /NOT NULL/);
    assert.equal(db.prepare("select count(*) as n from tasks").get()?.n, 0);
    assert.equal(db.prepare("select count(*) as n from pending_task_writes").get()?.n, 0);
  } finally { db.close(); }
});

test("pull cannot overwrite pending changes even with a later cloud timestamp", () => {
  const db = open();
  try {
    enqueue(db, "request-1");
    cache(db, task({ title: "cloud", updatedAt: "2028-01-01T00:00:00Z" }));
    assert.equal(db.prepare("select title from tasks").get()?.title, "first");
    db.exec("delete from pending_task_writes");
    cache(db, task({ title: "cloud", updatedAt: "2028-01-01T00:00:00Z" }));
    assert.equal(db.prepare("select title from tasks").get()?.title, "cloud");
  } finally { db.close(); }
});

test("cache preserves tombstones and account ownership", () => {
  const db = open();
  try {
    cache(db, task({ deletedAt: "2026-09-04T09:00:00Z" }));
    cache(db, task({ updatedAt: "2028-01-01T00:00:00Z" }));
    assert.ok(db.prepare("select deleted_at from tasks").get()?.deleted_at);
    assert.throws(() => enqueue(db, "other-user", task({ userId: "user-b" })), /another account/);
    assert.equal(db.prepare("select count(*) as n from pending_task_writes").get()?.n, 0);
  } finally { db.close(); }
});

test("a committed pending snapshot survives closing and reopening the database", () => {
  const directory = mkdtempSync(join(tmpdir(), "schedule-sqlite-"));
  const path = join(directory, "tasks.db");
  try {
    let db = open(path);
    try { enqueue(db, "restart"); } finally { db.close(); }
    db = open(path);
    try {
      assert.equal(db.prepare("select id from pending_task_writes").get()?.id, "restart");
      assert.equal(db.prepare("select title from tasks").get()?.title, "first");
    } finally { db.close(); }
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "schedule-sqlite-"));
    rmSync(directory, { recursive: true });
  }
});

test("acknowledgement atomically advances the dependent base and preserves its draft", () => {
  const db = open();
  try {
    enqueue(db, "first", task({ version: 0 }));
    enqueue(db, "second", task({ version: 0, title: "local second" }));
    assert.equal(db.prepare("select depends_on from pending_task_writes where id='second'").get()?.depends_on, "first");
    db.prepare("update pending_task_writes set ack_json=? where id='first'").run(JSON.stringify(task({ version: 1 })));
    assert.deepEqual({ ...db.prepare("select base_version, depends_on from pending_task_writes where id='second'").get() }, { base_version: 1, depends_on: null });
    assert.equal(db.prepare("select title from tasks").get()?.title, "local second");
    assert.equal(db.prepare("select version from tasks").get()?.version, 1);
    db.prepare("update pending_task_writes set ack_json=? where id='second'").run(JSON.stringify(task({ version: 2, title: "local second" })));
    assert.equal(db.prepare("select count(*) as n from pending_task_writes").get()?.n, 0);
    assert.equal(db.prepare("select version from tasks").get()?.version, 2);
  } finally { db.close(); }
});

test("ack failure rolls back version, queue deletion and dependent metadata", () => {
  const db = open();
  try {
    enqueue(db, "first", task({ version: 0 }));
    enqueue(db, "second", task({ version: 0, title: "local second" }));
    db.exec("create trigger fail_ack before delete on pending_task_writes begin select raise(abort, 'ack failed'); end");
    assert.throws(() => db.prepare("update pending_task_writes set ack_json=? where id='first'").run(JSON.stringify(task({ version: 1 }))), /ack failed/);
    assert.equal(db.prepare("select version from tasks").get()?.version, 0);
    assert.equal(db.prepare("select depends_on from pending_task_writes where id='second'").get()?.depends_on, "first");
    assert.equal(db.prepare("select ack_json from pending_task_writes where id='first'").get()?.ack_json, null);
  } finally { db.close(); }
});

test("server version outranks client clock when writing cache", () => {
  const db = open();
  try {
    cache(db, task({ version: 2, updatedAt: "2099-01-01T00:00:00Z" }));
    cache(db, task({ version: 3, title: "confirmed", updatedAt: "2000-01-01T00:00:00Z" }));
    assert.equal(db.prepare("select title from tasks").get()?.title, "confirmed");
    cache(db, task({ version: 2, deletedAt: "2099-01-01T00:00:00Z" }));
    assert.equal(db.prepare("select deleted_at from tasks").get()?.deleted_at, null);
  } finally { db.close(); }
});

test("conflict copy preserves local draft as a new task and adopts cloud atomically", () => {
  const db = open();
  try {
    enqueue(db, "first", task({ version: 1, title: "local" }));
    db.prepare("update pending_task_writes set conflict_json=? where id='first'").run(JSON.stringify({ task: task({ version: 2, title: "cloud" }), reason: "conflict" }));
    db.prepare("update pending_task_writes set resolution_json=? where id='first'").run(JSON.stringify({ expectedLatestId: "first", copy: task({ id: "copy", version: 0, title: "local copy" }), requestId: "copy-request" }));
    assert.equal(db.prepare("select title from tasks where id='task-a'").get()?.title, "cloud");
    assert.equal(db.prepare("select title from tasks where id='copy'").get()?.title, "local copy");
    assert.deepEqual({ ...db.prepare("select id, base_version from pending_task_writes").get() }, { id: "copy-request", base_version: 0 });
  } finally { db.close(); }
});
