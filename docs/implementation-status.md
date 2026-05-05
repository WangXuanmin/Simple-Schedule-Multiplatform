# Implementation Status

## Completed

- Created `apps/web` as a React + Vite PWA.
- Added PWA manifest and app icon.
- Added Supabase environment templates.
- Added local `.env.local` with the current Supabase project URL and anon key.
- Added `supabase/schema.sql` with `tasks`, `task_operations`, indexes, and RLS policies.
- Executed `supabase/schema.sql` successfully in the Supabase SQL Editor.
- Added explicit Data API grants for `authenticated` because new tables are not
  automatically exposed in this Supabase project.
- Implemented email + password sign-in and sign-up UI.
- Implemented Todo and Completed views.
- Implemented add, complete, reopen, and soft-delete task actions.
- Implemented IndexedDB local cache.
- Implemented pending cloud-write queue for offline or failed writes.
- Implemented automatic cloud-write attempts after task changes.
- Enabled Supabase Realtime for `public.tasks` and added client-side Realtime
  refresh so other devices update after task changes without manual refresh.
- Added foreground and online-resume sync to reconcile changes missed while the
  app was backgrounded, sleeping, or offline.
- Replaced the top-right sync status badge with a compact manual refresh button.
- Updated the refresh button to use a stable SVG icon instead of CSS pseudo
  elements.
- Adjusted the refresh SVG paths to stay inset from the viewBox edge for better
  iOS Safari rendering.
- Kept sync status text in the lower-left footer.
- Removed the visible sign-out button from the main task surface for the
  personal single-user workflow.
- Added deadline urgency colors: today or earlier uses red, and future
  deadlines less than 3 calendar days away use blue.
- Added automatic local date refresh so deadline urgency colors update after
  midnight or when the app returns to the foreground.
- Added GitHub Pages deployment workflow for HTTPS hosting.
- GitHub Pages deployment succeeded:
  `https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/`
- Adjusted Windows PWA layout so the task surface fills the app viewport by
  default instead of rendering as a centered card.
- Added PNG PWA icons for Safari Home Screen and web manifest usage.
- Kept `apps/api` as a later phase for server-controlled sync.

## Still Needs User / Remote Setup

- Push the latest local commits to GitHub after local changes.
- Reinstall the iPhone Home Screen PWA after icon changes because iOS caches
  home screen icons aggressively.
- Test the latest deployed layout after GitHub Actions finishes.
- Decide whether always-on-top should remain an OS/tooling concern or justify a
  native Windows wrapper later.

## Current Architecture

```text
apps/web
  -> IndexedDB local cache
  -> Supabase Auth
  -> Supabase Postgres with RLS

apps/api
  -> reserved for later operation-based sync
```

## Codex MCP

Supabase MCP setup instructions are documented in:

```text
docs/codex-supabase-mcp.md
```

Status: MCP server config has been added to `~/.codex/config.toml`; CLI PATH was
fixed so `codex` can be run from PowerShell.
