# Project Context Summary

## Current Goal

Create a personal schedule app that works across Windows and iPhone without an
iOS App Store release. The chosen route is a PWA:

```text
Windows Edge/Chrome installed PWA
iPhone Safari Add to Home Screen
Supabase Auth + Supabase Postgres
GitHub Pages HTTPS hosting
```

The original `C:\Users\Dubhe\Documents\Simple-Schedule` Electron app must remain
untouched. All new work is in:

```text
C:\Users\Dubhe\Documents\Simple-Schedule-Multiplatform
```

## Final Architecture

```text
apps/web
  React + Vite PWA
  Supabase email/password Auth
  Supabase Postgres direct client sync
  IndexedDB local cache
  pendingWrites queue for failed/offline writes
  hand-written service worker

packages/core
  shared task types and task sorting rules

packages/ui
  design tokens

apps/api
  reserved only; not active
```

## Supabase

Project:

```text
Project URL: https://vzojfajfpjdjeoavhtks.supabase.co
Project ref: vzojfajfpjdjeoavhtks
Anon key: sb_publishable_oVpjHxc8WK7c-aoPYtwOSw_aU0A1IUy
```

Tables:

```text
tasks
task_operations
```

Important setup already done:

- `Enable Data API` enabled.
- `Enable automatic RLS` enabled.
- `Automatically expose new tables and functions` disabled.
- `supabase/schema.sql` executed.
- Explicit grants added for `authenticated`.
- Auth uses email + password, not magic links.
- GitHub Pages URL should be in Supabase Auth URL Configuration.

## Deployment

Provider:

```text
GitHub Pages
```

Production URL:

```text
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/
```

Workflow:

```text
.github/workflows/pages.yml
```

Build:

```text
npm run build:web
```

The workflow sets `GITHUB_PAGES=true` so Vite uses:

```text
/Simple-Schedule-Multiplatform/
```

as the production base path.

## UI Decisions

- Removed manual sync button `S`; task changes sync automatically.
- Removed sign-out button `Q`; app is personal single-user.
- Floating `+` is the only main action.
- Desktop PWA should fill the viewport instead of rendering a centered card.
- Artificial `560px` minimum height was removed.
- Always-on-top is not required.
- iOS Home Screen icon uses PNG assets, not SVG.

## Recent Commits

```text
ccbd354 Initial PWA GitHub Pages setup
03605ee Document GitHub Pages deployment URL
5aae5cf Refine desktop PWA window layout
ccb8eda Fill desktop PWA window by default
551e0e4 Make PWA surface fill viewport
cf2d58b Add PNG PWA home screen icons
```

There may be local commits ahead of `origin/main`; check with:

```powershell
git status --short --branch
```

Use GitHub Desktop if normal `git` is unavailable on PATH.

## Current Verification Commands

```powershell
npm.cmd run build:web
npm.cmd audit
```

Expected:

```text
build succeeds
0 vulnerabilities
```

## Known Caveats

- iOS may cache old Home Screen icons. Delete and re-add the Home Screen app
  after icon changes.
- Existing installed desktop PWAs may cache old service worker assets. Close,
  reopen, and refresh; reinstall if needed.
- Edge/Chrome PWAs cannot enforce OS-level always-on-top or native minimum
  window size from web code.
