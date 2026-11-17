import { createAutoRefresh } from './auto-refresh.mjs';
import { initializeInfoCarousel } from './info-carousel.mjs?v=20261116-auto10';
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
  let requestFailed = false;
  const carousel = initializeInfoCarousel(doc, { window: win }), cards = new Map();
  function link(element, url) { element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer'; element.referrerPolicy = 'no-referrer'; }
  function render() {
    const at = now(), services = SERVICES.map(config => snapshot?.services.find(item => item.id === config.id) || emptyService(config));
    const articles = normalizeArticles(snapshot?.articles || [], at);
    const slides = [], used = new Set();
    function card(key, signature, create) {
      used.add(key); let entry = cards.get(key);
      if (!entry || entry.signature !== signature) { entry = { signature, node: create() }; entry.node.dataset.slideId = key; cards.set(key, entry); }
      slides.push(entry.node);
    }
    for (const service of services) {
      const config = SERVICES.find(item => item.id === service.id);
      const stale = service.checkFailed || !service.checkedAt || at - Date.parse(service.checkedAt) > (service.id === 'microsoft' ? 90 : 20) * 60_000;
      card(`service-${service.id}`, JSON.stringify({ service, stale }), () => {
        const row = doc.createElement('div'), name = doc.createElement('span'), anchor = doc.createElement('a'), detail = doc.createElement('p'), date = doc.createElement('time');
        row.className = 'tech-slide tech-service-slide'; row.dataset.state = service.status; row.dataset.stale = String(stale);
        name.className = 'tech-slide-kicker'; name.textContent = service.name;
        anchor.className = 'tech-slide-title'; anchor.textContent = serviceLabel(service); link(anchor, service.incident?.url || config.url);
        detail.className = 'tech-slide-detail'; detail.textContent = service.incident?.title || config.scope || (service.checkedAt ? 'État annoncé par la page officielle.' : 'En attente d’une lecture de la source officielle.');
        const description = `${service.name} : ${serviceLabel(service)}. ${stale && service.checkedAt ? 'Dernier statut connu. ' : ''}Relevé : ${techDate(service.checkedAt)}. ${detail.textContent}`;
        anchor.title = description; anchor.setAttribute('aria-label', description);
        date.className = 'tech-slide-date'; date.textContent = service.checkedAt ? `${stale ? 'Dernier relevé' : 'Vérifié'} : ${techDate(service.checkedAt)}` : 'Non vérifié';
        if (service.checkedAt) date.dateTime = service.checkedAt;
        row.append(name, anchor, detail, date); return row;
      });
    }
    for (const article of articles) card(`article-${article.id}`, JSON.stringify(article), () => {
      const row = doc.createElement('div'), source = doc.createElement('span'), anchor = doc.createElement('a'), date = doc.createElement('time');
      row.className = 'tech-slide tech-article-slide'; source.className = 'tech-slide-kicker'; source.textContent = `Actualité · ${article.source}`;
      anchor.className = 'tech-slide-title'; anchor.textContent = article.title; anchor.title = article.title; link(anchor, article.url);
      date.className = 'tech-slide-date'; date.textContent = techDate(article.publishedAt); date.dateTime = article.publishedAt;
      row.append(source, anchor, date); return row;
    });
    if (!articles.length) card('news-empty', String(inFlight), () => {
      const row = doc.createElement('div'), title = doc.createElement('p'); row.className = 'tech-slide tech-article-slide'; title.className = 'tech-slide-detail';
      title.textContent = inFlight ? 'Chargement des nouvelles…' : 'Aucune actualité récente disponible.'; row.append(title); return row;
    });
    for (const key of cards.keys()) if (!used.has(key)) cards.delete(key);
    carousel?.setSlides(slides);
    const newsStale = requestFailed || snapshot?.newsCheckFailed || !snapshot?.newsCheckedAt || at - Date.parse(snapshot.newsCheckedAt) > 90 * 60_000;
    const statusStale = services.some(service => service.checkedAt && (service.checkFailed || at - Date.parse(service.checkedAt) > (service.id === 'microsoft' ? 90 : 20) * 60_000));
    const hasObservation = snapshot?.newsCheckedAt || services.some(service => service.checkedAt);
    const warning = get('tech-news-warning'); warning.hidden = !newsStale && !statusStale;
    warning.textContent = newsStale || statusStale ? hasObservation ? 'Certaines sources ne sont pas à jour · dernières données conservées.' : inFlight ? '' : 'Sources indisponibles · nouvelle tentative automatique.' : '';
    warning.title = warning.textContent;
    warning.hidden = !warning.textContent;
    get('tech-news-meta').textContent = 'Actualisation automatique';
    get('tech-news-meta').title = snapshot?.newsCheckedAt ? `Titres relevés le ${techDate(snapshot.newsCheckedAt)} · sources publiques` : 'Sources publiques · sans connexion';
    get('tech-carousel-slides')?.setAttribute('aria-busy', String(inFlight)); get('tech-news-refresh').disabled = inFlight;
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
    disposed = true; controller?.abort(); clearInterval(timer); auto.dispose(); carousel?.dispose();
    get('tech-news-refresh').removeEventListener?.('click', onClick); win.removeEventListener?.('pagehide', dispose);
  }
  get('tech-news-refresh').addEventListener('click', onClick); win.addEventListener?.('pagehide', dispose);
  timer = setInterval(() => { if (!disposed && !doc.hidden) render(); }, 60_000); timer?.unref?.();
  render(); void refresh(); auto.start();
  return { refresh, dispose };
}
if (typeof document !== 'undefined') initializeTechNews();
