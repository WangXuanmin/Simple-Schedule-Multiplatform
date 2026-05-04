# Sync Design

## Current Sync Strategy

Use normal request/response sync as the durable path, and Supabase Realtime as
the fast notification path.

Cloud database sync is mandatory for this project. IndexedDB is only the local
cache and offline queue; it is not the long-term shared source of truth.

Realtime events are not treated as authoritative task data. They only tell the
client that the cloud table changed, then the client performs a normal cloud
pull. This keeps conflict behavior centralized in the existing sync path.

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

## Realtime Refresh

Each signed-in client subscribes to Supabase Postgres Changes for its own
`public.tasks` rows:

```text
schema: public
table: tasks
filter: user_id=eq.<current user id>
event: *
```

When another device creates, completes, reopens, or soft-deletes a task,
Supabase sends a Realtime event. The receiving client waits briefly to debounce
rapid changes, then runs the normal sync loop.

If a device was asleep, offline, or backgrounded and misses a Realtime event, it
runs the same sync loop when it returns to the foreground or comes back online.

Database requirement:

```sql
alter publication supabase_realtime add table public.tasks;
```

## MVP Conflict Rules

- Soft delete wins.
- Newer `updatedAt` wins for simple field updates.
- If two clients complete/reopen the same task, later `updatedAt` wins.

## Later Improvements

- Push notifications
- Shared lists
- Reminder notifications
- End-to-end encryption for personal tasks
