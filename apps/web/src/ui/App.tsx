import { getCompletedTasks, getTodoTasks, hideExpiredCompletedTasks, type Task } from "@simple-schedule/core";
import type { User } from "@supabase/supabase-js";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { createTask, deleteTask, loadCachedTasks, syncFromCloud, toggleTask } from "../data/tasks";
import { isSupabaseConfigured, supabase } from "../data/supabase";

type View = "todo" | "completed";
type SyncState = "idle" | "syncing" | "offline" | "error";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [view, setView] = useState<View>("todo");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [deadlineAt, setDeadlineAt] = useState(toInputValue(addHours(new Date(), 1)));
  const [syncState, setSyncState] = useState<SyncState>(navigator.onLine ? "idle" : "offline");
  const [message, setMessage] = useState("Ready");
  const [todayStartMs, setTodayStartMs] = useState(() => startOfDay(new Date()).getTime());

  const visibleTasks = useMemo(() => hideExpiredCompletedTasks(tasks), [tasks]);
  const todoTasks = useMemo(() => getTodoTasks(visibleTasks), [visibleTasks]);
  const completedTasks = useMemo(() => getCompletedTasks(visibleTasks), [visibleTasks]);
  const currentTasks = view === "todo" ? todoTasks : completedTasks;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const online = () => setSyncState("idle");
    const offline = () => setSyncState("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  useEffect(() => {
    let timeoutId: number;

    const refreshToday = () => setTodayStartMs(startOfDay(new Date()).getTime());
    const scheduleNextRefresh = () => {
      const now = new Date();
      const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      timeoutId = window.setTimeout(() => {
        refreshToday();
        scheduleNextRefresh();
      }, nextDay.getTime() - now.getTime());
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshToday();
    };

    scheduleNextRefresh();
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setTasks([]);
      return;
    }

    let cancelled = false;

    loadCachedTasks(user).then((cached) => {
      if (!cancelled) setTasks(cached);
    });

    runSync(user);

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (!user || !navigator.onLine) return;

    let syncTimerId: number | undefined;
    const syncSoon = () => {
      if (syncTimerId) window.clearTimeout(syncTimerId);
      syncTimerId = window.setTimeout(() => {
        runSync(user);
      }, 300);
    };

    const channel = supabase
      .channel(`tasks:${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tasks",
          filter: `user_id=eq.${user.id}`
        },
        syncSoon
      )
      .subscribe();

    return () => {
      if (syncTimerId) window.clearTimeout(syncTimerId);
      supabase.removeChannel(channel);
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;

    const syncWhenOnline = () => runSync(user);
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        runSync(user);
      }
    };

    window.addEventListener("online", syncWhenOnline);
    document.addEventListener("visibilitychange", syncWhenVisible);

    return () => {
      window.removeEventListener("online", syncWhenOnline);
      document.removeEventListener("visibilitychange", syncWhenVisible);
    };
  }, [user]);

  async function runSync(activeUser = user) {
    if (!activeUser || !navigator.onLine) {
      setSyncState("offline");
      setMessage("Offline. Local cache is available.");
      return;
    }

    try {
      setSyncState("syncing");
      const result = await syncFromCloud(activeUser);
      setTasks(result.tasks);
      setSyncState("idle");
      setMessage(`Synced ${formatSyncTime(result.syncedAt)}`);
    } catch (error) {
      setSyncState("error");
      setMessage(error instanceof Error ? error.message : "Sync failed");
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || password.length < 6) {
      setMessage("Use an email and a password with at least 6 characters.");
      return;
    }

    try {
      setMessage(authMode === "signin" ? "Signing in..." : "Creating account...");
      const { error } =
        authMode === "signin"
          ? await supabase.auth.signInWithPassword({
              email: email.trim(),
              password
            })
          : await supabase.auth.signUp({
              email: email.trim(),
              password,
              options: { emailRedirectTo: window.location.origin }
            });
      if (error) throw error;
      setMessage(authMode === "signin" ? "Signed in" : "Account created. Confirm email if Supabase requires it.");
    } catch (error) {
      setSyncState("error");
      setMessage(error instanceof Error ? error.message : "Authentication failed");
    }
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || !title.trim() || !deadlineAt) return;

    try {
      const nextTasks = await createTask(user, title.trim(), new Date(deadlineAt).toISOString(), tasks);
      setTasks(nextTasks);
      setTitle("");
      setDeadlineAt(toInputValue(addHours(new Date(), 1)));
      setIsAdding(false);
      setMessage("Task saved");
    } catch (error) {
      setSyncState("error");
      setMessage(error instanceof Error ? error.message : "Could not save task");
    }
  }

  async function toggle(task: Task) {
    if (!user) return;
    const nextTasks = await toggleTask(user, task, tasks);
    setTasks(nextTasks);
    setMessage(task.completedAt ? "Task reopened" : "Task completed");
  }

  async function remove(task: Task) {
    if (!user) return;
    const nextTasks = await deleteTask(user, task, tasks);
    setTasks(nextTasks);
    setMessage("Task deleted");
  }

  if (!isSupabaseConfigured) {
    return (
      <main className="app-shell">
        <section className="widget">
          <h1>Simple Schedule</h1>
          <p className="empty-state">Missing Supabase environment variables.</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="app-shell">
        <section className="widget auth-widget">
          <div className="brand-mark" aria-hidden="true" />
          <h1>Simple Schedule</h1>
          <p className="auth-copy">Use one account to sync tasks across Windows and iPhone.</p>
          <div className="segmented auth-tabs" role="tablist" aria-label="Authentication mode">
            <button className={authMode === "signin" ? "is-active" : ""} type="button" onClick={() => setAuthMode("signin")}>
              Sign in
            </button>
            <button className={authMode === "signup" ? "is-active" : ""} type="button" onClick={() => setAuthMode("signup")}>
              Sign up
            </button>
          </div>
          <form className="auth-form" onSubmit={submitAuth}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              autoComplete={authMode === "signin" ? "current-password" : "new-password"}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 6 characters"
            />
            <button type="submit">{authMode === "signin" ? "Sign in" : "Create account"}</button>
          </form>
          <p className="status-line">{message}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="widget" aria-label="Simple Schedule">
        <header className="widget-header">
          <div>
            <p className="eyebrow">{formatToday()}</p>
            <h1>Simple Schedule</h1>
          </div>
          <div className={`sync-pill is-${syncState}`}>{syncLabel(syncState)}</div>
        </header>

        <div className="segmented" role="tablist" aria-label="Task view">
          <button className={view === "todo" ? "is-active" : ""} type="button" onClick={() => setView("todo")}>
            Todo
          </button>
          <button
            className={view === "completed" ? "is-active" : ""}
            type="button"
            onClick={() => setView("completed")}
          >
            Completed
          </button>
        </div>

        {isAdding ? (
          <form className="add-panel" onSubmit={submitTask}>
            <label htmlFor="title">Task</label>
            <input
              id="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
              placeholder="Write project report"
            />
            <label htmlFor="deadline">Deadline</label>
            <input
              id="deadline"
              type="datetime-local"
              value={deadlineAt}
              onChange={(event) => setDeadlineAt(event.target.value)}
            />
            <div className="form-actions">
              <button type="submit">Save</button>
              <button type="button" onClick={() => setIsAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        <ol className="task-list">
          {currentTasks.length > 0 ? (
            currentTasks.map((task) => (
              <li
                className={`task-item ${task.completedAt ? "is-completed" : ""} ${
                  isOverdue(task, todayStartMs) ? "is-overdue" : ""
                }`}
                key={task.id}
              >
                <button className="circle-button" type="button" title="Toggle complete" onClick={() => toggle(task)}>
                  <span />
                </button>
                <div className="task-copy">
                  <strong>{task.title}</strong>
                  <small className={deadlineToneClass(task, todayStartMs)}>
                    {task.completedAt
                      ? `Completed ${formatCompleted(task.completedAt, todayStartMs)}`
                      : formatDeadline(task.deadlineAt, todayStartMs)}
                  </small>
                </div>
                <button className="delete-button" type="button" title="Delete" onClick={() => remove(task)}>
                  x
                </button>
              </li>
            ))
          ) : (
            <li className="empty-state">
              {view === "todo" ? "No todo tasks. Add one when you need it." : "No completed tasks yet."}
            </li>
          )}
        </ol>

        <div className="corner-actions" aria-label="Quick actions">
          <button className="icon-button primary" type="button" title="Add task" onClick={() => setIsAdding(true)}>
            +
          </button>
        </div>

        <footer className="status-line">{message}</footer>
      </section>
    </main>
  );
}

function syncLabel(state: SyncState) {
  if (state === "syncing") return "Syncing";
  if (state === "offline") return "Offline";
  if (state === "error") return "Check";
  return "Synced";
}

function formatToday() {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date());
}

function formatDeadline(value: string, todayStartMs: number) {
  const date = new Date(value);
  const target = startOfDay(date);
  const dayDiff = Math.round((target.getTime() - todayStartMs) / 86400000);
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);

  if (dayDiff === 0) return `Today - ${time}`;
  if (dayDiff === 1) return `Tomorrow - ${time}`;
  if (dayDiff === -1) return `Yesterday - ${time}`;

  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(date);
  return `${day} - ${time}`;
}

function formatCompleted(value: string, todayStartMs: number) {
  const date = new Date(value);
  const target = startOfDay(date);
  const dayDiff = Math.round((target.getTime() - todayStartMs) / 86400000);

  if (dayDiff === 0) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  if (dayDiff === -1) return "Yesterday";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(date);
}

function formatSyncTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function toInputValue(date: Date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function deadlineToneClass(task: Task, todayStartMs: number) {
  if (task.completedAt) return "";

  const target = startOfDay(new Date(task.deadlineAt));
  const dayDiff = Math.round((target.getTime() - todayStartMs) / 86400000);

  if (dayDiff <= 0) return "is-deadline-due";
  if (dayDiff < 3) return "is-deadline-soon";
  return "";
}

function isOverdue(task: Task, todayStartMs: number) {
  return !task.completedAt && startOfDay(new Date(task.deadlineAt)).getTime() <= todayStartMs;
}
