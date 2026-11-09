import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BENFICA_URL, BENFICA_INTERVAL_MS, BENFICA_CACHE_KEY, BENFICA_CACHE_MAX_AGE_MS,
  parseBenficaSchedule, upcomingBenficaMatches, benficaMatchWhen, readBenficaCache, safeBenficaMatchUrl } from '../benfica-core.mjs';
import { initializeBenficaFixtures } from '../benfica.mjs';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const match = (id = '1', date = '2026-11-22T20:45Z', options = {}) => ({
  id, date, timeValid: true, league: { slug: options.league || 'por.1' },
  links: [{ rel: ['summary', 'desktop'], href: `https://www.espn.com/soccer/match/_/gameId/${id}/fixture` }],
  competitions: [{ date, timeValid: options.timeValid ?? true,
    status: { type: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false, ...options.status } },
    competitors: [{ homeAway: 'away', team: { id: '1929', shortDisplayName: 'Benfica' } },
      { homeAway: 'home', team: { id: '42', shortDisplayName: options.opponent || 'Fixture opponent' } }] }]
});
const body = (...events) => ({ status: 'success', team: { id: '1929' }, events });
const parsed = () => parseBenficaSchedule(body(match()));
const cache = (at = NOW, matches = parsed()) => JSON.stringify({ version: 1, at, matches });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Schedule is restricted to Benfica scheduled first-team fixtures across competitions, deduplicated and chronological', () => {
  const foreign = match('8'); foreign.competitions[0].competitors[0].team.id = '99';
  const wrongDate = match('9', 'not-a-date');
  const rows = parseBenficaSchedule(body(match('4', '2026-12-01T20:00Z'), match('2', '2026-11-24T20:00Z', { league: 'uefa.europa' }), match(), match(), foreign, wrongDate,
    match('5', '2026-12-02T20:00Z', { status: { name: 'STATUS_POSTPONED' } }),
    match('6', '2026-12-03T20:00Z', { status: { state: 'in' } }),
    match('7', '2026-12-04T20:00Z', { status: { completed: true } })));
  assert.deepEqual(upcomingBenficaMatches(rows, NOW).map(x => x.id), ['1', '2', '4']);
  assert.equal(rows[1].league, 'Ligue Europa');
  assert.equal(rows[0].home, 'Fixture opponent'); assert.equal(rows[0].away, 'Benfica');
  for (const value of [null, {}, { ...body(), team: { id: '42' } }, { ...body(), status: 'error' }, { ...body(), events: null }]) assert.throws(() => parseBenficaSchedule(value));
});

test('Swiss formatting handles winter, summer, and unconfirmed kickoff without displaying a placeholder hour', () => {
  assert.equal(benficaMatchWhen(parsed()[0]), '22 nov. · 21:45');
  const summer = parseBenficaSchedule(body(match('2', '2027-07-02T20:00Z')))[0];
  assert.match(benficaMatchWhen(summer), /22:00$/);
  const tbd = parseBenficaSchedule(body(match('3', '2026-11-22T00:00Z', { timeValid: false })))[0];
  assert.equal(benficaMatchWhen(tbd), '22 nov. · horaire à confirmer');
  assert.equal(upcomingBenficaMatches([tbd], Date.parse('2026-11-22T18:00Z')).length, 1);
  assert.equal(upcomingBenficaMatches([tbd], Date.parse('2026-11-23T01:00Z')).length, 0);
});

test('Started fixtures disappear even without a successful network refresh; only the next three are exposed', () => {
  const rows = parseBenficaSchedule(body(...Array.from({ length: 6 }, (_, index) => match(String(index + 1), `2026-11-${20 + index}T20:00Z`))));
  assert.deepEqual(upcomingBenficaMatches(rows, Date.parse('2026-11-21T20:00Z')).map(x => x.id), ['3', '4', '5']);
});

test('Match links allow only exact HTTPS ESPN match URLs without credentials, query parameters or fragments', () => {
  assert.ok(safeBenficaMatchUrl('https://www.espn.com/soccer/match/_/gameId/42/fixture'));
  for (const url of ['javascript:alert(1)', 'http://www.espn.com/soccer/match/_/gameId/1', 'https://www.espn.com.evil.test/soccer/match/_/gameId/1',
    'https://user@www.espn.com/soccer/match/_/gameId/1', 'https://www.espn.com:444/soccer/match/_/gameId/1',
    'https://www.espn.com/betting', 'https://www.espn.com/soccer/match/_/gameId/1?secret=1', 'https://www.espn.com/soccer/match/_/gameId/1#x']) assert.equal(safeBenficaMatchUrl(url), null);
});

test('Public cache validates shape, string IDs, timestamps and age and cannot inject an unsafe URL', () => {
  assert.equal(readBenficaCache(cache(), NOW).matches.length, 1);
  for (const value of ['bad JSON', cache(NOW + 120_000), cache(NOW - BENFICA_CACHE_MAX_AGE_MS - 1), cache(NOW, [{ ...parsed()[0], id: 1 }]), cache(NOW, [{ ...parsed()[0], startsAt: 'bad' }]), cache(NOW, [...parsed(), ...parsed()])]) assert.equal(readBenficaCache(value, NOW), null);
  assert.equal(readBenficaCache(cache(NOW, [{ ...parsed()[0], url: 'javascript:alert(1)' }]), NOW).matches[0].url, null);
});

