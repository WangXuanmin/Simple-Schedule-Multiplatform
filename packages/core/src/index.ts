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

export type TaskOperation =
  | { type: "task.create"; task: Task }
  | { type: "task.update"; taskId: string; patch: Partial<Task>; updatedAt: string }
  | { type: "task.complete"; taskId: string; completedAt: string; updatedAt: string }
  | { type: "task.reopen"; taskId: string; updatedAt: string }
  | { type: "task.delete"; taskId: string; deletedAt: string; updatedAt: string };

const COMPLETED_RETENTION_MS = 5 * 24 * 60 * 60 * 1000;

export function getTodoTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((task) => !task.deletedAt && !task.completedAt)
    .sort((a, b) => compareIso(a.deadlineAt, b.deadlineAt) || compareIso(a.createdAt, b.createdAt));
}

export function getCompletedTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((task) => !task.deletedAt && Boolean(task.completedAt))
    .sort((a, b) => compareIso(b.completedAt, a.completedAt) || compareIso(b.updatedAt, a.updatedAt));
}

export function hideExpiredCompletedTasks(tasks: Task[], now = new Date()): Task[] {
  const nowMs = now.getTime();
  return tasks.filter((task) => {
    if (!task.completedAt) return true;
    return nowMs - new Date(task.completedAt).getTime() < COMPLETED_RETENTION_MS;
  });
}

export function applyTaskOperation(tasks: Task[], operation: TaskOperation): Task[] {
  switch (operation.type) {
    case "task.create":
      return upsertTask(tasks, operation.task);
    case "task.update":
      return tasks.map((task) =>
        task.id === operation.taskId
          ? newerTask({ ...task, ...operation.patch, updatedAt: operation.updatedAt }, task)
          : task
      );
    case "task.complete":
      return tasks.map((task) =>
        task.id === operation.taskId
          ? newerTask({ ...task, completedAt: operation.completedAt, updatedAt: operation.updatedAt }, task)
          : task
      );
    case "task.reopen":
      return tasks.map((task) =>
        task.id === operation.taskId
          ? newerTask({ ...task, completedAt: null, updatedAt: operation.updatedAt }, task)
          : task
      );
    case "task.delete":
      return tasks.map((task) =>
        task.id === operation.taskId
          ? newerTask({ ...task, deletedAt: operation.deletedAt, updatedAt: operation.updatedAt }, task)
          : task
      );
  }
}

function upsertTask(tasks: Task[], incoming: Task): Task[] {
  const index = tasks.findIndex((task) => task.id === incoming.id);
  if (index === -1) return [...tasks, incoming];

  const next = tasks.slice();
  next[index] = newerTask(incoming, next[index]);
  return next;
}

function newerTask(incoming: Task, current: Task): Task {
  if (current.deletedAt && !incoming.deletedAt) return current;
  if (incoming.deletedAt && !current.deletedAt) return incoming;
  return new Date(incoming.updatedAt).getTime() >= new Date(current.updatedAt).getTime()
    ? incoming
    : current;
}

function compareIso(left: string | null, right: string | null): number {
  return new Date(left ?? 0).getTime() - new Date(right ?? 0).getTime();
}

