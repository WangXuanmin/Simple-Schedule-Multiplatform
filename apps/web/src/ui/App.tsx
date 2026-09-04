import { getCompletedTasks, getTodoTasks, hideExpiredCompletedTasks, errorMessage, isRetryableSyncError, syncRetryDelay, type Task, type SyncConflict } from "@simple-schedule/core";
import type { User } from "@supabase/supabase-js";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createTask, deleteTask, loadCachedTasks, loadPendingWriteCount, loadConflicts, resolveConflict, syncFromCloud, toggleTask } from "../data/tasks";
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
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [strictSync, setStrictSync] = useState<boolean | null>(null);
  const [pendingWriteCount, setPendingWriteCount] = useState(0);
  const [isAdding, setIsAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [deadlineAt, setDeadlineAt] = useState(toInputValue(addHours(new Date(), 1)));
  const [syncState, setSyncState] = useState<SyncState>(navigator.onLine ? "idle" : "offline");
  const [message, setMessage] = useState("Ready");
  const [todayStartMs, setTodayStartMs] = useState(() => startOfDay(new Date()).getTime());

  const activeUserRef = useRef<string | null>(null);
  const syncRequestRef = useRef(0);
  const localRevisionRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => { clearTimeout(retryTimerRef.current); syncRequestRef.current += 1; }, []);

  const visibleTasks = useMemo(() => hideExpiredCompletedTasks(tasks), [tasks]);
  const todoTasks = useMemo(() => getTodoTasks(visibleTasks), [visibleTasks]);
  const completedTasks = useMemo(() => getCompletedTasks(visibleTasks), [visibleTasks]);
  const currentTasks = view === "todo" ? todoTasks : completedTasks;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      updateUser(data.session?.user ?? null);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      updateUser(session?.user ?? null);
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
    void loadConflicts(user).then((items) => {
      if (!cancelled) setConflicts(items);
    }).catch((error) => { if (!cancelled) setMessage(errorMessage(error)); });

    loadCachedTasks(user).then((cached) => {
      if (!cancelled) {
        showTasks(cached);
        void runSync(user);
      }
    }).catch((error) => { if (!cancelled) setMessage(errorMessage(error)); });
    loadPendingWriteCount(user).then((count) => {
      if (!cancelled) setPendingWriteCount(count);
    }).catch((error) => { if (!cancelled) setMessage(errorMessage(error)); });

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;

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
  }, [user?.id]);

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
  }, [user?.id]);

  function showTasks(nextTasks: Task[]) { setTasks(nextTasks); }

  function updateUser(nextUser: User | null) {
    if (activeUserRef.current !== (nextUser?.id ?? null)) {
      activeUserRef.current = nextUser?.id ?? null;
      syncRequestRef.current += 1;
      localRevisionRef.current += 1;
      clearTimeout(retryTimerRef.current);
      setTasks([]);
      setConflicts([]);
      setStrictSync(null);
      setPendingWriteCount(0);
      setMessage("等待同步");
    }
    setUser(nextUser);
  }

  async function runSync(activeUser = user, attempt = 0) {
    if (!activeUser || activeUserRef.current !== activeUser.id) return;
    clearTimeout(retryTimerRef.current);
    const request = ++syncRequestRef.current;
    const isCurrent = () => activeUserRef.current === activeUser.id && syncRequestRef.current === request;
    if (!navigator.onLine) {
      setSyncState("offline");
      setMessage("当前离线，本地修改已排队，联网后同步");
      return;
    }
    try {
      setSyncState("syncing");
      const result = await syncFromCloud(activeUser);
      const revision = localRevisionRef.current;
      const [cached, count] = await Promise.all([loadCachedTasks(activeUser), loadPendingWriteCount(activeUser)]);
      if (!isCurrent()) return;
      if (revision === localRevisionRef.current) showTasks(cached);
      setPendingWriteCount(count);
      setConflicts(result.conflicts);
      setStrictSync(result.strictSync);
      setSyncState(result.conflicts.length ? "error" : "idle");
      setMessage(result.conflicts.length ? `${result.conflicts.length} 个任务存在冲突，请选择处理方式` : count ? `${count} 条修改已保存到本机，待同步` : `已同步 ${new Date(result.syncedAt).toLocaleTimeString()}`);
    } catch (error) {
      if (!isCurrent()) return;
      setSyncState("error");
      setMessage(errorMessage(error));
      const delay = isRetryableSyncError(error) ? syncRetryDelay(attempt) : null;
      if (delay !== null) {
        retryTimerRef.current = setTimeout(() => {
          if (isCurrent()) void runSync(activeUser, attempt + 1);
        }, delay);
      }
    }
  }

  function localSaveCompleted(activeUser: User, nextTasks: Task[]) {
    if (activeUserRef.current !== activeUser.id) return;
    localRevisionRef.current += 1;
    showTasks(nextTasks);
    setMessage("已保存到本机，待同步");
    const revision = localRevisionRef.current;
    void loadPendingWriteCount(activeUser).then((count) => {
      if (activeUserRef.current === activeUser.id && revision === localRevisionRef.current) setPendingWriteCount(count);
    }).catch((error) => {
      if (activeUserRef.current === activeUser.id) setMessage(errorMessage(error));
    });
    void runSync(activeUser);
  }

  async function resolveTaskConflict(conflict: SyncConflict, copy: boolean) {
    if (!user) return;
    try {
      const nextTasks = await resolveConflict(user, conflict.requestId, copy);
      if (activeUserRef.current !== user.id) return;
      const nextConflicts = await loadConflicts(user);
      if (activeUserRef.current !== user.id) return;
      setConflicts(nextConflicts);
      localSaveCompleted(user, nextTasks);
    } catch (error) {
      if (activeUserRef.current === user.id) setMessage(errorMessage(error));
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
      const nextTasks = await createTask(user, title.trim(), new Date(deadlineAt).toISOString());
      if (activeUserRef.current !== user.id) return;
      localSaveCompleted(user, nextTasks);
      setTitle("");
      setDeadlineAt(toInputValue(addHours(new Date(), 1)));
      setIsAdding(false);
    } catch (error) {
      setSyncState("error");
      setMessage(error instanceof Error ? error.message : "Could not save task");
    }
  }

  async function toggle(task: Task) {
    if (!user) return;
    try {
      localSaveCompleted(user, await toggleTask(user, task));
    } catch (error) {
      if (activeUserRef.current === user.id) setMessage(`本地保存失败：${errorMessage(error)}`);
    }
  }

  async function remove(task: Task) {
    if (!user) return;
    try {
      localSaveCompleted(user, await deleteTask(user, task));
    } catch (error) {
      if (activeUserRef.current === user.id) setMessage(`本地保存失败：${errorMessage(error)}`);
    }
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
          <button
            className={`refresh-button ${syncState === "syncing" ? "is-syncing" : ""}`}
            type="button"
            aria-label="Refresh tasks"
            title="Refresh"
            disabled={syncState === "syncing"}
            onClick={() => runSync()}
          >
            <img src={`${import.meta.env.BASE_URL}icons/refresh.png`} alt="" aria-hidden="true" />
          </button>
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

        {strictSync === false ? <p className="sync-compatibility" role="status">当前兼容旧版客户端，完整冲突保护尚未启用。</p> : null}
        {conflicts.length > 0 ? (
          <section className="sync-conflicts" aria-label="同步冲突">
            {conflicts.map((conflict) => (
              <div key={conflict.requestId}>
                <strong>{conflict.local.title}</strong>
                <p>{conflict.reason}</p>
                <p>云端：{conflict.remote ? (conflict.remote.deletedAt ? "已删除" : conflict.remote.title) : "任务不存在"}</p>
                <button type="button" onClick={() => resolveTaskConflict(conflict, false)}>采用云端（放弃本地修改）</button>
                <button type="button" onClick={() => resolveTaskConflict(conflict, true)}>保留本地为新任务</button>
              </div>
            ))}
          </section>
        ) : null}

        <footer className="status-line" role="status">{message}{pendingWriteCount > 0 ? ` · ${pendingWriteCount} 待同步` : ""}</footer>
      </section>
    </main>
  );
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
