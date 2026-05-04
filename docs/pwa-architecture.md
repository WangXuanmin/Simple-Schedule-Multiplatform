# PWA Architecture

## Overview

Simple Schedule PWA uses one installable web app for both iPhone and Windows.
The app stores data locally first for speed and offline use, then syncs through
a small API backed by a cloud database. The cloud database is required because
multi-device sync is a core requirement.

```text
iPhone Home Screen PWA ----\
                            -> Sync API -> Database
Windows installed PWA ------/

Both clients run the same apps/web code.
Shared rules live in packages/core.
```

## Project Layout

```text
Simple-Schedule-Multiplatform/
  apps/
    web/
      public/
        manifest.webmanifest
        icons/
      src/
        app/
        components/
        data/
        sync/
        styles/
      index.html
      vite.config.ts
    api/
      src/
        routes/
        services/
        db/
  packages/
    core/
      src/
        index.ts
    ui/
      src/
        tokens.ts
  docs/
```

## Runtime Components

### Web App

The web app owns user interaction:

- Renders Todo and Completed views
- Applies local task operations immediately
- Stores tasks and pending operations in IndexedDB
- Registers the service worker
- Calls Supabase automatically after task changes when online
- Shows sync state

Recommended stack:

- React
- Vite
- TypeScript
- vite-plugin-pwa
- Dexie or idb for IndexedDB

### Service Worker

The service worker owns offline app availability:

- Cache app shell assets
- Serve the app when offline
- Optionally cache API reads
- Receive Web Push events later

It should not contain core task business rules. Those stay in `packages/core`.

### Sync API

The API owns durable server state:

- User identity
- Canonical task records
- Sync cursor generation
- Operation validation
- Conflict policy

Recommended stack:

- Node.js
- TypeScript
- Fastify or Hono
- SQLite for local development
- PostgreSQL for production hosting

### Cloud Database

The cloud database is the shared source of truth. Use hosted PostgreSQL for the
planned product. SQLite can be used only for temporary local API experiments,
not as the target architecture.

Recommended first provider: Supabase Postgres. See `docs/cloud-postgres.md` for
setup steps, schema, RLS policies, and environment variable rules.

Suggested tables:

```text
users
tasks
task_operations
sync_cursors
web_push_subscriptions
```

For personal use, the server can be small, but it still needs durable cloud
storage so Windows and iPhone can converge on the same task state.

## Data Ownership

### Local First

Clients should never wait for the network before updating the UI.

1. Create a `TaskOperation`.
2. Apply it to local IndexedDB.
3. Mark it as pending.
4. Try to push it to the API.
5. Pull remote changes.

### Server Authority

The API plus cloud database is the final shared source of truth across devices.
If two devices change the same task, the server applies the conflict policy and
returns the resolved record.

## Sync Flow

```text
App starts
  -> Load local IndexedDB tasks
  -> Render immediately
  -> If online, push pending operations
  -> Pull changes since last cursor
  -> Merge remote changes into local cache
  -> Render updated list

Task changes
  -> Update IndexedDB immediately
  -> Attempt Supabase write automatically
  -> Queue failed writes for the next sync attempt
```

## API Shape

```text
POST /auth/sign-in
POST /auth/sign-out
GET  /tasks?since=<cursor>
POST /tasks/operations
GET  /sync/state
POST /push/subscriptions
DELETE /push/subscriptions/:id
```

## Local IndexedDB Stores

```text
tasks
  id
  userId
  title
  deadlineAt
  completedAt
  deletedAt
  createdAt
  updatedAt

pendingOperations
  id
  operation
  createdAt
  retryCount
  lastError

metadata
  key
  value
```

## Conflict Rules

MVP rules:

- Soft delete wins over update.
- Newer `updatedAt` wins for normal fields.
- Reopen and complete are treated as field updates on `completedAt`.
- Server rejects malformed timestamps and missing task IDs.

This keeps the implementation understandable and good enough for one-person
multi-device use.

## PWA Requirements

The web app should provide:

- HTTPS in production
- `manifest.webmanifest`
- App icons, including maskable icon
- `display: standalone`
- Service worker registration
- Offline fallback
- Responsive layout for iPhone and Windows app windows

## iPhone Constraints

Important limits:

- The user must manually add the app to the Home Screen.
- Background execution is limited.
- Push notifications require a Home Screen web app on supported iOS versions.
- Web Push requires server support and user permission.
- iOS widgets and lock-screen widgets are not part of the PWA scope.

## Windows Constraints

Important limits:

- Browser-installed PWAs cannot reliably force always-on-top.
- Startup-on-login is possible through OS/browser shortcuts, but less direct
  than a desktop-only app.

## Deployment

Recommended simple deployment:

```text
apps/web -> static hosting with HTTPS
apps/api -> small Node.js server
database -> managed cloud PostgreSQL
```

For early testing on the same Wi-Fi:

```text
Windows dev server -> iPhone Safari opens local network URL
```

For real iPhone Home Screen install and service worker behavior, use HTTPS
through a public host or a trusted tunnel during testing.

## Implementation Phases

### Phase 1: Local PWA

- Build `apps/web`
- Add manifest and icons
- Add service worker
- Store tasks in IndexedDB
- Match current Simple-Schedule style and behavior
- Define cloud database schema before implementation drifts

Status: implemented as the first working PWA shell.

### Phase 2: Sync

- Build `apps/api`
- Add auth
- Connect hosted PostgreSQL
- Add task operation endpoint
- Add sync cursor
- Sync between Windows browser and iPhone Safari

Status: direct Supabase Auth + task-table sync is implemented in `apps/web`.
`apps/api` remains reserved for later operation-based sync.

### Phase 3: Polish

- Web Push reminders
- Better install guidance
- Import existing localStorage tasks from old app if desired
