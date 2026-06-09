alter table public.tasks
  add column if not exists urgency text;

update public.tasks
  set urgency = 'normal'
  where urgency is null;

alter table public.tasks
  alter column urgency set default 'normal',
  alter column urgency set not null;

alter table public.tasks
  drop constraint if exists tasks_urgency_check;

alter table public.tasks
  add constraint tasks_urgency_check
  check (urgency in ('normal', 'rush', 'urgent'));
