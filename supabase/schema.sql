create table if not exists public.tasks (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  deadline_at timestamptz not null,
  completed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_user_active_deadline_idx
  on public.tasks (user_id, deleted_at, completed_at, deadline_at);

create index if not exists tasks_user_updated_idx
  on public.tasks (user_id, updated_at);

alter table public.tasks enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;

drop policy if exists "Users can read their own tasks" on public.tasks;
drop policy if exists "Users can create their own tasks" on public.tasks;
drop policy if exists "Users can update their own tasks" on public.tasks;
drop policy if exists "Users can delete their own tasks" on public.tasks;

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

create table if not exists public.task_operations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null,
  operation_type text not null,
  operation_body jsonb not null,
  created_at timestamptz not null default now(),
  server_sequence bigint generated always as identity
);

create index if not exists task_operations_user_sequence_idx
  on public.task_operations (user_id, server_sequence);

alter table public.task_operations enable row level security;

grant select, insert on public.task_operations to authenticated;

drop policy if exists "Users can read their own task operations" on public.task_operations;
drop policy if exists "Users can create their own task operations" on public.task_operations;

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
