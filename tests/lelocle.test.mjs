import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LELOCLE_URL, LELOCLE_SOURCE_URL, LELOCLE_CACHE_KEY, LELOCLE_INTERVAL_MS,
  parseLeLocleCalendar, parseLeLocleFeed, parseLeLocleDate, upcomingLeLocleMatches, leLocleMatchWhen, safeLeLocleUrl, selectLeLocleView, readLeLocleCache, mergeLeLocleSnapshot, mergeLeLocleExtension } from '../lelocle-core.mjs';
import { initializeLeLocleFixtures } from '../lelocle.mjs';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const calendar = (...events) => `BEGIN:VCALENDAR\r\r\nVERSION:2.0\r\r\nX-WR-CALNAME:FC Le Locle - Juniors A\r\r\n${events.join('\r\r\n')}\r\r\nEND:VCALENDAR\r\r\n`;
const event = (id = '1', date = '20270206T160000', extra = '') => `BEGIN:VEVENT\r\r\nUID:${id}@football.ch\r\r\nDTSTART;TZID=TZsfv:${date}\r\r\nSUMMARY:FC Le Locle (Jun.A)\r\r\n  - Fixture opponent\r\r\nDESCRIPTION:championnat Juniors A\r\r\n  - Groupe 1\\n\\nN° match 123456\\npas encore joué\r\r\n${extra}\r\r\nEND:VEVENT`;
const feed = (ics = calendar(event()), overrides = {}) => ({ schemaVersion: 1, teamId: '34107', checkedAt: new Date(NOW).toISOString(), checkFailed: false, calendar: ics, resultsState: 'ready', results: [], resultsCheckedAt: new Date(NOW).toISOString(), resultsCheckFailed: false, ...overrides });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Official empty team calendar is a successful empty result, distinct from a failed or wrong feed', () => {
  assert.deepEqual(parseLeLocleFeed(feed(calendar()), NOW).matches, []);
  for (const value of ['<html>Access denied</html>', calendar().replace('Juniors A', 'Calendrier club'), calendar(event()).replace('END:VCALENDAR', '')]) assert.throws(() => parseLeLocleCalendar(value));
  for (const value of [feed(calendar(), { teamId: '34108' }), feed(calendar(), { checkFailed: 'false' }), feed(calendar(), { checkedAt: 'bad' }), feed(calendar(), { checkedAt: '2026-11-09T14:00:00Z' })]) assert.throws(() => parseLeLocleFeed(value, NOW));
});

test('Folded official ICS lines, escaped punctuation and CET local kickoff are parsed as Juniors A fixtures', () => {
  const row = parseLeLocleCalendar(calendar(event().replace('Fixture opponent', 'Fixture\\, opponent')))[0];
  assert.equal(row.home, 'FC Le Locle (Jun.A)'); assert.equal(row.away, 'Fixture, opponent');
  assert.equal(row.startsAt, '2027-02-06T15:00:00.000Z'); assert.equal(row.league, 'championnat Juniors A - Groupe 1');
  assert.equal(row.url, LELOCLE_SOURCE_URL); assert.match(leLocleMatchWhen(row), /16:00$/);
  for (const name of ['FC Le Locle (Jun.B)', 'FC Le Locle II', 'FC Le Communal Sport Le Locle']) assert.throws(() => parseLeLocleCalendar(calendar(event().replace('FC Le Locle (Jun.A)', name))));
});

test('Date conversion handles UTC, summer, date-only, placeholder midnight and DST gaps/ambiguity without invented times', () => {
  assert.deepEqual(parseLeLocleDate('20270706T160000', ';TZID=TZsfv'), { startsAt: '2027-07-06T14:00:00.000Z', timeConfirmed: true });
  assert.deepEqual(parseLeLocleDate('20270206T160000Z'), { startsAt: '2027-02-06T16:00:00.000Z', timeConfirmed: true });
  for (const date of ['20270320T000000', '20270320', '20270328T023000', '20261025T023000']) assert.equal(parseLeLocleDate(date, ';TZID=TZsfv').timeConfirmed, false);
  assert.throws(() => parseLeLocleDate('20270230T160000'));
  assert.throws(() => parseLeLocleDate('20270206T160000', ';TZID=Asia/Tokyo'));
  assert.equal(upcomingLeLocleMatches([{ id: '1', ...parseLeLocleDate('20270320', ';VALUE=DATE') }], Date.parse('2027-03-20T18:00Z')).length, 1);
});

