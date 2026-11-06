import { createAutoRefresh } from './auto-refresh.mjs';
import { INTRANET_HEALTH_URL, INTRANET_HEALTH_CACHE_KEY, HEALTH_INTERVAL_MS, HEALTH_MAX_AGE_MS, parseIntranetHealth, intranetHealthView } from './intranet-health-core.mjs';

export function initializeIntranetHealth(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const badge = doc.querySelector('#intranet-health');
  if (!badge) return null;
  const label = doc.querySelector('#intranet-health-label'), time = doc.querySelector('#intranet-health-time');
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis), now = options.now || Date.now;
  const schedule = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
  let sample = null, lastAttempt = -Infinity, busy = false, disposed = false, controller, expiry, failed = false;
  let storage;
  try { storage = options.storage || win.localStorage; sample = parseIntranetHealth(JSON.parse(storage?.getItem(INTRANET_HEALTH_CACHE_KEY) || 'null'), now()); }
  catch { try { storage?.removeItem(INTRANET_HEALTH_CACHE_KEY); } catch { /* Storage is optional. */ } }
  function render() {
    cancel(expiry);
    const view = intranetHealthView(sample, now(), { feedUnavailable: failed, offline: win.navigator?.onLine === false });
    badge.dataset.state = view.state; badge.dataset.retained = String(view.retained); label.textContent = view.label;
    time.hidden = !sample;
    time.textContent = sample ? new Intl.DateTimeFormat('fr-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' }).format(new Date(sample.checkedAt)) : '';
    if (sample) time.dateTime = new Date(sample.checkedAt).toISOString(); else time.removeAttribute('datetime');
    const checked = sample ? ` Dernier contrôle : ${new Intl.DateTimeFormat('fr-CH', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Zurich' }).format(new Date(sample.checkedAt))}.` : '';
    const detail = sample?.applicationHttpStatus ? ` Page d’accès : HTTP ${sample.entryHttpStatus} vers Microsoft. Santé de l’application : HTTP ${sample.applicationHttpStatus}.` : '';
    const retained = view.retained ? ` Dernier statut connu conservé${win.navigator?.onLine === false ? ' : navigateur hors ligne' : failed ? ' : actualisation indisponible' : ' : relevé ancien'}.` : '';
    badge.title = `${view.description}.${retained}${checked}${detail} Contrôle côté serveur toutes les 5 minutes lorsque le dashboard est affiché, puis à son retour après une pause.`;
    badge.setAttribute('aria-label', `Dernier état du site intranet : ${view.description}.${retained}${checked}`);
    if (sample && now() - sample.checkedAt <= HEALTH_MAX_AGE_MS) {
      expiry = schedule(render, Math.max(1, sample.checkedAt + HEALTH_MAX_AGE_MS - now() + 1)); expiry?.unref?.();
    }
  }
  async function refresh() {
    if (disposed || busy || doc.hidden || win.navigator?.onLine === false) return;
    busy = true; lastAttempt = now(); controller = new AbortController();
    const request = controller, timeout = schedule(() => request.abort(), 20_000);
    try {
      const response = await fetcher(`${INTRANET_HEALTH_URL}?v=${Math.floor(now() / HEALTH_INTERVAL_MS)}`, {
        signal: request.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('Availability feed unavailable');
      const raw = await response.json();
      const next = parseIntranetHealth(raw, now());
      if (disposed) return;
      if (!sample || next.checkedAt >= sample.checkedAt) {
        sample = next;
        try { storage?.setItem(INTRANET_HEALTH_CACHE_KEY, JSON.stringify({ ...sample, schemaVersion: 1, target: 'https://intranet.isp-spi.ch/intranet', checkedAt: new Date(sample.checkedAt).toISOString() })); }
        catch { /* Keep the current page's last known result if storage is unavailable. */ }
      }
      failed = raw.checkFailed === true; render();
    } catch { if (!disposed) { failed = true; render(); } }
    finally { cancel(timeout); busy = false; controller = null; }
  }
  const auto = (options.autoRefreshFactory || createAutoRefresh)({ document: doc, window: win, intervalMs: HEALTH_INTERVAL_MS,
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
  // Start the interval after the initial request so the server's five-minute
  // cache has expired when the next automatic check arrives.
  render(); void refresh().finally(() => { if (!disposed) auto.start(); });
  return { refresh, dispose };
}
if (typeof document !== 'undefined') initializeIntranetHealth();
