-- Runs against real PostgreSQL; all fixtures and permission changes roll back.
begin;
select set_config('test.owner_a', gen_random_uuid()::text, true);
select set_config('test.owner_b', gen_random_uuid()::text, true);
insert into auth.users(id) values(current_setting('test.owner_a')::uuid), (current_setting('test.owner_b')::uuid);
revoke insert, update, delete on public.tasks from public, anon, authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.owner_a'), true);
set local role authenticated;
do $test$
declare
  payload jsonb := jsonb_build_object('id', gen_random_uuid(), 'user_id', current_setting('test.owner_a'),
    'title', 'sync-v1-test', 'deadline_at', '2026-09-05T09:00:00Z', 'created_at', '2026-09-04T09:00:00Z',
    'updated_at', '2026-09-04T09:00:00Z', 'completed_at', null, 'deleted_at', null, 'urgency', 'normal');
  request_id uuid := gen_random_uuid();
  r jsonb;
begin
  r := public.write_task_v1(request_id, 0, payload);
  if r->>'status' <> 'applied' or r->'task'->>'version' <> '1' then raise exception 'create failed: %', r; end if;
  r := public.write_task_v1(request_id, 0, payload);
  if r->>'status' <> 'duplicate' or r->'task'->>'version' <> '1' then raise exception 'duplicate failed'; end if;
  begin
    perform public.write_task_v1(request_id, 0, payload || '{"title":"changed request"}');
    raise exception 'request ID reuse accepted';
  exception when invalid_parameter_value then null;
  end;
  r := public.write_task_v1(gen_random_uuid(), 0, payload);
  if r->>'status' <> 'conflict' then raise exception 'duplicate create overwrote task'; end if;
  r := public.write_task_v1(gen_random_uuid(), 1, payload || '{"title":"new","updated_at":"2000-01-01T00:00:00Z"}');
  if r->>'status' <> 'applied' or r->'task'->>'version' <> '2' then raise exception 'valid version with slow clock rejected'; end if;
  r := public.write_task_v1(gen_random_uuid(), 1, payload || '{"title":"stale","updated_at":"2099-01-01T00:00:00Z"}');
  if r->>'status' <> 'conflict' or r->'task'->>'title' <> 'new' then raise exception 'fast clock bypassed version'; end if;
  r := public.write_task_v1(gen_random_uuid(), 2, payload || '{"deleted_at":"2026-09-04T10:00:00Z"}');
  if r->>'status' <> 'applied' then raise exception 'delete failed'; end if;
  r := public.write_task_v1(gen_random_uuid(), 3, payload);
  if r->>'status' <> 'conflict' then raise exception 'implicit resurrection accepted'; end if;
  begin
    update public.tasks set title = 'bypass' where id = (payload->>'id')::uuid;
    raise exception 'direct update permitted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.task_write_receipts;
    raise exception 'receipt table exposed';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub', current_setting('test.owner_b'), true);
  if exists(select 1 from public.tasks where id = (payload->>'id')::uuid) then raise exception 'RLS leaked another owner'; end if;
  begin
    perform public.write_task_v1(gen_random_uuid(), 3, payload || jsonb_build_object('user_id',current_setting('test.owner_b')));
    raise exception 'cross-owner write permitted';
  exception when insufficient_privilege then null;
  end;
end $test$;
set local role anon;
do $test$
begin
  begin
    perform public.write_task_v1(gen_random_uuid(), 0, '{}'::jsonb);
    raise exception 'anonymous RPC permitted';
  exception when insufficient_privilege then null;
  end;
end $test$;
reset role;
do $test$
begin
  if (select count(*) from public.task_write_receipts where user_id = current_setting('test.owner_a')::uuid) <> 3 then
    raise exception 'unexpected receipt count';
  end if;
end $test$;
rollback;
select 'PASS: create, duplicate, request reuse, duplicate create, stale version, clock skew, delete/restore, direct-write gate, receipt privacy, owner RLS, anonymous rejection, receipt count; fixtures rolled back' as result;
