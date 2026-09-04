# HTTPS Deployment

2026-09-04 update: the additive `supabase/migrations/20260904_sync_v1.sql` migration **was applied** to project `vzojfajfpjdjeoavhtks` and verified through real PostgreSQL/Auth/PostgREST tests. It preserves legacy writes. This change prepares the updated Web client for publication through the main-branch Pages workflow; Windows binaries remain local. `npm run check`, browser checks and the Windows native release build passed. Native desktop interaction acceptance and iOS/Xcode validation remain separate. Pages now requires `npm run check` to pass before deployment; inspect the commit's Actions run for its publication result.

## Version protocol rollout

1. For a fresh database, apply the base schema and additive version migration. For the current project, the additive migration is already applied.
2. Publish the new Web/Windows clients and allow them to fetch cloud versions. Legacy offline writes lacking a baseline are retained and shown as conflicts, with cloud/copy choices.
3. Keep compatibility while old clients need uploads. `task_sync_capabilities_v1()` currently returns `strict: false`; legacy iOS direct writes remain usable.
4. Once legacy uploads can stop, apply `supabase/sync-v1-enforce.sql`. This revokes direct task writes and changes the existing retention function to soft deletion. This step is prepared, not executed. Do not run legacy `schema.sql`, `grants.sql` or `task-retention.sql` afterward without adapting them: they can undo strict grants/retention.
5. Rerun live integration tests and verify capabilities report strict mode. Native clients and cross-device acceptance remain separate from server tests.

`npm run test:supabase` runs transactional SQL checks with fixtures and temporary strict permissions rolled back. `npm run test:supabase:live` creates two isolated temporary Auth users, tests HTTP endpoints and deletes users/tasks/receipts in `finally`. Both require a signed-in dedicated Supabase dashboard tab, the web-access CDP proxy on localhost:3456, and explicit `SUPABASE_CDP_TARGET` / `SUPABASE_PROJECT_REF` environment variables. Tokens remain in the browser; neither test requires frontend service keys. These tests are manual, not part of CI. The query helper uses the official [Management API database query endpoint](https://supabase.com/docs/reference/api/v1-run-a-query).

## Target

Deploy `apps/web` to GitHub Pages so it has an HTTPS URL and can be installed
from iPhone Safari with Add to Home Screen.

## Provider

```text
GitHub Pages
```

## Repository Assumption

Repository name:

```text
Simple-Schedule-Multiplatform
```

GitHub Pages production URL:

```text
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/
```

The Vite config uses `GITHUB_PAGES=true` to set the correct base path for this
repository name.

## GitHub Actions

The workflow lives at:

```text
.github/workflows/pages.yml
```

It:

1. Installs locked dependencies with `npm ci` using Node 24.
2. Runs tests, type checks and frontend builds with `npm run check`.
3. Uploads `apps/web/dist`.
4. Deploys to GitHub Pages.

## Environment Variables

The public Supabase values are used at build time:

```text
VITE_SUPABASE_URL=https://vzojfajfpjdjeoavhtks.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_oVpjHxc8WK7c-aoPYtwOSw_aU0A1IUy
```

These are included in the GitHub Actions workflow because they are public PWA
values. Do not add database passwords or service role keys to the frontend.

## GitHub Pages Settings

After the repository is pushed:

1. Open the GitHub repository.
2. Go to `Settings -> Pages`.
3. Set `Build and deployment` source to `GitHub Actions`.
4. Wait for the `Deploy PWA to GitHub Pages` workflow to finish.

## Supabase Auth URLs

GitHub Pages deployment is active at:

```text
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/
```

Update Supabase:

```text
Authentication -> URL Configuration
```

Keep local URLs:

```text
http://localhost:5173/**
http://127.0.0.1:5173/**
```

Add the GitHub Pages URL:

```text
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/**
```

Set `Site URL` to the production GitHub Pages URL once it is confirmed.

Recommended Site URL:

```text
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/
```
