import { createAutoRefresh } from './auto-refresh.mjs';

// Public manifest key fixes the ID for this locally loaded, read-only extension.
export const FOOTBALL_EXTENSION_ID = 'alepjbcpdhcadcbggjgelichkenlmepc';
const unavailable = () => ({ installed: false, resultsState: 'unavailable', results: [], resultsCheckedAt: null, resultsCheckFailed: true });

export function requestFootballExtension({ window: win = globalThis.window, timeoutMs = 2000 } = {}) {
  let runtime;
  try { runtime = win?.chrome?.runtime; } catch { return Promise.resolve(unavailable()); }
  if (typeof runtime?.sendMessage !== 'function') return Promise.resolve(unavailable());
  return new Promise(resolve => {
    let finished = false;
    const finish = value => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(unavailable()), timeoutMs); timer?.unref?.();
    try {
      runtime.sendMessage(FOOTBALL_EXTENSION_ID, { type: 'GET_RESULTS' }, packet => {
        let error;
        try { error = runtime.lastError; } catch { error = true; }
        if (error || packet?.installed !== true || typeof packet.version !== 'string' || packet.version.length > 40) { finish(unavailable()); return; }
        const ready = packet.resultsState === 'ready' && Array.isArray(packet.results) && packet.results.length <= 3 && typeof packet.resultsCheckedAt === 'string' && packet.resultsCheckedAt.length <= 40 && typeof packet.resultsCheckFailed === 'boolean';
        finish({ installed: true, version: packet.version, refreshing: packet.refreshing === true,
          resultsState: ready ? 'ready' : 'unavailable', results: ready ? packet.results : [],
          resultsCheckedAt: ready ? packet.resultsCheckedAt : null, resultsCheckFailed: !ready || packet.resultsCheckFailed });
      });
    } catch { finish(unavailable()); }
  });
}

export function subscribeFootballExtension(onSnapshot, options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  let disposed = false, inFlight = false;
  async function refresh() {
    if (disposed || inFlight || doc.hidden) return;
    inFlight = true;
    try { const snapshot = await requestFootballExtension({ window: win }); if (!disposed) onSnapshot(snapshot); }
    finally { inFlight = false; }
  }
  const auto = (options.autoRefreshFactory || createAutoRefresh)({ document: doc, window: win, refresh,
    intervalMs: 15_000, canRefresh: () => !disposed && !inFlight });
  void refresh(); auto.start();
  return { refresh, dispose() { disposed = true; auto.dispose(); } };
}
