-- Activate only when legacy clients no longer need to upload.
-- Existing rows remain intact. The RPC is SECURITY DEFINER and enforces auth.uid().
begin;
revoke insert, update, delete on public.tasks from public, anon, authenticated;
grant select on public.tasks to authenticated;
-- Retain tombstones so an old offline create cannot resurrect a purged ID.
create or replace function public.purge_completed_tasks()
returns void language sql security definer set search_path = '' as $$
  update public.tasks set deleted_at = now(), updated_at = now()
  where completed_at < now() - interval '1 month' and deleted_at is null;
$$;
revoke all on function public.purge_completed_tasks() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
