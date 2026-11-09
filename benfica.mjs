import { createAutoRefresh } from './auto-refresh.mjs';
import { BENFICA_URL, BENFICA_INTERVAL_MS, BENFICA_CACHE_KEY, BENFICA_CACHE_MAX_AGE_MS, parseBenficaSchedule, upcomingBenficaMatches, benficaMatchWhen, readBenficaCache } from './benfica-core.mjs';

export function initializeBenficaFixtures(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const get = id => doc.getElementById(id), summary = get('summary-benfica');
  if (!summary) return null;
  const now = options.now || Date.now, fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  let storage = null;
  try { storage = options.storage || win.localStorage; } catch { /* The public schedule still works without storage. */ }
  let lastGood = null, inFlight = false, disposed = false, controller = null, lastAttemptAt = -Infinity, tick = null, renderedSignature = '';
  try { lastGood = readBenficaCache(storage?.getItem(BENFICA_CACHE_KEY), now()); } catch { /* Ignore inaccessible cache. */ }

  function render(stale = false) {
    if (lastGood && now() - lastGood.at > BENFICA_CACHE_MAX_AGE_MS) lastGood = null;
    const matches = lastGood ? upcomingBenficaMatches(lastGood.matches, now()) : [];
    summary.dataset.state = lastGood ? stale ? 'stale' : 'ready' : inFlight ? 'loading' : 'unavailable';
    const signature = JSON.stringify({ matches, empty: matches.length ? '' : lastGood ? 'empty' : inFlight ? 'loading' : 'unavailable' });
    if (signature !== renderedSignature) {
      const fragment = doc.createDocumentFragment();
      for (const match of matches) {
        const row = doc.createElement('li'); row.className = 'benfica-match';
        const teams = `${match.home} – ${match.away}`, when = benficaMatchWhen(match);
        const title = doc.createElement(match.url ? 'a' : 'strong'); title.textContent = teams;
        title.title = `${teams} · ${when} (heure suisse) · ${match.league}`;
        if (match.url) { title.href = match.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; title.referrerPolicy = 'no-referrer'; title.setAttribute('aria-label', `${title.title} — détails sur ESPN (nouvel onglet)`); }
        const detail = doc.createElement('span'); detail.className = 'benfica-match-detail'; detail.textContent = `${when} · ${match.league}`; detail.title = `${detail.textContent} · Europe/Zurich`;
        row.append(title, detail); fragment.append(row);
      }
      if (!matches.length) {
        const empty = doc.createElement('li'); empty.className = 'benfica-empty';
        empty.textContent = lastGood ? 'Aucun prochain match annoncé.' : inFlight ? 'Chargement des matchs…' : 'Calendrier indisponible · réessai automatique';
        fragment.append(empty);
      }
      get('benfica-matches').replaceChildren(fragment);
      renderedSignature = signature;
    }
    get('benfica-matches').setAttribute('aria-busy', String(inFlight));
    const updated = lastGood ? new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(lastGood.at)) : '';
    get('benfica-warning').hidden = !stale || !lastGood;
    get('benfica-warning').textContent = stale && lastGood ? `Dernières données : ${updated}` : '';
    summary.title = 'Benfica · heures suisses · actualisation toutes les 15 minutes' + (lastGood ? ` · relevé du ${updated}` : '');
    const status = lastGood ? `${matches.length} prochain${matches.length > 1 ? 's' : ''} match${matches.length > 1 ? 's' : ''} du Benfica. Heures suisses. ${stale ? 'Actualisation indisponible ; dernières données' : 'Actualisé'} le ${updated}.` : 'Le calendrier du Benfica est indisponible. Nouvelle tentative automatique.';
    if (get('benfica-status').textContent !== status) get('benfica-status').textContent = status;
  }

  async function refresh() {
    if (disposed || inFlight || doc.hidden || win.navigator?.onLine === false) return;
    inFlight = true; lastAttemptAt = now(); controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 12_000);
    get('benfica-matches').setAttribute('aria-busy', 'true');
    if (!lastGood) render(false);
    try {
      const response = await fetcher(BENFICA_URL, { method: 'GET', signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('Benfica request failed');
      const matches = parseBenficaSchedule(await response.json());
      if (disposed) return;
      lastGood = { at: now(), matches };
      stale = false;
      try { storage?.setItem(BENFICA_CACHE_KEY, JSON.stringify({ version: 1, ...lastGood })); } catch { /* Optional public-fixture cache. */ }
      render(false);
    } catch { if (!disposed) { stale = true; render(true); } }
    finally { clearTimeout(timeout); controller = null; inFlight = false; if (!disposed) render(stale); }
  }
  const auto = (options.autoRefreshFactory || createAutoRefresh)({ document: doc, window: win, nowMs: now, refresh,
    intervalMs: BENFICA_INTERVAL_MS, minResumeDelayMs: 30_000, lastAttemptAt: () => lastAttemptAt,
    canRefresh: () => !disposed && !inFlight && now() - lastAttemptAt >= BENFICA_INTERVAL_MS });
  let stale = !!lastGood;
  function environmentChanged() {
    if (disposed || doc.hidden) return;
    if (win.navigator?.onLine === false) stale = true;
    render(stale || !!lastGood && now() - lastGood.at >= BENFICA_INTERVAL_MS);
  }
  function dispose(event) {
    if (event?.persisted) return;
    disposed = true; controller?.abort(); clearInterval(tick); auto.dispose();
    doc.removeEventListener?.('visibilitychange', environmentChanged);
    for (const name of ['online', 'offline', 'pageshow']) win.removeEventListener?.(name, environmentChanged);
    win.removeEventListener?.('pagehide', dispose);
  }
  doc.addEventListener?.('visibilitychange', environmentChanged);
  for (const name of ['online', 'offline', 'pageshow']) win.addEventListener?.(name, environmentChanged);
  win.addEventListener?.('pagehide', dispose);
  // Drop matches that have started even if a later network refresh fails.
  tick = setInterval(() => { if (!disposed && !doc.hidden) render(stale || !!lastGood && now() - lastGood.at >= BENFICA_INTERVAL_MS); }, 60_000);
  tick?.unref?.();
  render(!!lastGood); void refresh(); auto.start();
  return { refresh, dispose };
}

if (typeof document !== 'undefined') initializeBenficaFixtures();
