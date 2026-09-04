import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Use a locally installed Playwright or an explicitly supplied runtime module.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
process.env.VITE_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.VITE_SUPABASE_ANON_KEY = "local-test-key";
const server = await createServer({
  root: fileURLToPath(new URL("../apps/web", import.meta.url)),
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error"
});
await server.listen();
const baseURL = server.resolvedUrls.local[0];
let browser;
let passed = 0;
const check = async (name, fn) => { await fn(); console.log(`PASS ${name}`); passed++; };

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext();
  // These tests never access the deployed service.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === new URL(baseURL).origin ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  await page.goto(baseURL);
  await page.waitForLoadState("networkidle");

  await check("IndexedDB commits task + queue and keeps equal-time edits ordered", async () => {
    const result = await page.evaluate(async () => {
      const db = await import("/src/data/localDb.ts");
      const task = { id: "a", userId: "u", title: "first", deadlineAt: "2026-09-04T10:00:00Z", completedAt: null, deletedAt: null, urgency: "normal", createdAt: "2026-09-04T09:00:00Z", updatedAt: "2026-09-04T09:00:00Z" };
      await db.saveTaskAndQueue(task);
      await db.saveTaskAndQueue({ ...task, title: "second" });
      return { tasks: await db.getLocalTasks("u"), writes: await db.getPendingTaskWrites("u") };
    });
    assert.equal(result.tasks[0].title, "second");
    assert.deepEqual(result.writes.map((write) => write.task.title), ["first", "second"]);
    assert.notEqual(result.writes[0].id, result.writes[1].id);
  });

  await check("IndexedDB transaction abort rolls back task and queue", async () => {
    const result = await page.evaluate(async () => {
      const db = await import("/src/data/localDb.ts");
      const task = (await db.getLocalTasks("u"))[0];
      const original = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) {
        const request = original.apply(this, args);
        if (this.name === "pendingWrites") this.transaction.abort();
        return request;
      };
      let rejected = false;
      try { await db.saveTaskAndQueue({ ...task, title: "must roll back" }); }
      catch { rejected = true; }
      finally { IDBObjectStore.prototype.add = original; }
      return { rejected, tasks: await db.getLocalTasks("u"), writes: await db.getPendingTaskWrites("u") };
    });
    assert.equal(result.rejected, true);
    assert.equal(result.tasks[0].title, "second");
    assert.equal(result.writes.length, 2);
  });

  await check("old acknowledgement and failure cannot erase or resurrect queue records", async () => {
    const result = await page.evaluate(async () => {
      const db = await import("/src/data/localDb.ts");
      const [old] = await db.getPendingTaskWrites("u");
      await db.deletePendingTaskWrite(old.id);
      await db.markPendingTaskWriteFailed(old.id, 1, "late failure");
      await db.saveLocalTasks([{ ...old.task, title: "cloud", updatedAt: "2030-01-01T00:00:00Z" }]);
      return { tasks: await db.getLocalTasks("u"), writes: await db.getPendingTaskWrites("u"), other: await db.getPendingTaskWrites("other") };
    });
    assert.equal(result.tasks[0].title, "second");
    assert.deepEqual(result.writes.map((write) => write.task.title), ["second"]);
    assert.equal(result.other.length, 0);
  });

  await check("IndexedDB pending changes survive page restart", async () => {
    await page.reload();
    const result = await page.evaluate(async () => {
      const db = await import("/src/data/localDb.ts");
      return { tasks: await db.getLocalTasks("u"), writes: await db.getPendingTaskWrites("u") };
    });
    assert.equal(result.tasks[0].title, "second");
    assert.equal(result.writes.length, 1);
  });

  await check("cache tombstones and sync metadata are isolated", async () => {
    const result = await page.evaluate(async () => {
      const db = await import("/src/data/localDb.ts");
      const task = (await db.getLocalTasks("u"))[0];
      const deleted = { ...task, id: "deleted", deletedAt: task.updatedAt };
      await db.saveLocalTasks([deleted]);
      await db.saveLocalTasks([{ ...deleted, deletedAt: null, updatedAt: "2030-01-01T00:00:00Z" }]);
      await db.setSyncMetadata("u", { lastSyncAt: task.updatedAt });
      return { deleted: (await db.getLocalTasks("u")).find((item) => item.id === "deleted"), other: await db.getSyncMetadata("other") };
    });
    assert.ok(result.deleted.deletedAt);
    assert.equal(result.other.lastSyncAt, null);
  });
  await check("IndexedDB failed acknowledgement rolls back version and dependencies", async () => {
    const result = await page.evaluate(async () => {
      const db = await import("/src/data/localDb.ts");
      const task = { ...(await db.getLocalTasks("u"))[0], id: "ack-task", userId: "ack-user", version: 0 };
      await db.saveTaskAndQueue(task);
      await db.saveTaskAndQueue({ ...task, title: "later draft" });
      const before = await db.getPendingTaskWrites(task.userId);
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const request = original.apply(this, args);
        if (this.name === "tasks") this.transaction.abort();
        return request;
      };
      let rejected = false;
      try { await db.acknowledgePendingWrite(before[0].id, { ...task, version: 1 }); }
      catch { rejected = true; }
      finally { IDBObjectStore.prototype.put = original; }
      const failed = { tasks: await db.getLocalTasks(task.userId), writes: await db.getPendingTaskWrites(task.userId) };
      await db.acknowledgePendingWrite(before[0].id, { ...task, version: 1 });
      return { rejected, before, failed, tasks: await db.getLocalTasks(task.userId), writes: await db.getPendingTaskWrites(task.userId) };
    });
    assert.equal(result.rejected, true);
    assert.deepEqual(result.failed.writes, result.before);
    assert.equal(result.failed.tasks[0].version, 0);
    assert.equal(result.writes.length, 1);
    assert.equal(result.writes[0].baseVersion, 1);
    assert.equal(result.writes[0].dependsOn, null);
    assert.equal(result.tasks[0].title, "later draft");
    assert.equal(result.tasks[0].version, 1);
  });
  await context.close();

  const ui = await browser.newContext();
  const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "test@example.invalid" };
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp: 4102444800 })).toString("base64url")}.test`;
  await ui.addInitScript(({ token, user }) => {
    localStorage.setItem("sb-127-auth-token", JSON.stringify({ access_token: token, refresh_token: "test", token_type: "bearer", expires_at: 4102444800, user }));
  }, { token, user });
  const heldUploads = [];
  const cloudTasks = new Map();
  const confirmNext = async () => {
    const route = heldUploads.shift();
    assert.ok(route, "expected pending RPC");
    const request = route.request().postDataJSON();
    const current = cloudTasks.get(request.p_task.id);
    let result;
    if ((current?.version ?? 0) !== request.p_base_version) result = { status: "conflict", task: current ?? null };
    else {
      const task = { ...request.p_task, version: request.p_base_version + 1 };
      cloudTasks.set(task.id, task);
      result = { status: "applied", task };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) });
  };
  let pullCount = 0;
  await ui.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(baseURL).origin) return route.continue();
    if (url.origin !== "http://127.0.0.1:54321") return route.abort();
    if (url.pathname === "/rest/v1/rpc/write_task_v1") { heldUploads.push(route); return; }
    if (url.pathname === "/rest/v1/rpc/task_sync_capabilities_v1") return route.fulfill({ status: 200, contentType: "application/json", body: '{"protocol":1,"strict":true}' });
    if (url.pathname === "/rest/v1/tasks") {
      pullCount++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([...cloudTasks.values()].filter((task) => !url.searchParams.has("id") || `eq.${task.id}` === url.searchParams.get("id"))) });
    }
    if (url.pathname === "/auth/v1/user") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) });
    return route.abort();
  });
  const app = await ui.newPage();
  await app.goto(baseURL);
  await app.waitForLoadState("networkidle");
  await app.getByTitle("Add task", { exact: true }).waitFor();

  await check("local persistence failure keeps the composer open and creates no task", async () => {
    await app.getByTitle("Add task", { exact: true }).click();
    await app.getByLabel("Task", { exact: true }).fill("must-not-save");
    await app.evaluate(() => {
      const original = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) {
        const request = original.apply(this, args);
        if (this.name === "pendingWrites") {
          IDBObjectStore.prototype.add = original;
          this.transaction.abort();
        }
        return request;
      };
    });
    await app.getByRole("button", { name: "Save", exact: true }).click();
    await app.waitForFunction(() => document.querySelector("footer")?.textContent.includes("Could not save task"));
    assert.equal(await app.locator(".add-panel").count(), 1);
    assert.equal(await app.locator(".task-copy strong").count(), 0);
    await app.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  await check("adding a task renders locally while its cloud upload is hanging", async () => {
    await app.getByTitle("Add task", { exact: true }).click();
    await app.getByLabel("Task", { exact: true }).fill("offline-ready");
    await app.getByRole("button", { name: "Save", exact: true }).click();
    await app.getByText("offline-ready", { exact: true }).waitFor({ timeout: 1500 });
    await app.waitForFunction(() => !document.querySelector(".add-panel"));
    const writes = await app.evaluate(async (id) => (await import("/src/data/localDb.ts")).getPendingTaskWrites(id), user.id);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].task.title, "offline-ready");
    assert.ok(!((await app.locator("footer").innerText()).startsWith("已同步")));
  });

  await check("a second mutation stays pending when the first upload confirms", async () => {
    await app.getByTitle("Toggle complete").click();
    await app.getByText("offline-ready", { exact: true }).waitFor({ state: "hidden", timeout: 1500 });
    await app.waitForFunction(async (id) => (await (await import("/src/data/localDb.ts")).getPendingTaskWrites(id)).length === 2, user.id);
    assert.equal(heldUploads.length, 1);
    await confirmNext();
    await app.waitForFunction(async (id) => (await (await import("/src/data/localDb.ts")).getPendingTaskWrites(id)).length === 1, user.id);
    const writes = await app.evaluate(async (id) => (await import("/src/data/localDb.ts")).getPendingTaskWrites(id), user.id);
    assert.ok(writes[0].task.completedAt);
    assert.ok(!((await app.locator("footer").innerText()).startsWith("已同步")));
  });

  await check("page close/reopen restores local state and pending upload", async () => {
    // Close without confirming the second upload, then reopen the same storage.
    await app.close();
    heldUploads.length = 0;
    const resumed = await ui.newPage();
    await resumed.goto(baseURL);
    await resumed.getByRole("button", { name: "Completed", exact: true }).click();
    await resumed.getByText("offline-ready", { exact: true }).waitFor({ timeout: 2000 });
    await resumed.waitForFunction(async (id) => (await (await import("/src/data/localDb.ts")).getPendingTaskWrites(id)).length === 1, user.id);
    const deadline = Date.now() + 2000;
    while (!heldUploads.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(heldUploads.length, 1);
    await confirmNext();
    await resumed.waitForFunction(async (id) => (await (await import("/src/data/localDb.ts")).getPendingTaskWrites(id)).length === 0, user.id);
    assert.ok(pullCount > 0);

    await check("offline edits show pending status and reconnect triggers upload", async () => {
      await resumed.getByRole("button", { name: "Todo", exact: true }).click();
      await ui.setOffline(true);
      await resumed.getByTitle("Add task", { exact: true }).click();
      await resumed.getByLabel("Task", { exact: true }).fill("created-without-network");
      await resumed.getByRole("button", { name: "Save", exact: true }).click();
      await resumed.getByText("created-without-network", { exact: true }).waitFor({ timeout: 1500 });
      await resumed.waitForFunction(() => document.querySelector("footer")?.textContent.includes("待同步"));
      assert.equal(heldUploads.length, 0);
      await ui.setOffline(false);
      const deadline = Date.now() + 2000;
      while (!heldUploads.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(heldUploads.length, 1);
      await confirmNext();
      await resumed.waitForFunction(async (id) => (await (await import("/src/data/localDb.ts")).getPendingTaskWrites(id)).length === 0, user.id);
    });
    await check("conflict UI preserves local content as a new task without overwriting cloud", async () => {
      await resumed.waitForFunction(() => document.querySelector("footer")?.textContent.startsWith("已同步"));
      const original = [...cloudTasks.values()].find((task) => task.title === "created-without-network");
      cloudTasks.set(original.id, { ...original, title: "remote edit", version: original.version + 1 });
      await resumed.locator("li").filter({ has: resumed.getByText("created-without-network", { exact: true }) }).getByTitle("Toggle complete").click();
      const deadline = Date.now() + 2000;
      while (!heldUploads.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      await confirmNext();
      await resumed.getByRole("region", { name: "同步冲突" }).waitFor({ timeout: 2000 });
      await resumed.getByRole("button", { name: "保留本地为新任务", exact: true }).click();
      await resumed.getByText("created-without-network（本地副本）", { exact: true }).waitFor({ timeout: 2000 });
      await resumed.getByText("remote edit", { exact: true }).waitFor({ timeout: 2000 });
      const copyDeadline = Date.now() + 2000;
      while (!heldUploads.length && Date.now() < copyDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(heldUploads[0].request().postDataJSON().p_base_version, 0);
      await confirmNext();
      assert.equal(cloudTasks.get(original.id).title, "remote edit");
      await resumed.waitForFunction(async (id) => (await (await import("/src/data/localDb.ts")).getPendingTaskWrites(id)).length === 0, user.id);
    });
  });
  await ui.close();
  console.log(`${passed} browser checks passed`);
} finally {
  await browser?.close();
  await server.close();
}
