# Simple Schedule PWA

This is a clean restart of Simple-Schedule as a PWA-first multi-device app.

The original `Simple-Schedule` project stays untouched. This project keeps the
same basic task style and behavior, but delivers it as a web app that can be
added to the iPhone Home Screen from Safari.

## Product Goal

Build one web app that works on:

- iPhone / iPad through Safari "Add to Home Screen"
- Windows through Edge/Chrome "Install app"
- Normal browsers as a fallback

Both devices should show the same tasks after sign-in and sync changes quickly.
Cloud database sync is a required part of the product, not an optional later
extension.

## Preserved Behavior

- Todo and completed task views
- Add task with name and deadline
- Sort todo tasks by deadline
- Mark task completed / todo
- Delete task
- Auto-clean completed tasks after 5 days
- Compact, calm desktop-widget visual style

## Recommended Architecture

```text
Simple-Schedule-Multiplatform/
  apps/
    web/            PWA client for iPhone and Windows
    api/            Sync API service
  packages/
    core/           Shared task model and business rules
    ui/             Shared design tokens and UI conventions
  docs/
    pwa-product-design.md
    pwa-architecture.md
    data-model.md
    sync-design.md
```

## Stack Direction

Use a shared TypeScript web stack:

- Frontend: React + Vite PWA
- Local storage: IndexedDB
- Offline runtime: service worker
- Backend: Node.js API
- Cloud database: hosted PostgreSQL

The first implementation step should be the web app shell, manifest, service
worker, and shared task model. Authentication and cloud sync can be added after
the local PWA shell behaves well on both iPhone and Windows, but the data model
and API should be designed for cloud sync from the start.

## Why Not Modify the Old Project

The current project is a minimal desktop app with localStorage persistence.
Keeping it untouched avoids mixing desktop-only assumptions with PWA files,
service worker behavior, IndexedDB storage, cloud database sync, and backend
configuration.

## Key Documents

- `docs/pwa-product-design.md`
- `docs/pwa-architecture.md`
- `docs/cloud-postgres.md`
- `docs/codex-supabase-mcp.md`
- `docs/data-model.md`
- `docs/sync-design.md`
- `docs/implementation-status.md`
- `docs/deployment.md`

## Current Implementation

`apps/web` now contains the first PWA implementation:

- React + Vite
- Manifest and service worker setup
- Supabase email/password Auth and Postgres wiring
- IndexedDB local task cache
- Offline pending-write queue
- Automatic sync after task changes
- Todo / Completed task UI
- Single visible floating action: add task
- PNG PWA icons for iOS Home Screen and browser install surfaces

Before the app can sync against Supabase, run `supabase/schema.sql` in the
Supabase SQL Editor.

For GitHub Pages HTTPS deployment, see `docs/deployment.md`.

Production URL:

```text
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/
```
