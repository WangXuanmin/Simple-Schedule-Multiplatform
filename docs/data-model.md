# Data Model

The same task model is used in IndexedDB and in the cloud database. IndexedDB
is a per-device cache; the cloud database is the shared source of truth for
Windows and iPhone sync.

## Task

```ts
export type Task = {
  id: string;
  userId: string;
  title: string;
  deadlineAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

## Important Rules

- `deadlineAt`, `createdAt`, `updatedAt`, and `completedAt` are ISO strings.
- Todo tasks have `completedAt === null` and `deletedAt === null`.
- Completed tasks have `completedAt !== null` and `deletedAt === null`.
- Deleted tasks are soft-deleted with `deletedAt !== null`.
- Completed tasks older than 5 days can be hidden or purged.

## Sort Rules

Todo:

1. Earlier `deadlineAt` first
2. Earlier `createdAt` as tie-breaker

Completed:

1. Later `completedAt` first
2. Later `updatedAt` as tie-breaker

## Operation Types

```ts
export type TaskOperation =
  | { type: "task.create"; task: Task }
  | { type: "task.update"; taskId: string; patch: Partial<Task>; updatedAt: string }
  | { type: "task.complete"; taskId: string; completedAt: string; updatedAt: string }
  | { type: "task.reopen"; taskId: string; updatedAt: string }
  | { type: "task.delete"; taskId: string; deletedAt: string; updatedAt: string };
```

## Cloud Tables

Minimum tables:

```text
users
tasks
task_operations
sync_cursors
```

Optional later table:

```text
web_push_subscriptions
```
