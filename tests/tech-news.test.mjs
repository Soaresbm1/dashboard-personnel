import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVICES, TECH_NEWS_URL, TECH_NEWS_CACHE_KEY, TECH_NEWS_INTERVAL_MS, parseTechSnapshot, parseStatuspage, mergeTechSnapshot, normalizeArticles, readTechCache, serviceLabel } from '../tech-news-core.mjs';
import { initializeTechNews } from '../tech-news.mjs';
const NOW = Date.parse('2026-11-16T10:00:00Z');
const iso = at => new Date(at).toISOString();
const article = (overrides = {}) => ({ id: 'a', title: 'Nouvelle technologie', url: 'https://www.lemondeinformatique.fr/actualites/lire-fixture.html', source: 'Le Monde Informatique', publishedAt: iso(NOW - 60_000), ...overrides });
const service = (id = 'openai', overrides = {}) => ({ id, name: 'Untrusted name', status: 'operational', url: 'https://evil.test/', checkedAt: iso(NOW), incident: null, checkFailed: false, ...overrides });
const feed = (overrides = {}) => ({ schemaVersion: 1, generatedAt: iso(NOW), services: SERVICES.map(config => service(config.id)), articles: [article()], newsCheckedAt: iso(NOW), newsCheckFailed: false, ...overrides });
const summary = { status: { indicator: 'none' }, components: [{ status: 'operational' }] };
const incidents = { incidents: [] };

test('Only fixed official status links and known publisher HTTPS links survive, with no incoming HTML rendering', () => {
  const parsed = parseTechSnapshot(feed({ services: [service('openai', { incident: { title: '<img onerror=alert(1)>', url: 'javascript:alert(1)', updatedAt: iso(NOW) } })], articles: [article(), article({ url: 'javascript:alert(1)' }), article({ url: 'https://evil.test/' }), article({ url: 'https://user@www.lemonde.fr/foo' }), article({ url: 'https://www.numerama.com:444/foo' })] }), NOW);
  assert.equal(parsed.services[0].url, 'https://status.openai.com/'); assert.equal(parsed.services[0].name, 'OpenAI'); assert.equal(parsed.services[0].incident, null);
  assert.equal(parsed.articles.length, 1); assert.equal(parsed.articles[0].source, 'Le Monde Informatique');
  assert.equal(serviceLabel(service('microsoft')), 'Aucun avis public');
});
test('Headlines deduplicate tracking links, sort by date and exclude old or future entries', () => {
  const articles = normalizeArticles([article({ url: article().url + '?utm_source=x#section' }), article(), article({ url: 'https://www.numerama.com/fresh', publishedAt: iso(NOW) }),
    article({ url: 'https://www.lemonde.fr/old', publishedAt: iso(NOW - 8 * 86400_000) }), article({ url: 'https://www.lemonde.fr/future', publishedAt: iso(NOW + 86400_000) })], NOW);
  assert.equal(articles.length, 2); assert.equal(articles[0].source, 'Numerama'); assert.equal(articles[1].url, article().url);
});
test('Active incidents override an operational summary; resolved incidents never become an ongoing outage', () => {
  const config = SERVICES.find(service => service.id === 'openai');
  const incident = { id: 'fixture', name: 'Connection failures', status: 'investigating', impact: 'major', updated_at: iso(NOW) };
  const active = parseStatuspage(config, summary, { incidents: [incident] }, NOW);
  assert.equal(active.status, 'outage'); assert.equal(active.incident.url, 'https://status.openai.com/incidents/fixture');
  const resolved = parseStatuspage(config, summary, { incidents: [{ ...incident, status: 'resolved' }] }, NOW);
  assert.equal(resolved.status, 'operational'); assert.equal(resolved.incident, null);
  assert.throws(() => parseStatuspage(config, summary, {}, NOW));
  assert.throws(() => parseStatuspage(config, { status: { indicator: 'unexpected' }, components: [{}] }, incidents, NOW));
  assert.throws(() => parseStatuspage(config, summary, { incidents: [{ ...incident, status: 'unknown-state' }] }, NOW));
  assert.throws(() => parseStatuspage(config, summary, { incidents: [{ ...incident, updated_at: iso(NOW + 86400_000) }] }, NOW));
  assert.equal(parseStatuspage(config, { ...summary, components: [{ status: 'major_outage' }] }, incidents, NOW).status, 'outage');
});
test('Older scheduled data cannot replace a newer direct observation, and failed updates retain original dates', () => {
  const old = parseTechSnapshot(feed(), NOW);
  const fresh = mergeTechSnapshot(old, { services: [service('openai', { status: 'outage', checkedAt: iso(NOW + 60_000) })], articles: [], newsCheckedAt: null, newsCheckFailed: false }, NOW + 60_000);
  const merged = mergeTechSnapshot(fresh, parseTechSnapshot(feed(), NOW + 60_000), NOW + 60_000);
  assert.equal(merged.services.find(service => service.id === 'openai').status, 'outage');
  const failed = mergeTechSnapshot(merged, null, NOW + 120_000);
  assert.equal(failed.newsCheckedAt, iso(NOW)); assert.equal(failed.articles[0].title, article().title); assert.equal(failed.newsCheckFailed, true);
  const unknown = mergeTechSnapshot(failed, { services: [service('openai', { status: 'unknown', checkedAt: iso(NOW + 120_000) })], articles: [], newsCheckedAt: null, newsCheckFailed: true }, NOW + 120_000);
  assert.equal(unknown.services.find(service => service.id === 'openai').status, 'outage');
});
test('Malformed or expired local public snapshots are ignored', () => {
  assert.equal(readTechCache('not-json', NOW), null);
  assert.equal(readTechCache(JSON.stringify(feed()), NOW + 15 * 86400_000), null);
  assert.equal(readTechCache(JSON.stringify(feed()), NOW).articles.length, 1);
  assert.throws(() => parseTechSnapshot(feed({ services: [service(), service()] }), NOW));
});

