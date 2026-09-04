-- A single result avoids APIs returning only the final statement's result set.
select jsonb_build_object(
  'database_version', version(),
  'capabilities', public.task_sync_capabilities_v1(),
  'task_policies', (select jsonb_agg(jsonb_build_object('name', policyname, 'command', cmd, 'using', qual, 'check', with_check))
    from pg_policies where schemaname = 'public' and tablename = 'tasks'),
  'temporary_test_users_remaining', (select count(*) from auth.users
    where email like 'codex-sync-test-%@example.invalid' and raw_user_meta_data->>'purpose' = 'temporary sync-v1 integration test'),
  'receipt_rls', (select relrowsecurity from pg_class where oid = 'public.task_write_receipts'::regclass),
  'retention_jobs', (select jsonb_agg(jsonb_build_object('name', jobname, 'command', command, 'active', active)) from cron.job)
) as verification;