test('Only three upcoming fixtures remain, and explicit cancellations or higher-sequence replacements are respected', () => {
  const rows = parseLeLocleCalendar(calendar(event('1', '20261108T160000'), event('2'), event('3', '20270207T160000'), event('4', '20270208T160000'), event('5', '20270209T160000'),
    event('6', '20270210T160000'), event('6', '20270210T160000', 'SEQUENCE:2\r\r\nSTATUS:CANCELLED')));
  assert.deepEqual(upcomingLeLocleMatches(rows, NOW).map(x => x.id), ['2', '3', '4']);
  assert.ok(!rows.some(x => x.id === '6'));
  assert.deepEqual(parseLeLocleCalendar(calendar(event().replace('pas encore joué', 'match renvoyé'))), []);
});

test('No feed URL can override the fixed official team calendar link', () => {
  assert.equal(safeLeLocleUrl(LELOCLE_SOURCE_URL), LELOCLE_SOURCE_URL);
  for (const value of ['javascript:alert(1)', `${LELOCLE_SOURCE_URL}&other=1`, LELOCLE_SOURCE_URL.replace('34107', '34108'), 'https://evil.test/']) assert.equal(safeLeLocleUrl(value), null);
});

function harness(options = {}) {
  const nodes = new Map(), stored = new Map(), network = [], listeners = new Map();
  if (options.cached) stored.set(LELOCLE_CACHE_KEY, options.cached);
  let clock = NOW, settings;
  class Element {
    constructor() { this.children = []; this.textContent = ''; this.dataset = {}; this.attributes = {}; this.hidden = false; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items.flatMap(x => x.fragment ? x.children : [x]); }
    setAttribute(key, value) { this.attributes[key] = value; }
  }
  for (const id of ['summary-lelocle', 'lelocle-mode', 'lelocle-extension-status', 'lelocle-matches', 'lelocle-status', 'lelocle-warning']) nodes.set(id, new Element());
  const doc = { hidden: false, getElementById: id => nodes.get(id), createElement: () => new Element(), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }), addEventListener() {}, removeEventListener() {} };
  const win = { navigator: { onLine: !options.offline }, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  const instance = initializeLeLocleFixtures({ document: doc, window: win, now: () => clock,
    storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    extensionBridgeFactory: options.extensionBridgeFactory || (() => ({ dispose() {} })),
    autoRefreshFactory: config => { settings = config; return { start() {}, dispose() {} }; },
    fetch: async (url, request) => { network.push({ url, request }); return options.fetch ? options.fetch(url, request) : new Response(JSON.stringify(feed(calendar())), { status: 200 }); }
  });
  return { nodes, stored, network, instance, listeners, get settings() { return settings; }, advance: value => { clock += value; } };
}
const text = node => [node.textContent, ...node.children.map(text)].join(' ');

test('Live empty calendar renders a truthful empty state with read-only automatic refresh and no Microsoft dependency', async () => {
  const h = harness(); await settle();
  try {
    assert.equal(h.nodes.get('summary-lelocle').dataset.state, 'ready');
    assert.ok(text(h.nodes.get('lelocle-matches')).includes('Aucun résultat publié'));
    assert.equal(h.network.length, 1); assert.equal(h.network[0].url, LELOCLE_URL);
    assert.equal(h.network[0].request.method, 'GET'); assert.equal(h.network[0].request.headers, undefined);
    assert.equal(h.network[0].request.credentials, 'omit'); assert.equal(h.settings.intervalMs, LELOCLE_INTERVAL_MS);
  } finally { h.instance.dispose(); }
});

test('A retained server snapshot preserves its original timestamp and visible warning through a later browser failure', async () => {
  let failed = false;
  const oldAt = new Date(NOW - 60 * 60_000).toISOString();
  const h = harness({ fetch: () => failed ? Promise.reject(new Error('network')) : Promise.resolve(new Response(JSON.stringify(feed(calendar(event()), { checkedAt: oldAt, checkFailed: true })), { status: 200 })) });
  await settle();
  try {
    assert.equal(h.nodes.get('summary-lelocle').dataset.state, 'stale'); assert.equal(h.nodes.get('lelocle-warning').hidden, false);
    assert.equal(JSON.parse(h.stored.get(LELOCLE_CACHE_KEY)).at, Date.parse(oldAt));
    const first = h.nodes.get('lelocle-matches').children[0], original = h.nodes.get('lelocle-warning').textContent;
    failed = true; h.advance(900_000); await h.instance.refresh();
    assert.equal(h.nodes.get('lelocle-matches').children[0], first); assert.equal(h.nodes.get('lelocle-warning').textContent, original);
  } finally { h.instance.dispose(); }
});

