# Data Model

Updated 2026-09-04.

## Tasks

TypeScript `Task` contains `id`, `userId`, `title`, `deadlineAt`, `completedAt`, `deletedAt`, `urgency`, `createdAt`, `updatedAt` and optional `version`. Version 0 means a new local task, a positive integer is the last server-confirmed version, and undefined means an unknown legacy baseline. Supabase `public.tasks.version` is a non-null bigint; a trigger assigns 1 on insert and increments every update.

Urgency is normal, rush, or urgent. Normal client IDs are lowercase UUID strings and timestamps are ISO strings. Supabase uses snake_case. Windows stores tasks in SQLite, Web in IndexedDB and iOS in SwiftData; iOS has not adopted the version protocol.

Active tasks have null completion/deletion timestamps. Soft deletion sets deletedAt. Clients hide completed tasks after 7 days. The live daily retention job still hard-deletes old completed rows; strict enforcement will change it to soft deletion. Explicit deleted-task restoration and bounded tombstone/receipt retention remain unspecified.

Todo order is deadline ascending, urgency descending for equal deadlines, then creation ascending. Completed order is completion descending, then update descending.

## Durable writes

| Field | Windows | Web | Native iOS |
| --- | --- | --- | --- |
| Request ID | UUID id | UUID id | UUID id |
| Owner/task | user_id, task_id | Embedded in task | Owner/task fields |
| Immutable content | task_json | task | Optional encoded snapshot |
| Ordering | SQLite rowid | Monotonic queue createdAt | Monotonic queue createdAt |
| Failure details | Retry count, last error | Retry count, last error | Retry count, last error |
| Base/dependency | base_version, depends_on | baseVersion, dependsOn | Not implemented |
| Conflict | conflict_json | conflict | Not implemented |

Windows also has ack_json and resolution_json, used by triggers to apply confirmations and conflict choices in one atomic statement. Upgrades add nullable columns and retain old tasks/queued content. Web's existing object stores accept added optional fields without a database version change. Legacy pending writes with no base require a user choice, rather than automatic overwrite.

A local change and its queue insertion commit together. Acknowledgement removes only its request, advances dependent versions and preserves newer local drafts. Choosing a conflict copy creates a new task/queue and resolves the original in the same transaction. Sync metadata is account-scoped and records a successful pass time, not a server cursor.

## Cloud tables

- public.tasks: account-owned snapshots with RLS and a server version.
- public.task_write_receipts: (user_id, request_id) primary key, task ID, base version, immutable payload, committed result and creation time. RLS enabled; no direct anon/authenticated access. Owner deletion cascades receipts. No automatic pruning.
- public.task_operations: pre-existing unused table; current clients do not upload operations here.
- auth.users: Supabase accounts. No sync_cursors or standalone API exists.

The RPC and permissions are in `supabase/migrations/20260904_sync_v1.sql`. Strict permission/retention changes are separately prepared in `supabase/sync-v1-enforce.sql`. See [sync design](sync-design.md) for current compatibility limits.
