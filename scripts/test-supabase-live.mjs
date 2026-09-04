import { browserEval } from "./supabase-query.mjs";

const ref = process.env.SUPABASE_PROJECT_REF;
if (!/^[a-z]{20}$/.test(ref ?? "")) throw new Error("Set SUPABASE_PROJECT_REF explicitly.");
// Credentials stay inside the user's dedicated dashboard tab and are never
// returned to Node, logs, source files or a third-party service.
const result = await browserEval(`(${async function (ref) {
  const session = JSON.parse(localStorage.getItem("supabase.dashboard.auth.token") || "{}");
  const keyResponse = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, { headers: { Authorization: `Bearer ${session.access_token}` } });
  if (!keyResponse.ok) throw new Error(`Cannot obtain project test access: ${keyResponse.status}`);
  const keys = await keyResponse.json();
  const admin = keys.find((key) => key.name === "service_role")?.api_key;
  const anon = keys.find((key) => key.name === "anon")?.api_key;
  if (!admin || !anon) throw new Error("Project test API keys unavailable");
  const base = `https://${ref}.supabase.co`;
  const users = [];
  const passed = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const call = async (path, key, token, body, method = "POST") => {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(30000), headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  try {
    for (let i = 0; i < 2; i++) {
      const email = `codex-sync-test-${crypto.randomUUID()}@example.invalid`;
      const password = crypto.randomUUID() + "aA1!";
      const created = await call("/auth/v1/admin/users", admin, admin, { email, password, email_confirm: true, user_metadata: { purpose: "temporary sync-v1 integration test" } });
      assert(created.status < 300, `Cannot create test user: ${created.status}`);
      users.push({ id: created.data.id });
      const signedIn = await call("/auth/v1/token?grant_type=password", anon, anon, { email, password });
      assert(signedIn.status === 200, `Cannot sign in test user: ${signedIn.status}`);
      users.at(-1).token = signedIn.data.access_token;
    }
    const [a, b] = users;
    const rpc = (user, requestId, version, task) => call("/rest/v1/rpc/write_task_v1", anon, user.token, { p_request_id: requestId, p_base_version: version, p_task: task });
    const makeTask = () => ({ id: crypto.randomUUID(), user_id: a.id, title: "Codex isolated sync test", deadline_at: "2026-09-05T09:00:00Z", completed_at: null, deleted_at: null, urgency: "normal", created_at: "2026-09-04T09:00:00Z", updated_at: "2026-09-04T09:00:00Z" });
    const task = makeTask();
    const create = await rpc(a, crypto.randomUUID(), 0, task);
    assert(create.data.status === "applied" && create.data.task.version === 1, "create/version failed");
    passed.push("authenticated RPC creates version 1");
    const requests = [
      { id: crypto.randomUUID(), task: { ...task, title: "clock-ahead", updated_at: "2099-01-01T00:00:00Z" } },
      { id: crypto.randomUUID(), task: { ...task, title: "clock-behind", updated_at: "2000-01-01T00:00:00Z" } }
    ];
    const concurrent = await Promise.all(requests.map((request) => rpc(a, request.id, 1, request.task)));
    assert(concurrent.filter((r) => r.data.status === "applied").length === 1 && concurrent.filter((r) => r.data.status === "conflict").length === 1, "concurrent writers both succeeded");
    passed.push("concurrent same-base writers: one applied, one conflict despite clock skew");
    const winner = requests[concurrent.findIndex((r) => r.data.status === "applied")];
    const retry = await rpc(a, winner.id, 1, winner.task);
    assert(retry.data.status === "duplicate" && retry.data.task.version === 2, "response-loss replay changed version");
    passed.push("lost-response replay returns original version without another mutation");
    const reused = await rpc(a, winner.id, 1, { ...winner.task, title: "different content" });
    assert(reused.status === 400, "reused request identity accepted new payload");
    passed.push("request identity cannot be reused with different content");
    const repeated = makeTask();
    const sameRequest = crypto.randomUUID();
    const duplicates = await Promise.all([rpc(a, sameRequest, 0, repeated), rpc(a, sameRequest, 0, repeated)]);
    assert(duplicates.map((r) => r.data.status).sort().join() === "applied,duplicate", "concurrent duplicate create not deduplicated");
    passed.push("concurrent identical creates apply exactly once");
    const unauthorized = await rpc(b, crypto.randomUUID(), 2, { ...task, user_id: b.id });
    assert(unauthorized.status === 403, "cross-account write allowed");
    const read = await call(`/rest/v1/tasks?id=eq.${task.id}&select=id`, anon, b.token, undefined, "GET");
    assert(read.status === 200 && read.data.length === 0, "RLS leaked another account's task");
    passed.push("cross-account RPC denied and reads isolated by RLS");
    const anonymous = await call("/rest/v1/rpc/write_task_v1", anon, anon, { p_request_id: crypto.randomUUID(), p_base_version: 0, p_task: task });
    assert(anonymous.status >= 400, "anonymous write permitted");
    passed.push("anonymous RPC denied");
    const deleted = await rpc(a, crypto.randomUUID(), 2, { ...task, deleted_at: "2026-09-04T10:00:00Z" });
    assert(deleted.data.status === "applied" && deleted.data.task.version === 3, "soft delete failed");
    const restore = await rpc(a, crypto.randomUUID(), 3, task);
    assert(restore.data.status === "conflict", "implicit resurrection accepted");
    passed.push("deleted task cannot be implicitly restored");
    const caps = await call("/rest/v1/rpc/task_sync_capabilities_v1", anon, a.token, {});
    assert(caps.status === 200 && caps.data.protocol === 1, "capabilities unavailable");
    if (caps.data.strict) {
      const bypass = await call("/rest/v1/tasks", anon, a.token, makeTask());
      assert(bypass.status === 403, "legacy direct write bypassed strict mode");
      passed.push("strict mode rejects direct PostgREST writes");
    } else {
      const legacyTask = makeTask();
      const legacy = await call("/rest/v1/tasks", anon, a.token, legacyTask);
      assert(legacy.status === 201, "compatibility mode broke legacy creation");
      const update = await call(`/rest/v1/tasks?id=eq.${legacyTask.id}`, anon, a.token, { title: "legacy update" }, "PATCH");
      assert(update.status === 204, "compatibility mode broke legacy update");
      const versioned = await rpc(a, crypto.randomUUID(), 1, legacyTask);
      assert(versioned.data.status === "conflict" && versioned.data.task.version === 2, "legacy update did not advance server version");
      passed.push("legacy create/update remain compatible and advance the version seen by new clients");
    }
    return { passed, strict: caps.data.strict, cleanup: "test users and their tasks/receipts deleted in finally" };
  } finally {
    for (const user of users) {
      const result = await call(`/auth/v1/admin/users/${user.id}`, admin, admin, undefined, "DELETE");
      if (result.status >= 300) throw new Error(`Cleanup failed for temporary test user ${user.id}`);
    }
  }
}})(${JSON.stringify(ref)})`);
console.log(JSON.stringify(result, null, 2));