test('Published future fixtures replace a previous empty state and recovery clears retained-data warnings', async () => {
  let state = 'empty';
  const h = harness({ fetch: () => Promise.resolve(new Response(JSON.stringify(feed(state === 'empty' ? calendar() : calendar(event()), { checkFailed: state === 'old' })), { status: 200 })) });
  await settle();
  try {
    state = 'old'; await h.instance.refresh(); assert.ok(text(h.nodes.get('lelocle-matches')).includes('Fixture opponent'));
    assert.equal(h.nodes.get('lelocle-warning').hidden, false);
    state = 'fresh'; await h.instance.refresh(); h.listeners.get('pageshow')();
    assert.equal(h.nodes.get('lelocle-warning').hidden, true); assert.equal(h.nodes.get('summary-lelocle').dataset.state, 'ready');
  } finally { h.instance.dispose(); }
});

test('Unavailable source without a cached observation never claims no upcoming fixtures', async () => {
  const h = harness({ fetch: () => Promise.resolve(new Response('{}', { status: 503 })) }); await settle();
  try {
    assert.equal(h.nodes.get('summary-lelocle').dataset.state, 'unavailable');
    assert.ok(text(h.nodes.get('lelocle-matches')).includes('indisponible'));
    assert.ok(!text(h.nodes.get('lelocle-matches')).includes('Aucun prochain'));
  } finally { h.instance.dispose(); }
});

const result = (id = '21', overrides = {}) => ({ id, home: 'FC Le Locle', away: `Fixture ${id}`, startsAt: '2026-11-08T14:00:00Z',
  timeConfirmed: true, scoreHome: 0, scoreAway: 2, league: 'Juniors A', url: LELOCLE_SOURCE_URL, ...overrides });
const withResults = (results, extra = {}) => feed(calendar(), { results, ...extra });

test('No upcoming fixture selects the latest three completed scores in reverse date order, including a real zero score', async () => {
  const rows = [result('21', { startsAt: '2026-10-01T14:00:00Z' }), result('22', { startsAt: '2026-10-22T14:00:00Z' }),
    result('23', { startsAt: '2026-11-03T14:00:00Z' }), result('24')];
  const parsed = parseLeLocleFeed(withResults(rows), NOW);
  assert.deepEqual(selectLeLocleView(parsed, NOW).matches.map(row => row.id), ['24', '23', '22']);
  const h = harness({ fetch: () => Promise.resolve(new Response(JSON.stringify(withResults(rows)), { status: 200 })) }); await settle();
  try {
    assert.equal(h.nodes.get('lelocle-mode').textContent, 'Derniers résultats');
    assert.equal(h.nodes.get('lelocle-matches').children.length, 3);
    assert.ok(text(h.nodes.get('lelocle-matches')).includes('0–2'));
    assert.ok(h.nodes.get('lelocle-matches').attributes['aria-label'].includes('derniers résultats'));
  } finally { h.instance.dispose(); }
});

test('New upcoming matches take priority over results, and the panel returns to scores when the future calendar is empty', async () => {
  let upcoming = false;
  const h = harness({ fetch: () => Promise.resolve(new Response(JSON.stringify(feed(upcoming ? calendar(event()) : calendar(), { results: [result()] })), { status: 200 })) }); await settle();
  try {
    assert.equal(h.nodes.get('summary-lelocle').dataset.mode, 'results');
    upcoming = true; await h.instance.refresh();
    assert.equal(h.nodes.get('lelocle-mode').textContent, 'Prochains matchs');
    assert.ok(text(h.nodes.get('lelocle-matches')).includes('Fixture opponent'));
    assert.ok(!text(h.nodes.get('lelocle-matches')).includes('0–2'));
    upcoming = false; await h.instance.refresh();
    assert.equal(h.nodes.get('summary-lelocle').dataset.mode, 'results');
    assert.ok(text(h.nodes.get('lelocle-matches')).includes('0–2'));
  } finally { h.instance.dispose(); }
});

test('Malformed scores, other teams and future dates never become completed results, while valid upcoming data stays usable', () => {
  for (const row of [result('1', { scoreHome: '-' }), result('1', { scoreAway: null }), result('1', { scoreHome: -1 }), result('1', { scoreAway: 1.5 }),
    result('1', { home: 'FC Le Locle II' }), result('1', { startsAt: '2027-01-01T12:00:00Z' }), result('1', { startsAt: 'bad' })]) {
    const past = parseLeLocleFeed(withResults([row]), NOW);
    assert.equal(selectLeLocleView(past, NOW).available, false);
    const future = parseLeLocleFeed(feed(calendar(event()), { results: [row] }), NOW);
    assert.equal(selectLeLocleView(future, NOW).mode, 'upcoming');
  }
});

