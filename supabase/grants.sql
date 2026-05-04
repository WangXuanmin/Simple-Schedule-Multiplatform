grant usage on schema public to authenticated;

grant select, insert, update, delete
  on public.tasks
  to authenticated;

grant select, insert
  on public.task_operations
  to authenticated;

