-- Additive rollout: legacy clients remain writable until sync-v1-enforce.sql.
begin;
alter table public.tasks add column if not exists version bigint not null default 1;

create or replace function public.task_assign_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then new.version := 1;
  else new.version := old.version + 1;
  end if;
  return new;
end $$;
revoke all on function public.task_assign_version() from public, anon, authenticated;
drop trigger if exists task_assign_version on public.tasks;
create trigger task_assign_version before insert or update on public.tasks
for each row execute function public.task_assign_version();

create table if not exists public.task_write_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  task_id uuid not null,
  base_version bigint not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);
alter table public.task_write_receipts enable row level security;
revoke all on public.task_write_receipts from public, anon, authenticated;

create or replace function public.write_task_v1(p_request_id uuid, p_base_version bigint, p_task jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  task_id uuid;
  current_task public.tasks%rowtype;
  receipt public.task_write_receipts%rowtype;
  result jsonb;
begin
  if owner_id is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_request_id is null or p_base_version is null or p_base_version < 0
    or p_task is null or jsonb_typeof(p_task) <> 'object' then
    raise exception 'Invalid write request' using errcode = '22023';
  end if;
  task_id := (p_task->>'id')::uuid;
  if task_id is null or (p_task->>'user_id')::uuid is distinct from owner_id then
    raise exception 'Invalid task owner' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_task->>'title')), 0) = 0
    or p_task->>'deadline_at' is null or p_task->>'created_at' is null or p_task->>'updated_at' is null
    or coalesce(p_task->>'urgency', '') not in ('normal', 'rush', 'urgent') then
    raise exception 'Invalid task fields' using errcode = '22023';
  end if;
  -- Lock identities even when neither a task nor a receipt exists yet.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text || ':request:' || p_request_id::text, 0));
  select * into receipt from public.task_write_receipts r where r.user_id = owner_id and r.request_id = p_request_id;
  if found then
    if receipt.task_id <> task_id or receipt.base_version <> p_base_version or receipt.payload <> p_task then
      raise exception 'Request ID reused with different content' using errcode = '22023';
    end if;
    return jsonb_build_object('status', 'duplicate', 'task', receipt.result);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('task:' || task_id::text, 0));
  select * into current_task from public.tasks t where t.id = task_id for update;
  if found then
    if current_task.user_id <> owner_id then raise exception 'Task not accessible' using errcode = '42501'; end if;
    if current_task.version <> p_base_version or (current_task.deleted_at is not null and p_task->>'deleted_at' is null) then
      return jsonb_build_object('status', 'conflict', 'task', to_jsonb(current_task));
    end if;
    update public.tasks set
      title = p_task->>'title', deadline_at = (p_task->>'deadline_at')::timestamptz,
      completed_at = (p_task->>'completed_at')::timestamptz, deleted_at = (p_task->>'deleted_at')::timestamptz,
      urgency = p_task->>'urgency', updated_at = (p_task->>'updated_at')::timestamptz
    where id = task_id returning * into current_task;
  else
    if p_base_version <> 0 then return jsonb_build_object('status', 'conflict', 'task', null); end if;
    insert into public.tasks(id, user_id, title, deadline_at, completed_at, deleted_at, urgency, created_at, updated_at)
    values (task_id, owner_id, p_task->>'title', (p_task->>'deadline_at')::timestamptz,
      (p_task->>'completed_at')::timestamptz, (p_task->>'deleted_at')::timestamptz,
      p_task->>'urgency', (p_task->>'created_at')::timestamptz, (p_task->>'updated_at')::timestamptz)
    on conflict(id) do nothing returning * into current_task;
    if not found then
      select * into current_task from public.tasks t where t.id = task_id;
      if current_task.user_id <> owner_id then raise exception 'Task not accessible' using errcode = '42501'; end if;
      return jsonb_build_object('status', 'conflict', 'task', to_jsonb(current_task));
    end if;
  end if;
  result := to_jsonb(current_task);
  insert into public.task_write_receipts(user_id, request_id, task_id, base_version, payload, result)
  values(owner_id, p_request_id, task_id, p_base_version, p_task, result);
  return jsonb_build_object('status', 'applied', 'task', result);
end $$;
revoke all on function public.write_task_v1(uuid, bigint, jsonb) from public, anon;
grant execute on function public.write_task_v1(uuid, bigint, jsonb) to authenticated;

create or replace function public.task_sync_capabilities_v1()
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('protocol', 1, 'strict',
    not pg_catalog.has_table_privilege('authenticated', 'public.tasks', 'INSERT')
    and not pg_catalog.has_table_privilege('authenticated', 'public.tasks', 'UPDATE')
    and not pg_catalog.has_table_privilege('authenticated', 'public.tasks', 'DELETE'));
$$;
revoke all on function public.task_sync_capabilities_v1() from public, anon;
grant execute on function public.task_sync_capabilities_v1() to authenticated;
notify pgrst, 'reload schema';
commit;