test('Result-source failure retains the last valid scores and their own original timestamp even when calendar data is fresh', async () => {
  let missing = false;
  const old = new Date(NOW - 60 * 60_000).toISOString();
  const h = harness({ fetch: () => Promise.resolve(new Response(JSON.stringify(missing ? withResults([], { resultsState: 'unavailable', resultsCheckedAt: null, resultsCheckFailed: true }) : withResults([result()], { resultsCheckedAt: old })), { status: 200 })) });
  await settle();
  try {
    const first = h.nodes.get('lelocle-matches').children[0];
    missing = true; h.advance(900_000); await h.instance.refresh();
    assert.equal(h.nodes.get('lelocle-matches').children[0], first);
    assert.equal(h.nodes.get('summary-lelocle').dataset.state, 'stale');
    assert.equal(h.nodes.get('lelocle-warning').hidden, false);
    const cached = JSON.parse(h.stored.get(LELOCLE_CACHE_KEY));
    assert.equal(cached.resultsAt, Date.parse(old)); assert.equal(cached.resultsFailed, true);
    assert.equal(readLeLocleCache(JSON.stringify(cached), NOW + 900_000).results[0].scoreHome, 0);
  } finally { h.instance.dispose(); }
});

test('Dated server-retained results are visibly stale; an explicit successful empty result replaces older scores', async () => {
  let empty = false;
  const h = harness({ fetch: () => Promise.resolve(new Response(JSON.stringify(withResults(empty ? [] : [result()], { resultsCheckFailed: !empty })), { status: 200 })) }); await settle();
  try {
    assert.equal(h.nodes.get('summary-lelocle').dataset.state, 'stale');
    assert.equal(h.nodes.get('lelocle-warning').hidden, false);
    empty = true; await h.instance.refresh();
    assert.equal(h.nodes.get('summary-lelocle').dataset.state, 'ready');
    assert.ok(text(h.nodes.get('lelocle-matches')).includes('Aucun résultat publié'));
    assert.ok(!text(h.nodes.get('lelocle-matches')).includes('0–2'));
  } finally { h.instance.dispose(); }
});

test('Older result observations cannot overwrite a newer cache, and legacy calendar-only responses mean unavailable results', () => {
  const previous = parseLeLocleFeed(withResults([result()]), NOW);
  const older = parseLeLocleFeed(withResults([], { resultsCheckedAt: new Date(NOW - 60_000).toISOString() }), NOW);
  const merged = mergeLeLocleSnapshot(previous, older, NOW);
  assert.equal(merged.results.length, 1); assert.equal(merged.resultsAt, NOW); assert.equal(merged.resultsFailed, true);
  const legacy = feed(calendar()); delete legacy.resultsState;
  assert.equal(selectLeLocleView(parseLeLocleFeed(legacy, NOW), NOW).available, false);
});

test('A fresh extension observation updates displayed scores without a page reload or API refetch', async () => {
  let receive, disposed = false;
  const h = harness({ extensionBridgeFactory: callback => { receive = callback; return { dispose() { disposed = true; } }; },
    fetch: () => Promise.resolve(new Response(JSON.stringify(withResults([result()], { resultsCheckedAt: new Date(NOW - 60_000).toISOString(), resultsCheckFailed: true })), { status: 200 })) });
  await settle();
  try {
    assert.equal(h.nodes.get('summary-lelocle').dataset.state, 'stale');
    receive({ installed: true, version: '1.0.0', resultsState: 'ready', resultsCheckedAt: new Date(NOW).toISOString(), resultsCheckFailed: false, results: [result('22', { scoreHome: 4, scoreAway: 0 })] });
    assert.equal(h.network.length, 1);
    assert.ok(text(h.nodes.get('lelocle-matches')).includes('4–0'));
    assert.ok(!text(h.nodes.get('lelocle-matches')).includes('0–2'));
    assert.equal(h.nodes.get('summary-lelocle').dataset.state, 'ready');
    assert.equal(h.nodes.get('lelocle-extension-status').dataset.state, 'connected');
    assert.equal(h.nodes.get('lelocle-warning').hidden, true);
  } finally { h.instance.dispose(); }
  assert.equal(disposed, true);
});

test('An invalid, missing or older extension snapshot cannot corrupt newer validated scores', () => {
  const snapshot = parseLeLocleFeed(withResults([result()]), NOW);
  assert.equal(mergeLeLocleExtension(snapshot, { installed: false }, NOW), snapshot);
  assert.equal(mergeLeLocleExtension(snapshot, { installed: true, resultsState: 'ready', resultsCheckedAt: new Date(NOW).toISOString(), resultsCheckFailed: false, results: [result('2', { scoreHome: '-' })] }, NOW), snapshot);
  const older = mergeLeLocleExtension(snapshot, { installed: true, resultsState: 'ready', resultsCheckedAt: new Date(NOW - 60_000).toISOString(), resultsCheckFailed: false, results: [] }, NOW);
  assert.equal(older.results.length, 1); assert.equal(older.resultsAt, NOW);
});
