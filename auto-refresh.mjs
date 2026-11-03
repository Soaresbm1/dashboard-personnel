export const AUTO_REFRESH_INTERVAL_MS = 60_000;

// One timer per service. Pauses while the page is hidden or the browser is offline.
export function createAutoRefresh({
  document: doc, window: win, refresh, canRefresh,
  retryAt = () => 0, lastAttemptAt = () => -Infinity,
  intervalMs = AUTO_REFRESH_INTERVAL_MS, minResumeDelayMs = 5_000,
  nowMs = () => Date.now(),
  setTimeout: scheduleTimeout = globalThis.setTimeout.bind(globalThis),
  clearTimeout: cancelTimeout = globalThis.clearTimeout.bind(globalThis)
}) {
  let active = false, disposed = false, running = false, timer = null;
  let lastAutomaticAttempt = -Infinity;
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const interval = Math.max(1_000, finite(intervalMs, AUTO_REFRESH_INTERVAL_MS));
  const resumeDelay = Math.max(0, finite(minResumeDelayMs, 5_000));
  const available = () => !doc.hidden && win.navigator?.onLine !== false;

  function clearTimer() {
    if (timer !== null) cancelTimeout(timer);
    timer = null;
  }
  function nextAllowedAt() {
    return Math.max(finite(retryAt(), 0), finite(lastAttemptAt(), -Infinity) + resumeDelay, lastAutomaticAttempt + resumeDelay);
  }
  function arm(delay = interval) {
    clearTimer();
    if (!active || disposed || running || !available()) return;
    const wait = Math.max(0, delay, nextAllowedAt() - nowMs());
    timer = scheduleTimeout(run, wait);
    // Browser timer IDs are numbers; this only keeps isolated Node checks from hanging.
    timer?.unref?.();
  }
  async function run() {
    timer = null;
    if (!active || disposed || running || !available()) return;
    const remaining = nextAllowedAt() - nowMs();
    if (remaining > 0) { arm(remaining); return; }
    try {
      if (!canRefresh()) return;
      running = true;
      lastAutomaticAttempt = nowMs();
      await refresh();
    } catch {
      // Each service owns its status message and authentication/error handling.
    } finally {
      running = false;
      arm(interval);
    }
  }
  function environmentChanged() {
    clearTimer();
    if (active && available()) arm(0);
  }
  doc.addEventListener?.('visibilitychange', environmentChanged);
  for (const event of ['online', 'offline', 'pageshow']) win.addEventListener?.(event, environmentChanged);

  function start() {
    if (active || disposed) return;
    active = true;
    arm(interval);
  }
  function stop() { active = false; clearTimer(); }
  function dispose() {
    stop(); disposed = true;
    doc.removeEventListener?.('visibilitychange', environmentChanged);
    for (const event of ['online', 'offline', 'pageshow']) win.removeEventListener?.(event, environmentChanged);
  }
  return { start, stop, dispose };
}
