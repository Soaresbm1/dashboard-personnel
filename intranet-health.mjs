import { createAutoRefresh } from './auto-refresh.mjs';
import { INTRANET_HEALTH_URL, HEALTH_MAX_AGE_MS, parseIntranetHealth, intranetHealthView } from './intranet-health-core.mjs';

export function initializeIntranetHealth(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const badge = doc.querySelector('#intranet-health');
  if (!badge) return null;
  const label = doc.querySelector('#intranet-health-label'), time = doc.querySelector('#intranet-health-time');
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis), now = options.now || Date.now;
  const schedule = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
  let sample = null, lastAttempt = -Infinity, busy = false, disposed = false, controller, expiry, failed = false;
  function render() {
    cancel(expiry);
    const view = intranetHealthView(sample, now(), { feedUnavailable: failed, offline: win.navigator?.onLine === false });
    badge.dataset.state = view.state; label.textContent = view.label;
    time.hidden = !sample;
    time.textContent = sample ? new Intl.DateTimeFormat('fr-CH', { hour: '2-digit', minute: '2-digit' }).format(new Date(sample.checkedAt)) : '';
    if (sample) time.dateTime = new Date(sample.checkedAt).toISOString(); else time.removeAttribute('datetime');
    const checked = sample ? ` Dernier contrôle : ${new Intl.DateTimeFormat('fr-CH', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(sample.checkedAt))}.` : '';
    const detail = sample?.applicationHttpStatus ? ` Page d’accès : HTTP ${sample.entryHttpStatus} vers Microsoft. Santé de l’application : HTTP ${sample.applicationHttpStatus}.` : '';
    badge.title = `Contrôle externe de la page d’accès à l’intranet depuis GitHub, prévu toutes les 5 minutes.${detail}${checked} Le dashboard consulte le résultat chaque minute.`;
    badge.setAttribute('aria-label', `État du site intranet : ${view.label}.${checked}`);
    if (sample && now() - sample.checkedAt <= HEALTH_MAX_AGE_MS) {
      expiry = schedule(render, Math.max(1, sample.checkedAt + HEALTH_MAX_AGE_MS - now() + 1)); expiry?.unref?.();
    }
  }
  async function refresh() {
    if (disposed || busy || doc.hidden || win.navigator?.onLine === false) return;
    busy = true; lastAttempt = now(); controller = new AbortController();
    const request = controller, timeout = schedule(() => request.abort(), 10_000);
    try {
      const response = await fetcher(`${INTRANET_HEALTH_URL}?v=${Math.floor(now() / 60_000)}`, {
        signal: request.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('Availability feed unavailable');
      const next = parseIntranetHealth(await response.json(), now());
      if (disposed) return;
      sample = next; failed = false; render();
    } catch { if (!disposed) { failed = true; render(); } }
    finally { cancel(timeout); busy = false; controller = null; }
  }
  const auto = (options.autoRefreshFactory || createAutoRefresh)({ document: doc, window: win, intervalMs: 60_000,
    refresh, canRefresh: () => !busy, lastAttemptAt: () => lastAttempt });
  function environmentChanged() { if (!disposed) render(); }
  function pageHide(event) { if (!event.persisted) dispose(); }
  function dispose() { disposed = true; controller?.abort(); cancel(expiry); auto.dispose();
    win.removeEventListener?.('offline', environmentChanged); win.removeEventListener?.('online', environmentChanged);
    win.removeEventListener?.('pageshow', environmentChanged); win.removeEventListener?.('pagehide', pageHide);
    doc.removeEventListener?.('visibilitychange', environmentChanged); }
  win.addEventListener?.('offline', environmentChanged); win.addEventListener?.('online', environmentChanged);
  win.addEventListener?.('pageshow', environmentChanged); win.addEventListener?.('pagehide', pageHide);
  doc.addEventListener?.('visibilitychange', environmentChanged);
  void refresh(); auto.start();
  return { refresh, dispose };
}
if (typeof document !== 'undefined') initializeIntranetHealth();
