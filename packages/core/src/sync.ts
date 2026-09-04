// One active pass per account; bursts during a pass request one following pass.
export function createSyncScheduler<T>(run: (userId: string) => Promise<T>) {
  const active = new Map<string, { again: boolean; promise: Promise<T> }>();
  return (userId: string): Promise<T> => {
    const existing = active.get(userId);
    if (existing) {
      existing.again = true;
      return existing.promise;
    }
    const state = { again: false, promise: null as unknown as Promise<T> };
    // Defer execution so the entry exists even if run throws synchronously.
    state.promise = Promise.resolve().then(async () => {
      try {
        let result: T;
        do {
          state.again = false;
          result = await run(userId);
        } while (state.again);
        return result;
      } finally {
        active.delete(userId);
      }
    });
    active.set(userId, state);
    return state.promise;
  };
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "同步失败，请手动重试";
}

// Only known transient failures get automatic retries. Auth/validation/permission
// failures require intervention; arbitrary errors must not create retry loops.
export function isRetryableSyncError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: number; code?: string; name?: string; message?: string };
  if (value.status === 429 || (value.status !== undefined && value.status >= 500)) return true;
  if (value.code?.startsWith("08") || value.code === "57014" || value.code === "40001") return true;
  return value.name === "TimeoutError" || value.name === "AbortError" ||
    /failed to fetch|fetch failed|networkerror|network request failed|load failed|signal is aborted|timeout/i.test(value.message ?? "");
}

export function syncRetryDelay(attempt: number): number | null {
  return attempt < 5 ? Math.min(1000 * 2 ** attempt, 30000) : null;
}
