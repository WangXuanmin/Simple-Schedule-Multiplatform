# PWA Architecture

## Overview

Simple Schedule PWA uses one installable web app for both iPhone and Windows.
The app stores data locally first for speed and offline use, then syncs directly
with Supabase Auth and Supabase Postgres. The cloud database is required because
multi-device sync is a core requirement.

```text
iPhone Home Screen PWA ----\
                            -> Supabase Auth + Postgres
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
        data/
        ui/
        styles.css
      index.html
      vite.config.ts
    api/
      README.md
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
- Subscribes to Supabase Realtime task changes for faster cross-device refresh
- Shows sync state

Recommended stack:

- React
- Vite
- TypeScript
- `@supabase/supabase-js`
- Hand-written IndexedDB wrapper
- Hand-written service worker

### Service Worker

The service worker owns offline app availability:

- Cache app shell assets
- Serve the app when offline
- Cache PWA icons and manifest
- Receive Web Push events later

It should not contain core task business rules. Those stay in `packages/core`.

### Apps API

`apps/api` is not active in the current implementation. It is reserved for a
future server-controlled sync phase if direct Supabase access becomes too
limited.

Future API responsibilities would be:

- User identity
- Canonical task records
- Sync cursor generation
- Operation validation
- Conflict policy

Recommended stack:

- Node.js
- TypeScript
- Fastify or Hono
- PostgreSQL through Supabase or another hosted provider

### Cloud Database

The cloud database is the shared source of truth. Use hosted PostgreSQL for the
planned product. SQLite can be used only for temporary local API experiments,
not as the target architecture.

Recommended first provider: Supabase Postgres. See `docs/cloud-postgres.md` for
setup steps, schema, RLS policies, and environment variable rules.

Suggested tables:

```text
tasks
task_operations
web_push_subscriptions
```

User records are owned by Supabase Auth.

For personal use, the server can be small, but it still needs durable cloud
storage so Windows and iPhone can converge on the same task state.

## Data Ownership

### Local First

Clients should never wait for the network before updating the UI.

1. Create a `TaskOperation`.
2. Apply it to local IndexedDB.
3. Mark it as pending.
4. Try to push it to Supabase.
5. Pull remote changes.

### Server Authority

Supabase Postgres is the final shared source of truth across devices. The
current direct-client implementation uses task-level `updatedAt` and soft delete
semantics. A future `apps/api` can enforce stricter operation ordering if needed.

## Sync Flow

```text
App starts
  -> Load local IndexedDB tasks
  -> Render immediately
  -> If online, push pending task writes
  -> Pull tasks from Supabase
  -> Merge remote changes into local cache
  -> Render updated list

Task changes
  -> Update IndexedDB immediately
  -> Attempt Supabase write automatically
  -> Queue failed writes for the next sync attempt

Remote task changes
  -> Supabase Realtime sends a Postgres Changes event
  -> Client debounces briefly
  -> Client runs the normal cloud pull
  -> IndexedDB and UI are refreshed

App resumes or network returns
  -> Client runs the normal cloud pull
  -> Missed Realtime events are reconciled
```

## API Shape

Reserved for future `apps/api` implementation:

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

pendingWrites
  id
  task
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
- Supabase RLS ensures each authenticated user can read/write only their own
  task rows.

This keeps the implementation understandable and good enough for one-person
multi-device use. If multiple devices frequently edit the same task while
offline, `apps/api` should be promoted from reserved to active.

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
- CSS can make the app surface fill the viewport, but it cannot enforce an
  operating-system-level minimum window size for an Edge/Chrome PWA.

## Deployment

Recommended simple deployment:

```text
apps/web -> GitHub Pages HTTPS
database/auth -> Supabase
apps/api -> reserved
```

For early testing on the same Wi-Fi:

```text
Windows dev server -> iPhone Safari opens local network URL
```

For real iPhone Home Screen install and service worker behavior, use the GitHub
Pages HTTPS URL.

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
Supabase Realtime is enabled for faster device-to-device refresh. `apps/api`
remains reserved for later operation-based sync.

### Phase 3: Polish

- Web Push reminders
- Better install guidance
- Import existing localStorage tasks from old app if desired
