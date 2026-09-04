# Architecture

Updated 2026-09-04. Three clients share Supabase Auth and `public.tasks`:

| Client | UI | Local persistence | Cloud access |
| --- | --- | --- | --- |
| Windows native | Tauri + React | SQLite through the SQL plugin | Supabase JS / PostgREST |
| iOS native | SwiftUI | SwiftData | Auth REST / PostgREST |
| Web / installed PWA | React + Vite | IndexedDB | Supabase JS / PostgREST + Realtime notifications |

Each ordinary mutation saves the task and a pending snapshot atomically, then updates the UI and requests background sync. Windows uses an SQLite enqueue trigger, Web uses a transaction spanning both stores, and iOS uses one explicit SwiftData save. iOS changes still require Xcode and device validation.

The durable sync path uploads pending snapshots sequentially, then fetches the account's task list. Cache writes preserve pending local changes. Realtime is implemented in Web as a refresh hint; it is not an operation log. Native clients use startup, local edits, foreground/network recovery and manual refresh.

`packages/core` contains TypeScript task rules and the per-account scheduler used by Windows/Web. Swift implements corresponding behavior separately. `apps/api` is reserved and is not a deployed backend. No custom `/tasks/operations` endpoint or incremental cursor currently exists.

Web/Windows now upload through the shared versioned-write engine and Supabase `write_task_v1` RPC, with atomic versions, durable receipts and local conflict choices. Native iOS retains legacy upsert and is deferred. The RPC is deployed in compatibility mode: legacy direct writes remain allowed, so universal cross-device protection is not yet enforced. Updated clients are local source/build artifacts, not published releases. See [sync design](sync-design.md), [data model](data-model.md), and [implementation results](云程日历_优化实施结果.md).
