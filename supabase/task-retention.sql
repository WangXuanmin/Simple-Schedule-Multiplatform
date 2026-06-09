create extension if not exists pg_cron with schema pg_catalog;

create or replace function public.purge_completed_tasks()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.tasks
  where completed_at is not null
    and completed_at < now() - interval '1 month';
$$;

revoke all on function public.purge_completed_tasks() from public;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'expire-completed-tasks-daily') then
    perform cron.unschedule('expire-completed-tasks-daily');
  end if;

  if exists (select 1 from cron.job where jobname = 'purge-completed-tasks-daily') then
    perform cron.unschedule('purge-completed-tasks-daily');
  end if;
end $$;

drop function if exists public.expire_completed_tasks();

select cron.schedule(
  'purge-completed-tasks-daily',
  '17 3 * * *',
  $$select public.purge_completed_tasks();$$
);
