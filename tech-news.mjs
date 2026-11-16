import { createAutoRefresh } from './auto-refresh.mjs';
import { TECH_NEWS_URL, TECH_NEWS_INTERVAL_MS, TECH_NEWS_CACHE_KEY, SERVICES, serviceLabel, emptyService,
  parseTechSnapshot, parseStatuspage, mergeTechSnapshot, readTechCache, normalizeArticles, techDate } from './tech-news-core.mjs';

export function initializeTechNews(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const get = id => doc.getElementById(id), panel = get('tech-news-panel');
  if (!panel) return null;
  const now = options.now || Date.now, fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  let storage;
  try { storage = options.storage || win.localStorage; } catch { /* Optional cache for public data only. */ }
  let snapshot = null, inFlight = false, disposed = false, lastAttemptAt = -Infinity, controller = null, timer = null;
  try { snapshot = readTechCache(storage?.getItem(TECH_NEWS_CACHE_KEY), now()); } catch { /* Keep working without local storage. */ }
  let requestFailed = false, statusSignature = '', articleSignature = '';
  function link(element, url) { element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer'; element.referrerPolicy = 'no-referrer'; }
  function render() {
    const at = now(), services = SERVICES.map(config => snapshot?.services.find(item => item.id === config.id) || emptyService(config));
    const articles = normalizeArticles(snapshot?.articles || [], at);
    const key = JSON.stringify({ services, stale: services.map(service => service.checkFailed || !service.checkedAt || at - Date.parse(service.checkedAt) > (service.id === 'microsoft' ? 90 : 20) * 60_000) });
    if (key !== statusSignature) {
      const statuses = doc.createDocumentFragment();
      for (const service of services) {
        const config = SERVICES.find(item => item.id === service.id), row = doc.createElement('li'), anchor = doc.createElement('a');
        const name = doc.createElement('span'), state = doc.createElement('span');
        const stale = service.checkFailed || !service.checkedAt || at - Date.parse(service.checkedAt) > (service.id === 'microsoft' ? 90 : 20) * 60_000;
        anchor.className = 'tech-status'; anchor.dataset.state = service.status; anchor.dataset.stale = String(stale);
        name.className = 'tech-status-name'; name.textContent = service.name;
        state.className = 'tech-status-state'; state.textContent = serviceLabel(service);
        const description = `${service.name} : ${serviceLabel(service)}. ${stale && service.checkedAt ? 'Dernier statut connu. ' : ''}Relevé : ${techDate(service.checkedAt)}.${service.incident ? ` ${service.incident.title}.` : ''}${config.scope ? ` ${config.scope}` : ''}`;
        anchor.title = description; anchor.setAttribute('aria-label', description); link(anchor, service.incident?.url || config.url);
        anchor.append(name, state); row.append(anchor); statuses.append(row);
      }
      get('tech-status-list').replaceChildren(statuses); statusSignature = key;
    }
    const articleKey = JSON.stringify({ articles, loading: inFlight && !articles.length });
    if (articleKey !== articleSignature) {
      const headlines = doc.createDocumentFragment();
      for (const article of articles) {
        const row = doc.createElement('li'), anchor = doc.createElement('a'), detail = doc.createElement('span');
        row.className = 'tech-news-item'; anchor.className = 'tech-news-link'; anchor.textContent = article.title; anchor.title = article.title;
        link(anchor, article.url); detail.className = 'tech-news-detail'; detail.textContent = `${article.source} · ${techDate(article.publishedAt)}`;
        row.append(anchor, detail); headlines.append(row);
      }
      if (!articles.length) { const item = doc.createElement('li'); item.className = 'tech-news-empty'; item.textContent = inFlight ? 'Chargement des nouvelles…' : 'Aucune actualité récente disponible.'; headlines.append(item); }
      get('tech-news-list').replaceChildren(headlines); articleSignature = articleKey;
    }
    const newsStale = requestFailed || snapshot?.newsCheckFailed || !snapshot?.newsCheckedAt || at - Date.parse(snapshot.newsCheckedAt) > 90 * 60_000;
    const statusStale = services.some(service => service.checkedAt && (service.checkFailed || at - Date.parse(service.checkedAt) > (service.id === 'microsoft' ? 90 : 20) * 60_000));
    const hasObservation = snapshot?.newsCheckedAt || services.some(service => service.checkedAt);
    const warning = get('tech-news-warning'); warning.hidden = !newsStale && !statusStale;
    warning.textContent = newsStale || statusStale ? hasObservation ? 'Certaines sources ne sont pas à jour · dernières données conservées.' : inFlight ? '' : 'Sources indisponibles · nouvelle tentative automatique.' : '';
    warning.hidden = !warning.textContent;
    get('tech-news-meta').textContent = snapshot?.newsCheckedAt ? `Titres relevés le ${techDate(snapshot.newsCheckedAt)}` : 'Sources publiques · sans connexion';
    get('tech-news-list').setAttribute('aria-busy', String(inFlight)); get('tech-news-refresh').disabled = inFlight;
    panel.dataset.state = hasObservation ? newsStale || statusStale ? 'stale' : 'ready' : inFlight ? 'loading' : 'unavailable';
  }
  async function json(url, signal) {
    const response = await fetcher(url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal });
    if (!response.ok) throw new Error('Public source unavailable');
    const body = await response.text(); if (body.length > 2_000_000) throw new Error('Oversized public source'); return JSON.parse(body);
  }
  async function refresh() {
    if (disposed || inFlight || doc.hidden || win.navigator?.onLine === false) return;
    inFlight = true; lastAttemptAt = now(); controller = new AbortController(); render();
    const timeout = setTimeout(() => controller?.abort(), 15_000);
    try {
      const responses = await Promise.allSettled([
        json(TECH_NEWS_URL, controller.signal).then(value => parseTechSnapshot(value, now())),
        ...SERVICES.filter(config => config.api).map(async config => {
          const [summary, incidents] = await Promise.all([json(`${config.api}summary.json`, controller.signal), json(`${config.api}incidents.json`, controller.signal)]);
          return parseStatuspage(config, summary, incidents, now());
        })
      ]);
      if (disposed) return;
      requestFailed = responses[0].status === 'rejected';
      snapshot = mergeTechSnapshot(snapshot, responses[0].status === 'fulfilled' ? responses[0].value : null, now());
      const direct = SERVICES.filter(config => config.api);
      responses.slice(1).forEach((response, index) => {
        if (response.status === 'fulfilled') snapshot = mergeTechSnapshot(snapshot, { services: [response.value], articles: [], newsCheckedAt: null, newsCheckFailed: false }, now());
        else snapshot.services = snapshot.services.map(service => service.id === direct[index].id ? { ...service, checkFailed: true } : service);
      });
      try { storage?.setItem(TECH_NEWS_CACHE_KEY, JSON.stringify(snapshot)); } catch { /* No private data is cached. */ }
    } finally { clearTimeout(timeout); controller = null; inFlight = false; if (!disposed) render(); }
  }
  const auto = (options.autoRefreshFactory || createAutoRefresh)({ document: doc, window: win, refresh, nowMs: now,
    intervalMs: TECH_NEWS_INTERVAL_MS, lastAttemptAt: () => lastAttemptAt, minResumeDelayMs: 30_000,
    canRefresh: () => !disposed && !inFlight && now() - lastAttemptAt >= TECH_NEWS_INTERVAL_MS });
  const onClick = () => void refresh();
  function dispose(event) {
    if (event?.persisted) return;
    disposed = true; controller?.abort(); clearInterval(timer); auto.dispose();
    get('tech-news-refresh').removeEventListener?.('click', onClick); win.removeEventListener?.('pagehide', dispose);
  }
  get('tech-news-refresh').addEventListener('click', onClick); win.addEventListener?.('pagehide', dispose);
  timer = setInterval(() => { if (!disposed && !doc.hidden) render(); }, 60_000); timer?.unref?.();
  render(); void refresh(); auto.start();
  return { refresh, dispose };
}
if (typeof document !== 'undefined') initializeTechNews();
