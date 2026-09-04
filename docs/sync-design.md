# Sync Design

Updated 2026-09-04. The versioned RPC is deployed to Supabase in **compatibility mode**. Web/Windows source uses it; native iOS remains on its legacy protocol and is deferred until a Mac is available. Updated clients have not been published.

## Local flow on Web and Windows

1. Persist the task and an immutable pending snapshot in one IndexedDB transaction / SQLite statement with triggers. Return after local commit, then request background sync.
2. Serialize each account's sync; bursts coalesce into a following pass. Web also uses a Web Lock across tabs where supported.
3. Upload requests in persisted order through `write_task_v1`. A new edit depends on the previous pending edit for that task. Only after its predecessor is confirmed does a not-yet-sent request receive the confirmed base version.
4. Atomically acknowledge the exact request, advance dependent metadata and cache the confirmed version. Keep newer local content. A crash before this local commit replays the same request ID, base and payload.
5. Persist conflicts and stop that task's descendants; continue unrelated tasks. Transport or other upload errors retain the request and stop the pass.
6. Pull the account's task list. Inside the cache write transaction, preserve tasks with pending edits. Otherwise prefer higher server versions; legacy snapshots fall back to deletion/time rules. Check active account before network operations and UI updates.
7. Display “已同步” only after cloud work completes and the queue is empty. Read server capabilities and display compatibility mode explicitly.

Windows orders the queue by SQLite rowid. Web assigns monotonically increasing creation times relative to existing records, including a backwards wall clock. Queue order is separate from cross-device edit order.

Web Realtime is a 300 ms debounced refresh hint. Startup/login, local changes, manual refresh and foreground/network recovery request sync. Data requests time out after 15 seconds. Recognized transient network/429/5xx failures retry at 1, 2, 4, 8 and 16 seconds, at most five times; auth, validation, permission and conflict errors do not use that timer.

## Versioned cloud writes

Migration: `supabase/migrations/20260904_sync_v1.sql`.

```ts
supabase.rpc("write_task_v1", {
  p_request_id: requestId,
  p_base_version: baseVersion,
  p_task: taskPayload // snake_case fields; version is not in this body
});
```

The function derives ownership from `auth.uid()`, uses a fixed empty search path, and grants execution only to authenticated users. Transaction-scoped locks serialize request IDs and task IDs, including when the row does not exist. Existing tasks are row-locked; version comparison, mutation and receipt insertion commit together. A trigger assigns version 1 to inserts and increments every update, including legacy writes.

| Result | Meaning | Client action |
| --- | --- | --- |
| applied | Base matched; committed task returned | Atomically acknowledge this request and store version |
| duplicate | Same account, request, base and payload already committed | Acknowledge using the original result; no second mutation |
| conflict | Version differs, update target missing, or implicit restore | Persist local/cloud snapshots for user choice |
| HTTP/SQL error | Invalid input, session or ownership | Keep pending work; show failure |

New tasks use base 0. A different request cannot create over an existing ID. Reusing a request ID with changed content is rejected. Receipts store original payload and result, keyed by account and request ID; clients cannot read or modify them directly. No receipt pruning is enabled.

Legacy offline snapshots have no reliable base version. They are presented as conflicts even after fetching the cloud version; fetching does not authorize silently rebasing the old edit.

## Conflict and deletion choices

- Different fields and the same field both use whole-task conflict detection; no automatic field merge.
- “采用云端（放弃本地修改）” adopts the conflict's cloud snapshot and removes that task's pending chain atomically. If the cloud row is absent, remove the local original. A following sync obtains any newer cloud state.
- “保留本地为新任务” copies the latest pending local draft to a new UUID, adds “（本地副本）”, resets completion/deletion and queues it with base 0; the original adopts the cloud snapshot in the same transaction.
- Concurrent delete/edit is decided by accepted versions. A stale request conflicts regardless of device time. A tombstone cannot be implicitly restored, even with its current base version. Explicit restoration is not implemented.
- Windows' 5-second undo cancels a not-yet-persisted deletion. Reopening a completed task is separate from restoring a deleted task.

## Compatibility and strict enforcement

The live database currently allows legacy direct INSERT/UPDATE/DELETE. New RPC requests enforce versions, but a legacy client can still overwrite a newer task. `task_sync_capabilities_v1()` therefore returns `strict: false`. Do not claim universal protection while this mode is enabled.

`supabase/sync-v1-enforce.sql` is prepared but **not applied**. It revokes direct task writes and changes `purge_completed_tasks()` to retain soft-deleted rows. Apply only after new clients are available and legacy uploads can stop. Do not rerun legacy schema/grants/retention scripts afterward: they can reopen writes or reinstate hard deletion.

The existing daily retention job still hard-deletes old completed tasks in compatibility mode. Long-offline resurrection and retention policy remain open until strict enforcement and tombstone retention are activated. No incremental cursor, paginated pull or standalone operations API is implemented.

## Evidence

Real PostgreSQL transactional tests passed, including temporary strict grants and rollback. Real Auth/PostgREST tests passed for concurrent writes, replay, clock skew, account isolation, deletion and legacy compatibility; temporary accounts are deleted afterward. Local SQLite, shared protocol and Chromium tests cover queue persistence, ack rollback and conflict UI. Native iOS and full Windows/iOS/Web device interoperability remain unverified. See [implementation results](云程日历_优化实施结果.md).