const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  let clock = NOW, settings;
  const nodes = new Map(), requests = [], cache = new Map(), listeners = new Map();
  class Element {
    constructor() { this.children = []; this.textContent = ''; this.dataset = {}; this.hidden = false; this.attributes = {}; this.events = new Map(); }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items.flatMap(item => item.fragment ? item.children : [item]); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, callback) { this.events.set(name, callback); }
    removeEventListener(name) { this.events.delete(name); }
  }
  for (const id of ['tech-news-panel', 'tech-status-list', 'tech-news-list', 'tech-news-meta', 'tech-news-warning', 'tech-news-refresh']) nodes.set(id, new Element());
  const doc = { hidden: options.hidden || false, getElementById: id => nodes.get(id), createElement: () => new Element(), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }) };
  const win = { navigator: { onLine: !options.offline }, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  const instance = initializeTechNews({ document: doc, window: win, now: () => clock,
    storage: { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value) },
    autoRefreshFactory: config => { settings = config; return { start() {}, dispose() {} }; },
    fetch: async (url, request) => { requests.push({ url, request }); if (options.fetch) return options.fetch(url, request); return new Response(JSON.stringify(url === TECH_NEWS_URL ? feed() : url.endsWith('summary.json') ? summary : incidents)); }
  });
  return { nodes, requests, cache, doc, win, instance, get settings() { return settings; }, advance: value => { clock += value; } };
}
const text = node => [node.textContent, ...node.children.map(text)].join(' ');
test('Initial rendering loads public sources without credentials and refreshes every five minutes independently of Microsoft sign-in', async () => {
  const h = harness(); await settle();
  try {
    assert.equal(h.requests.length, 5); assert.equal(h.settings.intervalMs, 300_000); assert.equal(TECH_NEWS_INTERVAL_MS, 300_000);
    for (const request of h.requests) { assert.equal(request.request.credentials, 'omit'); assert.equal(request.request.method, 'GET'); assert.equal(request.request.headers, undefined); }
    assert.match(text(h.nodes.get('tech-news-list')), /Nouvelle technologie/);
    assert.equal(h.nodes.get('tech-news-warning').hidden, true); assert.equal(h.nodes.get('tech-news-panel').dataset.state, 'ready');
    const cache = JSON.parse(h.cache.get(TECH_NEWS_CACHE_KEY)); assert.equal(cache.newsCheckedAt, iso(NOW));
    assert.equal(h.nodes.get('tech-status-list').children.length, 3);
  } finally { h.instance.dispose(); }
});
test('Network failure retains visible headlines and service colors with their original observation timestamps', async () => {
  let failed = false;
  const h = harness({ fetch: url => { if (failed) throw Error('offline'); return new Response(JSON.stringify(url === TECH_NEWS_URL ? feed() : url.endsWith('summary.json') ? summary : incidents)); } }); await settle();
  try {
    const priorRow = h.nodes.get('tech-news-list').children[0];
    failed = true; h.advance(TECH_NEWS_INTERVAL_MS); await h.instance.refresh();
    assert.match(text(h.nodes.get('tech-news-list')), /Nouvelle technologie/);
    assert.equal(h.nodes.get('tech-news-warning').hidden, false);
    const cache = JSON.parse(h.cache.get(TECH_NEWS_CACHE_KEY)); assert.equal(cache.newsCheckedAt, iso(NOW));
    const openai = cache.services.find(service => service.id === 'openai'); assert.equal(openai.status, 'operational'); assert.equal(openai.checkedAt, iso(NOW)); assert.equal(openai.checkFailed, true);
    assert.equal(h.nodes.get('tech-news-panel').dataset.state, 'stale');
    assert.equal(h.nodes.get('tech-news-list').children[0], priorRow);
  } finally { h.instance.dispose(); }
});
test('Hidden/offline pages do not fetch, an unavailable source is never shown green and disposal ignores late results', async () => {
  for (const option of [{ hidden: true }, { offline: true }]) {
    const h = harness(option); await settle(); assert.equal(h.requests.length, 0); h.instance.dispose();
  }
  const h = harness({ fetch: () => { throw Error('unavailable'); } }); await settle();
  try {
    const cache = JSON.parse(h.cache.get(TECH_NEWS_CACHE_KEY)); assert.ok(cache.services.every(service => service.status === 'unknown'));
    assert.ok(h.nodes.get('tech-status-list').children.every(row => row.children[0].dataset.state === 'unknown'));
    assert.equal(h.nodes.get('tech-news-panel').dataset.state, 'unavailable');
    assert.match(h.nodes.get('tech-news-warning').textContent, /Sources indisponibles/);
    assert.doesNotMatch(h.nodes.get('tech-news-list').children[0].textContent, /Chargement/);
  } finally { h.instance.dispose(); }
  const releases = [];
  const late = harness({ fetch: url => new Promise(resolve => { releases.push(() => resolve(new Response(JSON.stringify(url === TECH_NEWS_URL ? feed() : url.endsWith('summary.json') ? summary : incidents)))); }) });
  late.instance.dispose(); releases.forEach(release => release()); await settle();
  assert.equal(late.cache.size, 0);
});
