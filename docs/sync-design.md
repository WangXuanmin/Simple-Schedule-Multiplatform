# Sync Design

## MVP Sync Strategy

Use normal request/response sync first. Real-time push can come later.

Cloud database sync is mandatory for this project. IndexedDB is only the local
cache and offline queue; it is not the long-term shared source of truth.

## API Endpoints

```text
POST /auth/sign-in
GET  /tasks?since=<cursor>
POST /tasks/operations
GET  /sync/state
```

## Local Client Storage

Each client keeps:

- `tasks`
- `pending_operations`
- `last_sync_cursor`
- `current_user`

## Cloud Storage

The API persists canonical data in a hosted cloud database.

Recommended target:

```text
PostgreSQL
```

Suggested managed options:

```text
Supabase Postgres
Neon Postgres
Railway Postgres
Render Postgres
```

Current project recommendation:

```text
Supabase Postgres
```

Supabase is preferred first because it combines hosted PostgreSQL, Auth, and
Row Level Security. See `docs/cloud-postgres.md`.

## Sync Loop

1. Push pending operations.
2. Pull server changes since `last_sync_cursor`.
3. Merge changes into local cache.
4. Update `last_sync_cursor`.

## MVP Conflict Rules

- Soft delete wins.
- Newer `updatedAt` wins for simple field updates.
- If two clients complete/reopen the same task, later `updatedAt` wins.

## Later Improvements

- WebSocket or server-sent events
- Push notifications
- Shared lists
- Reminder notifications
- End-to-end encryption for personal tasks
