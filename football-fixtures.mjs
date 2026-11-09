import { createAutoRefresh } from './auto-refresh.mjs';

export function initializeFootballFixtures(settings, options = {}) {
  const { prefix, label, sourceName, url, intervalMs, cacheKey, cacheMaxAgeMs, readCache, readSchedule, selectUpcoming, formatWhen,
    selectView, mergeSnapshot = (_, next) => next, mergeExternalSnapshot, requestTimeoutMs = 12_000 } = settings;
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const get = id => doc.getElementById(id), summary = get(`summary-${prefix}`);
  if (!summary) return null;
  const now = options.now || Date.now, fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  let storage = null;
  try { storage = options.storage || win.localStorage; } catch { /* The public schedule still works without storage. */ }
  let lastGood = null, inFlight = false, disposed = false, controller = null, lastAttemptAt = -Infinity, tick = null, renderedSignature = '';
  try { lastGood = readCache(storage?.getItem(cacheKey), now()); } catch { /* Ignore inaccessible cache. */ }

  function render(stale = false) {
    if (lastGood && now() - lastGood.at > cacheMaxAgeMs) lastGood = null;
    const view = lastGood && selectView ? selectView(lastGood, now()) : { matches: lastGood ? selectUpcoming(lastGood.matches, now()) : [], mode: 'upcoming', at: lastGood?.at };
    const matches = view.matches, retained = stale || view.stale === true, available = !!lastGood && view.available !== false;
    summary.dataset.state = available ? retained ? 'stale' : 'ready' : inFlight ? 'loading' : 'unavailable';
    summary.dataset.mode = view.mode;
    const modeLabel = view.mode === 'results' ? 'Derniers résultats' : 'Prochains matchs';
    const mode = get(`${prefix}-mode`);
    if (mode && mode.textContent !== modeLabel) mode.textContent = modeLabel;
    get(`${prefix}-matches`).setAttribute('aria-label', `Les trois ${view.mode === 'results' ? 'derniers résultats' : 'prochains matchs'} — ${label}`);
    const signature = JSON.stringify({ matches, mode: view.mode, empty: matches.length ? '' : available ? 'empty' : inFlight ? 'loading' : 'unavailable' });
    if (signature !== renderedSignature) {
      const fragment = doc.createDocumentFragment();
      for (const match of matches) {
        const row = doc.createElement('li'); row.className = 'benfica-match';
        const result = view.mode === 'results';
        const teams = `${match.home} – ${match.away}`, when = result ? new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'short' }).format(new Date(match.startsAt)) : formatWhen(match);
        const title = doc.createElement(match.url ? 'a' : 'strong');
        if (result) {
          row.className += ' football-result'; title.className = 'football-match-heading';
          const names = doc.createElement('span'); names.textContent = teams;
          const score = doc.createElement('span'); score.className = 'football-score'; score.textContent = `${match.scoreHome}–${match.scoreAway}`;
          title.append(names, score);
        } else title.textContent = teams;
        title.title = `${teams}${result ? ` · ${match.scoreHome}–${match.scoreAway}` : ''} · ${when}${result ? '' : ' (heure suisse)'} · ${match.league}`;
        if (match.url) { title.href = match.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; title.referrerPolicy = 'no-referrer'; title.setAttribute('aria-label', `${title.title} — détails sur ${sourceName} (nouvel onglet)`); }
        const detail = doc.createElement('span'); detail.className = 'benfica-match-detail'; detail.textContent = `${when} · ${match.league}`; detail.title = `${detail.textContent} · Europe/Zurich`;
        row.append(title, detail); fragment.append(row);
      }
      if (!matches.length) {
        const empty = doc.createElement('li'); empty.className = 'benfica-empty';
        empty.textContent = available ? view.mode === 'results' ? 'Aucun résultat publié.' : 'Aucun prochain match annoncé.' : inFlight ? 'Chargement des matchs…' : view.mode === 'results' ? 'Résultats indisponibles · réessai automatique' : 'Calendrier indisponible · réessai automatique';
        fragment.append(empty);
      }
      get(`${prefix}-matches`).replaceChildren(fragment);
      renderedSignature = signature;
    }
    get(`${prefix}-matches`).setAttribute('aria-busy', String(inFlight));
    const updated = available ? new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(view.at ?? lastGood.at)) : '';
    get(`${prefix}-warning`).hidden = !retained || !available;
    get(`${prefix}-warning`).textContent = retained && available ? `Dernières données : ${updated}` : '';
    summary.title = `${label} · heures suisses · actualisation toutes les ${intervalMs / 60_000} minutes` + (available ? ` · relevé du ${updated}` : '');
    const plural = matches.length > 1 ? 's' : '';
    const status = available ? `${matches.length} ${view.mode === 'results' ? `résultat${plural}` : `prochain${plural} match${plural}`} — ${label}. Heures suisses. ${retained ? 'Actualisation indisponible ; dernières données' : 'Actualisé'} le ${updated}.` : `${view.mode === 'results' ? 'Les résultats' : 'Le calendrier'} de ${label} ${view.mode === 'results' ? 'sont indisponibles' : 'est indisponible'}. Nouvelle tentative automatique.`;
    if (get(`${prefix}-status`).textContent !== status) get(`${prefix}-status`).textContent = status;
  }

  async function refresh() {
    if (disposed || inFlight || doc.hidden || win.navigator?.onLine === false) return;
    inFlight = true; lastAttemptAt = now(); controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), requestTimeoutMs);
    get(`${prefix}-matches`).setAttribute('aria-busy', 'true');
    if (!lastGood) render(false);
    try {
      const response = await fetcher(url, { method: 'GET', signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('Football schedule request failed');
      const snapshot = await readSchedule(response, now());
      if (disposed) return;
      lastGood = mergeSnapshot(lastGood, snapshot, now());
      stale = snapshot.stale === true;
      try { storage?.setItem(cacheKey, JSON.stringify({ version: 1, ...lastGood })); } catch { /* Optional public-fixture cache. */ }
      render(stale);
    } catch { if (!disposed) { stale = true; render(true); } }
    finally { clearTimeout(timeout); controller = null; inFlight = false; if (!disposed) render(stale); }
  }
  const auto = (options.autoRefreshFactory || createAutoRefresh)({ document: doc, window: win, nowMs: now, refresh,
    intervalMs: intervalMs, minResumeDelayMs: 30_000, lastAttemptAt: () => lastAttemptAt,
    canRefresh: () => !disposed && !inFlight && now() - lastAttemptAt >= intervalMs });
  let stale = !!lastGood;
  function environmentChanged() {
    if (disposed || doc.hidden) return;
    if (win.navigator?.onLine === false) stale = true;
    render(stale || !!lastGood && now() - lastGood.at >= intervalMs);
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
  tick = setInterval(() => { if (!disposed && !doc.hidden) render(stale || !!lastGood && now() - lastGood.at >= intervalMs); }, 60_000);
  tick?.unref?.();
  render(!!lastGood); void refresh(); auto.start();
  return { refresh, dispose, applyExternalSnapshot(packet) {
    if (disposed || !lastGood || !mergeExternalSnapshot) return;
    const next = mergeExternalSnapshot(lastGood, packet, now());
    if (!next || next === lastGood) return;
    lastGood = next;
    try { storage?.setItem(cacheKey, JSON.stringify({ version: 1, ...lastGood })); } catch { /* Optional public cache. */ }
    render(stale);
  } };
}

