// An SQLite trigger runs in the same transaction as its initiating INSERT.
// Separate BEGIN/COMMIT calls through a connection pool cannot guarantee that.
export const QUEUE_TASK_TRIGGER = `
create trigger if not exists persist_queued_task_v1
after insert on pending_task_writes
begin
  select case when json_extract(new.task_json, '$.id') is not new.task_id
    or json_extract(new.task_json, '$.userId') is not new.user_id
    then raise(abort, 'Pending task identity mismatch') end;
  insert into tasks (id, user_id, title, deadline_at, completed_at, deleted_at, urgency, created_at, updated_at, version)
  values (new.task_id, new.user_id,
    json_extract(new.task_json, '$.title'), json_extract(new.task_json, '$.deadlineAt'),
    json_extract(new.task_json, '$.completedAt'), json_extract(new.task_json, '$.deletedAt'),
    json_extract(new.task_json, '$.urgency'), json_extract(new.task_json, '$.createdAt'),
    json_extract(new.task_json, '$.updatedAt'), json_extract(new.task_json, '$.version'))
  on conflict(id) do update set
    title = excluded.title, deadline_at = excluded.deadline_at,
    completed_at = excluded.completed_at, deleted_at = excluded.deleted_at,
    urgency = excluded.urgency, updated_at = excluded.updated_at, version = coalesce(tasks.version, excluded.version)
  where tasks.user_id = excluded.user_id;
  update pending_task_writes set
    depends_on = (select p.id from pending_task_writes p where p.user_id = new.user_id and p.task_id = new.task_id and p.rowid < new.rowid order by p.rowid desc limit 1),
    base_version = case when exists(select 1 from pending_task_writes p where p.user_id = new.user_id and p.task_id = new.task_id and p.rowid < new.rowid)
      then null else json_extract(new.task_json, '$.version') end
  where id = new.id;
  select case when (select user_id from tasks where id = new.task_id) <> new.user_id
    then raise(abort, 'Task belongs to another account') end;
end
`;

export const CACHE_UPDATE_GUARD = `
  tasks.user_id = excluded.user_id
  and not exists (select 1 from pending_task_writes p where p.user_id = tasks.user_id and p.task_id = tasks.id)
  and (
    (excluded.version is not null and (tasks.version is null or excluded.version > tasks.version))
    or ((excluded.version is tasks.version) and (
    (tasks.deleted_at is null and excluded.deleted_at is not null)
    or ((tasks.deleted_at is null) = (excluded.deleted_at is null)
      and julianday(excluded.updated_at) >= julianday(tasks.updated_at))
  )))
`;

export const TASK_TABLE_SQL = `
    create table if not exists tasks (
      id text primary key,
      user_id text not null,
      title text not null,
      deadline_at text not null,
      completed_at text,
      deleted_at text,
      urgency text not null default 'normal',
      created_at text not null,
      updated_at text not null,
      version integer
    )
  `;

export const PENDING_TABLE_SQL = `
    create table if not exists pending_task_writes (
      id text primary key,
      user_id text not null,
      task_id text not null,
      task_json text not null,
      created_at text not null,
      retry_count integer not null default 0,
      last_error text,
      base_version integer,
      depends_on text,
      conflict_json text,
      ack_json text,
      resolution_json text
    )
  `;

export const QUEUE_INSERT_SQL = `insert into pending_task_writes (
      id,
      user_id,
      task_id,
      task_json,
      created_at,
      retry_count,
      last_error
    )
    values ($1, $2, $3, $4, $5, $6, $7)
    on conflict(id) do nothing`;

export const CACHE_UPSERT_SQL = `insert into tasks (
      id,
      user_id,
      title,
      deadline_at,
      completed_at,
      deleted_at,
      urgency,
      created_at,
      updated_at, version
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    on conflict(id) do update set
      user_id = excluded.user_id,
      title = excluded.title,
      deadline_at = excluded.deadline_at,
      completed_at = excluded.completed_at,
      deleted_at = excluded.deleted_at,
      urgency = excluded.urgency,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at, version = excluded.version
    where ${CACHE_UPDATE_GUARD}`;

export const ACK_TRIGGER = `
create trigger if not exists acknowledge_pending_v1
after update of ack_json on pending_task_writes when new.ack_json is not null
begin
  select case when json_extract(new.ack_json, '$.id') is not new.task_id
    or json_extract(new.ack_json, '$.userId') is not new.user_id
    or json_extract(new.ack_json, '$.version') is not new.base_version + 1
    then raise(abort, 'Invalid acknowledgement') end;
  update tasks set version = json_extract(new.ack_json, '$.version') where id = new.task_id and user_id = new.user_id;
  update tasks set
    title = json_extract(new.ack_json, '$.title'), deadline_at = json_extract(new.ack_json, '$.deadlineAt'),
    completed_at = json_extract(new.ack_json, '$.completedAt'), deleted_at = json_extract(new.ack_json, '$.deletedAt'),
    urgency = json_extract(new.ack_json, '$.urgency'), created_at = json_extract(new.ack_json, '$.createdAt'),
    updated_at = json_extract(new.ack_json, '$.updatedAt')
  where id = new.task_id and user_id = new.user_id
    and not exists(select 1 from pending_task_writes p where p.user_id = new.user_id and p.task_id = new.task_id and p.id <> new.id);
  update pending_task_writes set base_version = json_extract(new.ack_json, '$.version'), depends_on = null
    where depends_on = new.id and user_id = new.user_id and task_id = new.task_id;
  delete from pending_task_writes where id = new.id;
end`;

export const RESOLUTION_TRIGGER = `
create trigger if not exists resolve_conflict_v1
after update of resolution_json on pending_task_writes when new.resolution_json is not null
begin
  select case when new.conflict_json is null or
    json_extract(new.resolution_json, '$.expectedLatestId') is not
      (select p.id from pending_task_writes p where p.user_id = new.user_id and p.task_id = new.task_id order by p.rowid desc limit 1)
    then raise(abort, 'Conflict changed; reload before resolving') end;
  insert into pending_task_writes(id, user_id, task_id, task_json, created_at, retry_count)
    select json_extract(new.resolution_json, '$.requestId'), new.user_id,
      json_extract(new.resolution_json, '$.copy.id'), json_extract(new.resolution_json, '$.copy'),
      json_extract(new.resolution_json, '$.copy.createdAt'), 0
    where json_type(new.resolution_json, '$.copy') = 'object';
  update tasks set
    title = json_extract(new.conflict_json, '$.task.title'), deadline_at = json_extract(new.conflict_json, '$.task.deadlineAt'),
    completed_at = json_extract(new.conflict_json, '$.task.completedAt'), deleted_at = json_extract(new.conflict_json, '$.task.deletedAt'),
    urgency = json_extract(new.conflict_json, '$.task.urgency'), created_at = json_extract(new.conflict_json, '$.task.createdAt'),
    updated_at = json_extract(new.conflict_json, '$.task.updatedAt'), version = json_extract(new.conflict_json, '$.task.version')
    where id = new.task_id and user_id = new.user_id and json_type(new.conflict_json, '$.task') = 'object';
  delete from tasks where id = new.task_id and user_id = new.user_id and json_type(new.conflict_json, '$.task') = 'null';
  delete from pending_task_writes where user_id = new.user_id and task_id = new.task_id;
end`;