function harness(options = {}) {
  const nodes = new Map(), network = [], listeners = new Map(), docListeners = new Map(), stored = new Map();
  if (options.cache) stored.set(BENFICA_CACHE_KEY, options.cache);
  let clock = NOW, settings;
  class Element {
    constructor() { this.children = []; this.attributes = {}; this.dataset = {}; this.textContent = ''; this.hidden = false; }
    append(...values) { this.children.push(...values); }
    replaceChildren(...values) { this.children = values.flatMap(x => x.fragment ? x.children : [x]); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  for (const id of ['summary-benfica', 'benfica-matches', 'benfica-status', 'benfica-warning']) nodes.set(id, new Element());
  const doc = { hidden: !!options.hidden, getElementById: id => nodes.get(id), createElement: () => new Element(), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }),
    addEventListener: (name, callback) => docListeners.set(name, callback), removeEventListener: name => docListeners.delete(name) };
  const win = { navigator: { onLine: !options.offline }, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  const instance = initializeBenficaFixtures({ document: doc, window: win, now: () => clock,
    storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    autoRefreshFactory: config => { settings = config; return { start() {}, dispose() {} }; },
    fetch: async (url, request) => { network.push({ url, request }); return options.fetch ? options.fetch(url, request) : new Response(JSON.stringify(body(match())), { status: 200 }); }
  });
  return { nodes, network, instance, stored, doc, win, listeners, get settings() { return settings; }, advance: ms => { clock += ms; } };
}
const text = element => [element.textContent, ...element.children.map(text)].join(' ');

test('Widget loads the live endpoint read-only, uses a fifteen-minute refresh, and keeps DOM nodes for unchanged data', async () => {
  const h = harness(); await settle();
  try {
    assert.equal(h.network.length, 1); assert.equal(h.network[0].url, BENFICA_URL);
    assert.equal(h.network[0].request.method, 'GET'); assert.equal(h.network[0].request.credentials, 'omit');
    assert.equal(h.network[0].request.headers, undefined); assert.equal(h.settings.intervalMs, BENFICA_INTERVAL_MS);
    assert.equal(h.nodes.get('summary-benfica').dataset.state, 'ready');
    assert.ok(text(h.nodes.get('benfica-matches')).includes('21:45'));
    const first = h.nodes.get('benfica-matches').children[0];
    await h.instance.refresh(); assert.equal(h.nodes.get('benfica-matches').children[0], first);
    assert.equal(h.nodes.get('benfica-warning').hidden, true);
  } finally { h.instance.dispose(); }
});

test('A first request failure exits loading and announces an automatic retry', async () => {
  const h = harness({ fetch: async () => { throw new Error('offline'); } }); await settle();
  try {
    assert.equal(h.nodes.get('summary-benfica').dataset.state, 'unavailable');
    assert.ok(text(h.nodes.get('benfica-matches')).includes('réessai automatique'));
    assert.equal(h.nodes.get('benfica-matches').attributes['aria-busy'], 'false');
  } finally { h.instance.dispose(); }
});

test('Failure retains cached fixtures with their timestamp, then recovery clears the warning on later visibility events', async () => {
  let failed = true;
  const h = harness({ cache: cache(NOW - 60_000), fetch: () => failed ? Promise.reject(new Error('temporary')) : Promise.resolve(new Response(JSON.stringify(body(match())), { status: 200 })) });
  await settle();
  try {
    assert.equal(h.nodes.get('summary-benfica').dataset.state, 'stale');
    assert.equal(h.nodes.get('benfica-warning').hidden, false);
    assert.ok(text(h.nodes.get('benfica-matches')).includes('Benfica'));
    failed = false; await h.instance.refresh(); h.listeners.get('pageshow')();
    assert.equal(h.nodes.get('summary-benfica').dataset.state, 'ready');
    assert.equal(h.nodes.get('benfica-warning').hidden, true);
  } finally { h.instance.dispose(); }
});

test('An offline reload restores the last public schedule and discards fixtures that have already started', async () => {
  const old = parseBenficaSchedule(body(match('1', '2026-11-08T20:00Z'), match('2')));
  const h = harness({ offline: true, cache: cache(NOW - 60_000, old) }); await settle();
  try {
    assert.equal(h.network.length, 0); assert.equal(h.nodes.get('benfica-matches').children.length, 1);
    assert.equal(h.nodes.get('summary-benfica').dataset.state, 'stale');
  } finally { h.instance.dispose(); }
});

test('Concurrent requests are bounded and disposal aborts the fetch and ignores its late response', async () => {
  let finish;
  const h = harness({ fetch: () => new Promise(resolve => { finish = resolve; }) }); await settle();
  await h.instance.refresh(); assert.equal(h.network.length, 1);
  h.instance.dispose(); assert.equal(h.network[0].request.signal.aborted, true);
  finish(new Response(JSON.stringify(body(match())), { status: 200 })); await settle();
  assert.ok(!text(h.nodes.get('benfica-matches')).includes('Fixture opponent'));
  assert.equal(h.stored.size, 0);
});

test('A fresh cancelled fixture is removed and external names stay literal text', async () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const h = harness({ cache: cache(), fetch: () => Promise.resolve(new Response(JSON.stringify(body(match('2', '2026-12-01T20:00Z', { opponent: malicious }), match('1', '2026-11-22T20:45Z', { status: { name: 'STATUS_CANCELED' } }))), { status: 200 })) });
  await settle();
  try {
    assert.equal(h.nodes.get('benfica-matches').children.length, 1);
    assert.ok(text(h.nodes.get('benfica-matches')).includes(malicious));
    assert.ok(!text(h.nodes.get('benfica-matches')).includes('Fixture opponent'));
  } finally { h.instance.dispose(); }
});
