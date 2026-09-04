-- Legacy compatibility grants. Do not rerun after sync-v1-enforce.sql:
-- doing so would reopen direct task writes and disable strict enforcement.
grant usage on schema public to authenticated;

grant select, insert, update, delete
  on public.tasks
  to authenticated;

grant select, insert
  on public.task_operations
  to authenticated;

