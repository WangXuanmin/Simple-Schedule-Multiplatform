import {
  errorMessage,
  isRetryableSyncError,
  syncRetryDelay,
  getCompletedTasks,
  getTodoTasks,
  hideExpiredCompletedTasks,
  type Task,
  type SyncConflict,
  type TaskUrgency
} from "@simple-schedule/core";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { User } from "@supabase/supabase-js";
import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  createTask,
  deleteTask,
  loadCachedTasks,
  loadConflicts,
  resolveConflict,
  loadPendingTaskIds,
  loadPendingWriteCount,
  syncFromCloud,
  toggleTask,
  updateTask,
  type TaskInput
} from "../data/tasks";
import { isSupabaseConfigured, supabase } from "../data/supabase";

type View = "today" | "all" | "completed";
type TaskFilter = "all" | "overdue" | "rush" | "urgent";
type SyncState = "idle" | "syncing" | "offline" | "error";

type Draft = {
  title: string;
  deadlineAt: string;
  urgency: TaskUrgency;
};

type PendingDelete = {
  task: Task;
  timerId: number;
};

const QUICK_CREATE_SHORTCUT = "CommandOrControl+Shift+A";

const blankDraft = (): Draft => ({
  title: "",
  deadlineAt: toInputValue(addHours(new Date(), 1)),
  urgency: "normal"
});

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [view, setView] = useState<View>("today");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState<Draft>(() => blankDraft());
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [syncState, setSyncState] = useState<SyncState>(navigator.onLine ? "idle" : "offline");
  const [message, setMessage] = useState("就绪");
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [strictSync, setStrictSync] = useState<boolean | null>(null);
  const [pendingWriteCount, setPendingWriteCount] = useState(0);
  const [pendingTaskIds, setPendingTaskIds] = useState<string[]>([]);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => readNotificationsEnabled());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [todayStartMs, setTodayStartMs] = useState(() => startOfDay(new Date()).getTime());
  const titleInputRef = useRef<HTMLInputElement>(null);
  const tasksRef = useRef<Task[]>([]);
  const notifiedTaskKeysRef = useRef<Set<string>>(new Set());
  const notificationPermissionRef = useRef<boolean | null>(null);

  const activeUserRef = useRef<string | null>(null);
  const syncRequestRef = useRef(0);
  const localRevisionRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => { clearTimeout(retryTimerRef.current); syncRequestRef.current += 1; }, []);

  const visibleTasks = useMemo(() => hideExpiredCompletedTasks(tasks), [tasks]);
  const todoTasks = useMemo(() => getTodoTasks(visibleTasks), [visibleTasks]);
  const todayTasks = useMemo(
    () => todoTasks.filter((task) => isDueOrOverdue(task, todayStartMs)),
    [todoTasks, todayStartMs]
  );
  const completedTasks = useMemo(() => getCompletedTasks(visibleTasks), [visibleTasks]);
  const baseTasks = view === "today" ? todayTasks : view === "all" ? todoTasks : completedTasks;
  const currentTasks = useMemo(
    () => (view === "completed" ? baseTasks : applyTaskFilter(baseTasks, taskFilter, todayStartMs)),
    [baseTasks, taskFilter, todayStartMs, view]
  );

  const summary = useMemo(() => {
    const todo = tasks.filter((task) => !task.deletedAt && !task.completedAt);
    return {
      due: todo.filter((task) => isDueOrOverdue(task, todayStartMs)).length,
      priority: todo.filter((task) => task.urgency !== "normal").length,
      completed: completedTasks.length
    };
  }, [completedTasks.length, tasks, todayStartMs]);
  const syncStatus = syncStatusText(syncState, pendingWriteCount);
  const isComposerOpen = isAddOpen || Boolean(editingTask);
  const showComposerDetails = Boolean(editingTask) || isComposerExpanded;
  const inferredDeadline = useMemo(() => inferDeadlineFromText(draft.title), [draft.title]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    return () => {
      if (pendingDelete) window.clearTimeout(pendingDelete.timerId);
    };
  }, [pendingDelete]);

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
    let unlistenSync: (() => void) | undefined;
    let unlistenTopmost: (() => void) | undefined;
    let unlistenNewTask: (() => void) | undefined;
    let unlistenAutostart: (() => void) | undefined;

    listen("sync-requested", () => {
      runSync();
    }).then((nextUnlisten) => {
      unlistenSync = nextUnlisten;
    });

    listen<boolean>("topmost-changed", (event) => {
      setAlwaysOnTop(Boolean(event.payload));
    }).then((nextUnlisten) => {
      unlistenTopmost = nextUnlisten;
    });

    listen("new-task-requested", () => {
      beginCreate();
    }).then((nextUnlisten) => {
      unlistenNewTask = nextUnlisten;
    });

    listen<boolean>("autostart-changed", (event) => {
      setMessage(Boolean(event.payload) ? "已开启开机自启" : "已关闭开机自启");
    }).then((nextUnlisten) => {
      unlistenAutostart = nextUnlisten;
    });

    return () => {
      unlistenSync?.();
      unlistenTopmost?.();
      unlistenNewTask?.();
      unlistenAutostart?.();
    };
  }, [user?.id]);

  useEffect(() => {
    let active = true;
    register(QUICK_CREATE_SHORTCUT, () => {
      void getCurrentWindow().show();
      void getCurrentWindow().setFocus();
      beginCreate();
    })
      .then(() => {
        if (active) setMessage(`快捷键 ${shortcutLabel()} 可新建任务`);
      })
      .catch(() => {
        if (active) setMessage("全局快捷键不可用");
      });

    return () => {
      active = false;
      unregister(QUICK_CREATE_SHORTCUT).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const online = () => {
      setSyncState("idle");
      runSync();
    };
    const offline = () => setSyncState("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [user?.id]);

  useEffect(() => {
    const refreshToday = () => setTodayStartMs(startOfDay(new Date()).getTime());
    const intervalId = window.setInterval(refreshToday, 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!isAddOpen && !editingTask) return;
    const frameId = window.requestAnimationFrame(() => titleInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [isAddOpen, editingTask]);

  useEffect(() => {
    if (!user) {
      setTasks([]);
      setConflicts([]);
      setStrictSync(null);
      setPendingWriteCount(0);
      setPendingTaskIds([]);
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
    loadPendingTaskIds(user).then((ids) => {
      if (!cancelled) setPendingTaskIds(ids);
    }).catch((error) => { if (!cancelled) setMessage(errorMessage(error)); });

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    const intervalId = window.setInterval(() => {
      refreshPendingState(user)
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(intervalId);
  }, [user?.id]);

  useEffect(() => {
    if (!user || !notificationsEnabled) return;
    notifyDueTasks(todoTasks, notifiedTaskKeysRef, notificationPermissionRef).catch(() => undefined);
    const intervalId = window.setInterval(() => {
      notifyDueTasks(tasksRef.current.filter((task) => !task.deletedAt && !task.completedAt), notifiedTaskKeysRef, notificationPermissionRef)
        .catch(() => undefined);
    }, 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, [notificationsEnabled, todoTasks, user]);

  const pendingDeleteRef = useRef(pendingDelete);
  pendingDeleteRef.current = pendingDelete;

  function showTasks(nextTasks: Task[]) {
    const hidden = pendingDeleteRef.current?.task;
    setTasks(nextTasks.map((task) => task.id === hidden?.id ? { ...task, deletedAt: hidden.deletedAt ?? task.updatedAt } : task));
  }

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
      setPendingTaskIds([]);
      if (pendingDeleteRef.current) clearTimeout(pendingDeleteRef.current.timerId);
      pendingDeleteRef.current = null;
      setPendingDelete(null);
    }
    setUser(nextUser);
  }

  useEffect(() => {
    const foreground = () => {
      if (document.visibilityState === "visible") void runSync(user);
    };
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [user?.id]);

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

  function refreshPendingCountSoon(activeUser = user) {
    if (!activeUser) return;
    const refresh = () => {
      refreshPendingState(activeUser)
        .catch(() => undefined);
    };
    refresh();
    window.setTimeout(refresh, 700);
    window.setTimeout(refresh, 2200);
  }

  async function refreshPendingState(activeUser = user) {
    if (!activeUser) return;
    const [count, ids] = await Promise.all([loadPendingWriteCount(activeUser), loadPendingTaskIds(activeUser)]);
    if (activeUserRef.current !== activeUser.id) return;
    setPendingWriteCount(count);
    setPendingTaskIds(ids);
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
      setMessage("请输入邮箱和至少 6 位密码");
      return;
    }

    try {
      setMessage(authMode === "signin" ? "正在登录..." : "正在创建账户...");
      const { error } =
        authMode === "signin"
          ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
          : await supabase.auth.signUp({ email: email.trim(), password });
      if (error) throw error;
      setMessage(authMode === "signin" ? "已登录" : "账户已创建，如需验证请查看邮箱");
    } catch (error) {
      setSyncState("error");
      setMessage(error instanceof Error ? error.message : "Authentication failed");
    }
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;

    const input = draftToInput(draft);
    if (!input) {
      setMessage("请填写任务标题和截止时间");
      return;
    }

    try {
      const nextTasks = editingTask
        ? await updateTask(user, editingTask, input)
        : await createTask(user, input);
      if (activeUserRef.current !== user.id) return;
      localSaveCompleted(user, nextTasks);
      refreshPendingCountSoon(user);
      setDraft(blankDraft());
      setIsAddOpen(false);
      setIsComposerExpanded(false);
      setEditingTask(null);
    } catch (error) {
      if (activeUserRef.current !== user?.id) return;
      setSyncState("error");
      setMessage(error instanceof Error ? error.message : "任务保存失败");
    }
  }

  async function toggle(task: Task) {
    if (!user) return;
    try {
      const nextTasks = await toggleTask(user, task);
      if (activeUserRef.current !== user.id) return;
      localSaveCompleted(user, nextTasks);
      refreshPendingCountSoon(user);
    } catch (error) {
      if (activeUserRef.current !== user?.id) return;
      setSyncState("error");
      setMessage(error instanceof Error ? error.message : "任务状态更新失败");
    }
  }

  async function remove(task: Task) {
    if (!user) return;
    if (pendingDelete) {
      window.clearTimeout(pendingDelete.timerId);
      void commitDelete(pendingDelete.task);
    }

    const now = new Date().toISOString();
    setTasks((current) =>
      current.map((currentTask) =>
        currentTask.id === task.id ? { ...currentTask, deletedAt: now, updatedAt: now } : currentTask
      )
    );

    const timerId = window.setTimeout(() => {
      if (pendingDeleteRef.current?.task.id === task.id) pendingDeleteRef.current = null;
      setPendingDelete((current) => (current?.task.id === task.id ? null : current));
      void commitDelete(task);
    }, 5000);

    pendingDeleteRef.current = { task, timerId };
    setPendingDelete({ task, timerId });
    setMessage("删除将在 5 秒后保存，可撤销");
  }

  async function commitDelete(task: Task) {
    if (!user || activeUserRef.current !== user.id) return;
    try {
      const nextTasks = await deleteTask(user, task);
      if (activeUserRef.current !== user.id) return;
      localSaveCompleted(user, nextTasks);
      refreshPendingCountSoon(user);
    } catch (error) {
      if (activeUserRef.current !== user?.id) return;
      setSyncState("error");
      try {
        const cached = await loadCachedTasks(user);
        if (activeUserRef.current !== user.id) return;
        showTasks(cached);
      } catch {
        if (activeUserRef.current !== user.id) return;
        setTasks((current) => current.map((item) => item.id === task.id ? task : item));
      }
      setMessage(errorMessage(error));
    }
  }

  function undoDelete() {
    if (!pendingDelete || !user) return;
    window.clearTimeout(pendingDelete.timerId);
    setTasks((current) =>
      current.map((task) =>
        task.id === pendingDelete.task.id
          ? pendingDelete.task
          : task
      )
    );
    pendingDeleteRef.current = null;
    setPendingDelete(null);
    void loadCachedTasks(user).then((cached) => {
      if (activeUserRef.current === user.id) showTasks(cached);
    }).catch((error) => {
      if (activeUserRef.current === user.id) setMessage(errorMessage(error));
    });
    setMessage("已撤销删除");
  }

  function beginCreate() {
    setView("all");
    setEditingTask(null);
    setDraft(blankDraft());
    setIsComposerExpanded(false);
    setIsAddOpen(true);
  }

  function beginEdit(task: Task) {
    setEditingTask(task);
    setIsComposerExpanded(true);
    setIsAddOpen(true);
    setDraft({
      title: task.title,
      deadlineAt: toInputValue(new Date(task.deadlineAt)),
      urgency: task.urgency
    });
  }

  function cancelForm() {
    setIsAddOpen(false);
    setIsComposerExpanded(false);
    setEditingTask(null);
    setDraft(blankDraft());
  }

  async function changeUrgency(task: Task, urgency: TaskUrgency) {
    if (!user || task.urgency === urgency) return;
    try {
      const nextTasks = await updateTask(
        user,
        task,
        {
          title: task.title,
          deadlineAt: task.deadlineAt,
          urgency
        }
      );
      if (activeUserRef.current !== user.id) return;
      localSaveCompleted(user, nextTasks);
      refreshPendingCountSoon(user);
    } catch (error) {
      setSyncState("error");
      setMessage(error instanceof Error ? error.message : "紧急度更新失败");
    }
  }

  async function cycleUrgency(task: Task) {
    const next = nextUrgency(task.urgency);
    await changeUrgency(task, next);
  }

  function cycleDraftUrgency() {
    setDraft((current) => ({ ...current, urgency: nextUrgency(current.urgency) }));
  }

  function selectFilteredView(nextView: View, nextFilter: TaskFilter) {
    setView(nextView);
    setTaskFilter(nextFilter);
    setIsFilterOpen(false);
  }

  function selectFilter(nextFilter: TaskFilter) {
    setTaskFilter(nextFilter);
    setIsFilterOpen(false);
  }

  function updateDraftTitle(title: string) {
    setDraft(parseDraftTitle({ ...draft, title }));
    if (title.trim()) setIsComposerExpanded(true);
  }

  function toggleNotifications() {
    setNotificationsEnabled((current) => {
      const next = !current;
      localStorage.setItem("simple-schedule.notifications-enabled", String(next));
      setMessage(next ? "已开启到期提醒" : "已关闭到期提醒");
      return next;
    });
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelForm();
    }
  }

  async function toggleTopmost() {
    const nextValue = !alwaysOnTop;
    await invoke("set_always_on_top", { enabled: nextValue });
    setAlwaysOnTop(nextValue);
  }

  async function minimizeWindow() {
    await invoke("minimize_window");
  }

  async function hideWindow() {
    await invoke("hide_window");
  }

  function startDragging(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    void getCurrentWindow().startDragging();
  }

  if (!isSupabaseConfigured) {
    return (
      <main className="app-shell">
        <section className="auth-panel">
          <h1>Simple Schedule</h1>
          <p>Missing Supabase environment variables.</p>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="app-shell">
        <section className="auth-panel">
          <div className="brand-mark" aria-hidden="true" />
          <h1>Simple Schedule</h1>
          <p>同步你的任务列表，常驻 Windows 桌面。</p>
          <div className="segmented" role="tablist" aria-label="Authentication mode">
            <button className={authMode === "signin" ? "is-active" : ""} type="button" onClick={() => setAuthMode("signin")}>
              登录
            </button>
            <button className={authMode === "signup" ? "is-active" : ""} type="button" onClick={() => setAuthMode("signup")}>
              注册
            </button>
          </div>
          <form className="stack-form" onSubmit={submitAuth}>
            <label htmlFor="email">邮箱</label>
            <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <label htmlFor="password">密码</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button type="submit">{authMode === "signin" ? "登录" : "创建账户"}</button>
          </form>
          <p className="status-line">{message}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="task-surface" aria-label="Simple Schedule">
        <header className="titlebar">
          <div className="drag-region" data-tauri-drag-region onMouseDown={startDragging}>
            <p>{formatToday()}</p>
          </div>
          <div className="window-actions">
            <button className="icon-button" type="button" title="同步" aria-label="同步" disabled={syncState === "syncing"} onClick={() => runSync()}>
              ↻
            </button>
            <button
              className={`icon-button ${alwaysOnTop ? "is-active" : ""}`}
              type="button"
              title="置顶"
              aria-label="置顶"
              onClick={toggleTopmost}
            >
              ^
            </button>
            <button className="icon-button" type="button" title="最小化" aria-label="最小化" onClick={minimizeWindow}>
              -
            </button>
            <button className="icon-button" type="button" title="隐藏到托盘" aria-label="隐藏到托盘" onClick={hideWindow}>
              x
            </button>
          </div>
        </header>

        <div className="summary-strip" aria-label="Task summary">
          <SummaryMetric icon="!" label="今日/逾期" value={summary.due} onClick={() => selectFilteredView("today", "all")} />
          <SummaryMetric icon="!!" label="加急/紧急" value={summary.priority} onClick={() => selectFilteredView("all", "rush")} />
          <SummaryMetric icon="✓" label="最近完成" value={summary.completed} onClick={() => selectFilteredView("completed", "all")} />
        </div>

        <div className="segmented" role="tablist" aria-label="Task view">
          <button className={view === "today" ? "is-active" : ""} type="button" onClick={() => selectFilteredView("today", "all")}>
            今日
          </button>
          <button className={view === "all" ? "is-active" : ""} type="button" onClick={() => selectFilteredView("all", "all")}>
            全部
          </button>
          <button className={view === "completed" ? "is-active" : ""} type="button" onClick={() => selectFilteredView("completed", "all")}>
            已完成
          </button>
        </div>

        {view !== "completed" ? (
          <div className="filter-bar" aria-label="Task filters">
            <div className="filter-menu-wrap">
              <button
                className={`filter-menu-button ${taskFilter !== "all" ? "is-active" : ""}`}
                type="button"
                aria-expanded={isFilterOpen}
                onClick={() => setIsFilterOpen((current) => !current)}
              >
                {filterLabel(taskFilter)}
              </button>
              {isFilterOpen ? (
                <div className="filter-menu" role="menu">
                  <FilterMenuItem value="all" active={taskFilter === "all"} onClick={selectFilter}>
                    全部
                  </FilterMenuItem>
                  <FilterMenuItem value="overdue" active={taskFilter === "overdue"} onClick={selectFilter}>
                    逾期
                  </FilterMenuItem>
                  <FilterMenuItem value="rush" active={taskFilter === "rush"} onClick={selectFilter}>
                    加急
                  </FilterMenuItem>
                  <FilterMenuItem value="urgent" active={taskFilter === "urgent"} onClick={selectFilter}>
                    紧急
                  </FilterMenuItem>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <ol className="task-list">
          {currentTasks.length > 0 ? (
            currentTasks.map((task) => (
              <li
                className={`task-item ${task.completedAt ? "is-completed" : ""} ${
                  isDueOrOverdue(task, todayStartMs) ? "is-overdue" : ""
                }`}
                key={task.id}
              >
                <button className="circle-button" type="button" title={task.completedAt ? "恢复任务" : "完成任务"} onClick={() => toggle(task)}>
                  <span />
                </button>
                <div className="task-copy-wrap">
                  <button className="task-copy" type="button" onClick={() => beginEdit(task)}>
                    <strong>{task.title}</strong>
                    <small className={deadlineToneClass(task, todayStartMs)}>
                      {task.completedAt
                        ? `完成于 ${formatCompleted(task.completedAt, todayStartMs)}`
                      : formatDeadline(task.deadlineAt, todayStartMs)}
                    </small>
                  </button>
                  {pendingTaskIds.includes(task.id) ? <span className="pending-dot" title="待同步" /> : null}
                </div>
                {!task.completedAt ? (
                  <button
                    className={`urgency-button is-${task.urgency}`}
                    type="button"
                    title={`紧急度：${urgencyTitle(task.urgency)}`}
                    aria-label={`紧急度：${urgencyTitle(task.urgency)}`}
                    onClick={() => cycleUrgency(task)}
                  >
                    {urgencyIcon(task.urgency)}
                  </button>
                ) : (
                  <span className="urgency-placeholder" />
                )}
                <button className="delete-button" type="button" title="删除" onClick={() => remove(task)}>
                  x
                </button>
              </li>
            ))
          ) : (
            <li className="empty-state">{emptyStateText(view, taskFilter)}</li>
          )}
        </ol>

        <div className={`bottom-composer ${isComposerOpen ? "is-open" : ""} ${showComposerDetails ? "has-details" : ""}`}>
          {isComposerOpen ? (
            <form className="task-form" onSubmit={submitTask} onKeyDown={handleComposerKeyDown}>
              <div className="composer-title-row">
                <input
                  ref={titleInputRef}
                  aria-label="Task title"
                  value={draft.title}
                  onChange={(event) => updateDraftTitle(event.target.value)}
                  placeholder={editingTask ? "编辑任务" : "新任务，例如 明天 9点 交报告"}
                />
                {inferredDeadline ? <span className="deadline-chip">{formatDeadline(draft.deadlineAt, todayStartMs)}</span> : null}
                {!showComposerDetails ? (
                  <button className="composer-detail-button" type="button" onClick={() => setIsComposerExpanded(true)}>
                    详情
                  </button>
                ) : null}
                {!showComposerDetails ? (
                  <button className="composer-close-button" type="button" title="取消" onClick={cancelForm}>
                    x
                  </button>
                ) : null}
              </div>
              {showComposerDetails ? (
                <div className="composer-details">
                  <input
                    aria-label="Deadline"
                    type="datetime-local"
                    value={draft.deadlineAt}
                    onChange={(event) => setDraft({ ...draft, deadlineAt: event.target.value })}
                  />
                  <button
                    className={`urgency-form-button is-${draft.urgency}`}
                    type="button"
                    title={`紧急度：${urgencyTitle(draft.urgency)}`}
                    aria-label={`紧急度：${urgencyTitle(draft.urgency)}`}
                    onClick={cycleDraftUrgency}
                  >
                    <span>{urgencyIcon(draft.urgency)}</span>
                    {urgencyTitle(draft.urgency)}
                  </button>
                  <button className="submit-button" type="submit" title={editingTask ? "保存" : "添加"}>
                    {editingTask ? "保存" : "添加"}
                  </button>
                  <button className="cancel-button" type="button" title="取消" onClick={cancelForm}>
                    取消
                  </button>
                </div>
              ) : null}
            </form>
          ) : null}
        </div>

        {view !== "completed" && !isAddOpen && !editingTask ? (
          <button className="add-task-button" type="button" title="添加任务" aria-label="添加任务" onClick={beginCreate}>
            <span>+</span>
          </button>
        ) : null}

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

        <footer className="footer">
          <button
            className={`sync-pill is-${syncState}`}
            type="button"
            disabled={syncState === "syncing"}
            onClick={() => runSync()}
          >
            {syncStatus}
          </button>
          <span className="footer-message">{message}</span>
          <button
            className={`notification-toggle ${notificationsEnabled ? "" : "is-off"}`}
            type="button"
            title={notificationsEnabled ? "关闭到期提醒" : "开启到期提醒"}
            onClick={toggleNotifications}
          >
            提醒
          </button>
          {pendingDelete ? (
            <button className="undo-button" type="button" onClick={undoDelete}>
              撤销
            </button>
          ) : null}
        </footer>
      </section>
    </main>
  );
}

function SummaryMetric({ icon, label, value, onClick }: { icon: string; label: string; value: number; onClick: () => void }) {
  return (
    <button className="summary-metric" type="button" onClick={onClick}>
      <span className="summary-icon">{icon}</span>
      <strong>{value}</strong>
      <span>{label}</span>
    </button>
  );
}

function FilterMenuItem({
  value,
  active,
  onClick,
  children
}: {
  value: TaskFilter;
  active: boolean;
  onClick: (value: TaskFilter) => void;
  children: string;
}) {
  return (
    <button className={active ? "is-active" : ""} type="button" role="menuitem" onClick={() => onClick(value)}>
      {children}
    </button>
  );
}

function syncStatusText(syncState: SyncState, pendingWriteCount: number) {
  if (pendingWriteCount > 0) return `待同步 ${pendingWriteCount} 条`;
  switch (syncState) {
    case "syncing":
      return "同步中";
    case "offline":
      return "离线";
    case "error":
      return "同步失败";
    case "idle":
      return "已同步";
  }
}

function filterLabel(filter: TaskFilter) {
  switch (filter) {
    case "overdue":
      return "逾期";
    case "rush":
      return "加急";
    case "urgent":
      return "紧急";
    case "all":
      return "全部";
  }
}

function readNotificationsEnabled() {
  return localStorage.getItem("simple-schedule.notifications-enabled") !== "false";
}

function applyTaskFilter(tasks: Task[], filter: TaskFilter, todayStartMs: number) {
  switch (filter) {
    case "overdue":
      return tasks.filter((task) => !task.completedAt && new Date(task.deadlineAt).getTime() < Date.now());
    case "rush":
      return tasks.filter((task) => task.urgency === "rush" || task.urgency === "urgent");
    case "urgent":
      return tasks.filter((task) => task.urgency === "urgent");
    case "all":
      return tasks;
  }
}

function emptyStateText(view: View, filter: TaskFilter) {
  if (view === "completed") return "最近没有完成任务。";
  if (view === "today" && filter === "all") return "今天没有待办任务。";
  if (filter === "overdue") return "没有逾期任务。";
  if (filter === "rush") return "没有加急或紧急任务。";
  if (filter === "urgent") return "没有紧急任务。";
  return "没有待办任务。";
}

function parseDraftTitle(draft: Draft): Draft {
  const parsed = inferDeadlineFromText(draft.title);
  return parsed ? { ...draft, deadlineAt: toInputValue(parsed) } : draft;
}

function inferDeadlineFromText(text: string): Date | null {
  const source = text.trim();
  if (!source) return null;

  const now = new Date();
  let date: Date | null = null;

  if (source.includes("今天")) date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (source.includes("明天")) date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (source.includes("后天")) date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);

  const nextWeekdayMatch = source.match(/下周([一二三四五六日天])/);
  if (nextWeekdayMatch) {
    const target = weekdayNumber(nextWeekdayMatch[1]);
    const current = now.getDay() || 7;
    const days = 7 - current + target;
    date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  }

  if (!date) return null;

  const timeMatch = source.match(/(\d{1,2})(?::|：|点)(\d{1,2})?/);
  const hours = timeMatch ? clampNumber(Number(timeMatch[1]), 0, 23) : 9;
  const minutes = timeMatch?.[2] ? clampNumber(Number(timeMatch[2]), 0, 59) : 0;
  date.setHours(hours, minutes, 0, 0);
  return date;
}

function weekdayNumber(value: string) {
  switch (value) {
    case "一":
      return 1;
    case "二":
      return 2;
    case "三":
      return 3;
    case "四":
      return 4;
    case "五":
      return 5;
    case "六":
      return 6;
    case "日":
    case "天":
      return 7;
    default:
      return 1;
  }
}

function clampNumber(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

async function notifyDueTasks(
  tasks: Task[],
  notifiedTaskKeysRef: MutableRefObject<Set<string>>,
  permissionRef: MutableRefObject<boolean | null>
) {
  const dueTasks = tasks.filter((task) => new Date(task.deadlineAt).getTime() <= Date.now());
  if (dueTasks.length === 0) return;

  if (permissionRef.current === null) {
    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      permissionGranted = (await requestPermission()) === "granted";
    }
    permissionRef.current = permissionGranted;
  }

  if (!permissionRef.current) return;

  for (const task of dueTasks.slice(0, 3)) {
    const key = `${task.id}:${task.deadlineAt}`;
    if (notifiedTaskKeysRef.current.has(key)) continue;
    notifiedTaskKeysRef.current.add(key);
    sendNotification({
      title: urgencyNotificationTitle(task),
      body: `${task.title} · ${formatDeadline(task.deadlineAt, startOfDay(new Date()).getTime())}`
    });
  }
}

function urgencyNotificationTitle(task: Task) {
  if (task.urgency === "urgent") return "紧急任务到期";
  if (task.urgency === "rush") return "加急任务到期";
  return "任务到期";
}

function shortcutLabel() {
  return navigator.platform.toLowerCase().includes("mac") ? "Cmd+Shift+A" : "Ctrl+Shift+A";
}

function draftToInput(draft: Draft): TaskInput | null {
  const title = draft.title.trim();
  if (!title || !draft.deadlineAt) return null;
  return {
    title,
    deadlineAt: new Date(draft.deadlineAt).toISOString(),
    urgency: draft.urgency
  };
}

function urgencyTitle(value: TaskUrgency) {
  switch (value) {
    case "urgent":
      return "紧急";
    case "rush":
      return "加急";
    case "normal":
      return "普通";
  }
}

function urgencyIcon(value: TaskUrgency) {
  switch (value) {
    case "urgent":
      return "!!";
    case "rush":
      return "!";
    case "normal":
      return "\u25cb";
  }
}

function nextUrgency(value: TaskUrgency): TaskUrgency {
  return value === "normal" ? "rush" : value === "rush" ? "urgent" : "normal";
}

function formatToday() {
  return new Intl.DateTimeFormat("zh-CN", {
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date());
}

function formatDeadline(value: string, todayStartMs: number) {
  const date = new Date(value);
  const target = startOfDay(date);
  const dayDiff = Math.round((target.getTime() - todayStartMs) / 86400000);
  const time = formatTime(value);

  if (dayDiff === 0) return `今天 ${time}`;
  if (dayDiff === 1) return `明天 ${time}`;
  if (dayDiff === -1) return `昨天 ${time}`;

  const day = new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric"
  }).format(date);
  return `${day} ${time}`;
}

function formatCompleted(value: string, todayStartMs: number) {
  const date = new Date(value);
  const target = startOfDay(date);
  const dayDiff = Math.round((target.getTime() - todayStartMs) / 86400000);

  if (dayDiff === 0) return formatTime(value);
  if (dayDiff === -1) return "昨天";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric"
  }).format(date);
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value));
}

function deadlineToneClass(task: Task, todayStartMs: number) {
  if (task.completedAt) return "";
  const dayDiff = Math.round((startOfDay(new Date(task.deadlineAt)).getTime() - todayStartMs) / 86400000);
  if (dayDiff <= 0) return "is-due";
  if (dayDiff < 3) return "is-soon";
  return "";
}

function isDueOrOverdue(task: Task, todayStartMs: number) {
  return !task.completedAt && !task.deletedAt && startOfDay(new Date(task.deadlineAt)).getTime() <= todayStartMs;
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
