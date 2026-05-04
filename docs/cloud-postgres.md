# Cloud PostgreSQL Plan

## Recommendation

Use Supabase Postgres for the first cloud database.

Reason:

- It is hosted PostgreSQL.
- It includes authentication.
- It supports Row Level Security.
- It can be used directly from a PWA with the Supabase client, or through
  `apps/api` when custom sync logic is needed.
- It keeps the project small while still leaving a path to a normal Node.js API.

## Current Supabase Project

```text
Project URL:
https://vzojfajfpjdjeoavhtks.supabase.co

Anon public key:
sb_publishable_oVpjHxc8WK7c-aoPYtwOSw_aU0A1IUy

Direct connection string:
postgresql://postgres:[YOUR-PASSWORD]@db.vzojfajfpjdjeoavhtks.supabase.co:5432/postgres

Project ref:
vzojfajfpjdjeoavhtks
```

CLI setup commands:

```bash
supabase login
supabase init
supabase link --project-ref vzojfajfpjdjeoavhtks
```

Do not store the real database password or service role key in documentation.
Use local `.env` files or deployment secrets for private values.

## Target Shape

```text
apps/web
  -> Supabase Auth
  -> apps/api for sync operations
  -> Supabase Postgres

IndexedDB remains the local cache.
Supabase Postgres is the shared source of truth.
```

For the MVP, two approaches are possible:

```text
Option A: PWA -> Supabase client -> Postgres
Option B: PWA -> apps/api -> Postgres
```

Choose Option A first if speed matters. Choose Option B if sync conflict logic
needs to stay completely server-controlled from day one.

Recommended path for this project:

```text
Phase 1: Supabase Auth + direct task tables with RLS
Phase 2: Add apps/api for operation-based sync and conflict resolution
```

## Setup Steps

1. Create a Supabase project.
2. Save the project URL and anon public key.
3. Create the database tables with SQL.
4. Enable Row Level Security on user-owned tables.
5. Add policies so each signed-in user can access only their own rows.
6. Put public frontend values in `apps/web/.env.local`.
7. Keep service role keys out of the browser.

Status: `supabase/schema.sql` has been executed successfully in the Supabase SQL
Editor.

## Supabase Project Security Settings

When creating the Supabase project, use these settings:

```text
Enable Data API: checked
Automatically expose new tables and functions: unchecked
Enable automatic RLS: checked if available
```

Reason:

- `Enable Data API` is needed when the PWA uses `supabase-js` directly.
- Do not automatically expose new tables and functions. Grant access manually
  after the schema and RLS policies are ready.
- Automatic RLS is a good safety net because new public tables start protected.
  Still write explicit RLS policies for each table.

Because new tables are not automatically exposed, the schema must explicitly
grant table privileges to the `authenticated` role. RLS still limits each user
to their own rows.

Required grants:

```sql
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert on public.task_operations to authenticated;
```

If the app shows `Sync failed` and local tasks do not appear in Supabase, run:

```text
supabase/grants.sql
```

## Supabase Auth

The PWA uses email + password authentication:

```ts
supabase.auth.signInWithPassword(...)
supabase.auth.signUp(...)
```

Email confirmation may still redirect back to the app after sign-up, depending
on Supabase Auth provider settings. Supabase must allow the exact origin where
the app is running.

For local development, configure:

```text
Site URL:
http://localhost:5173

Redirect URLs:
http://localhost:5173/**
http://127.0.0.1:5173/**
```

After deployment, add the production HTTPS URL:

```text
Site URL:
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/

Redirect URLs:
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/**
```

Keep exact production URLs where possible. Wildcards are acceptable for local
development and preview deployments, but should be narrow in production.

## Email Rate Limit

If email-based auth returns:

```text
Email rate limit exceeded
```

the project has hit Supabase Auth email sending limits. Supabase's built-in
email provider is meant for demos and has a very low quota, currently documented
as 2 emails per hour for endpoints that trigger email sends. Magic links also
have a per-user cooldown window before another request can be sent.

Short-term options:

- Wait for the rate limit window to reset.
- Avoid repeatedly requesting confirmation or recovery emails.
- Use one browser session after signing in instead of requesting new links.

Current project option:

- Use password-based sign-in so routine testing does not depend on repeated
  magic-link emails.

Long-term option:

- Configure a custom SMTP provider in Supabase Auth if email-based login will be
  used regularly.

## Environment Variables

Frontend:

```text
VITE_SUPABASE_URL=https://vzojfajfpjdjeoavhtks.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_oVpjHxc8WK7c-aoPYtwOSw_aU0A1IUy
```

Backend, only if `apps/api` connects directly:

```text
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.vzojfajfpjdjeoavhtks.supabase.co:5432/postgres
SUPABASE_SERVICE_ROLE_KEY=
```

Never expose `DATABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` in the PWA.

## Initial Schema

The executable schema lives at:

```text
supabase/schema.sql
```

Run that file in the Supabase SQL Editor before using the PWA against the cloud
database.

```sql
create table public.tasks (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  deadline_at timestamptz not null,
  completed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tasks_user_active_deadline_idx
  on public.tasks (user_id, deleted_at, completed_at, deadline_at);

create index tasks_user_updated_idx
  on public.tasks (user_id, updated_at);

alter table public.tasks enable row level security;

create policy "Users can read their own tasks"
  on public.tasks
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own tasks"
  on public.tasks
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own tasks"
  on public.tasks
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own tasks"
  on public.tasks
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);
```

## Operation Sync Tables

When operation-based sync is added, create these tables:

```sql
create table public.task_operations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  operation_type text not null,
  operation_body jsonb not null,
  created_at timestamptz not null default now(),
  server_sequence bigint generated always as identity
);

create index task_operations_user_sequence_idx
  on public.task_operations (user_id, server_sequence);

alter table public.task_operations enable row level security;

create policy "Users can read their own task operations"
  on public.task_operations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own task operations"
  on public.task_operations
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);
```

## Connection Choice

If `apps/api` is hosted on a long-running server, use a normal persistent
Postgres connection string.

If `apps/api` is hosted as serverless functions, use a pooled connection string
and avoid prepared statements if the provider documents that limitation.

## Security Rules

- Enable RLS before exposing tables to the PWA.
- Use `auth.uid() = user_id` policies for user-owned rows.
- Use the anon key only in the browser.
- Use the service role key only on a trusted server.
- Do not commit `.env.local`.

## Development Flow

1. Start with direct Supabase access from `apps/web`.
2. Use IndexedDB as a local cache and pending-operation queue.
3. On sign-in, pull tasks from Supabase.
4. On local changes, update IndexedDB immediately, then write to Supabase.
5. Add `apps/api` once conflict handling becomes more complex.
