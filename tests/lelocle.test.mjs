import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LELOCLE_URL, LELOCLE_SOURCE_URL, LELOCLE_CACHE_KEY, LELOCLE_INTERVAL_MS,
  parseLeLocleCalendar, parseLeLocleFeed, parseLeLocleDate, upcomingLeLocleMatches, leLocleMatchWhen, safeLeLocleUrl } from '../lelocle-core.mjs';
import { initializeLeLocleFixtures } from '../lelocle.mjs';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const calendar = (...events) => `BEGIN:VCALENDAR\r\r\nVERSION:2.0\r\r\nX-WR-CALNAME:FC Le Locle - Juniors A\r\r\n${events.join('\r\r\n')}\r\r\nEND:VCALENDAR\r\r\n`;
const event = (id = '1', date = '20270206T160000', extra = '') => `BEGIN:VEVENT\r\r\nUID:${id}@football.ch\r\r\nDTSTART;TZID=TZsfv:${date}\r\r\nSUMMARY:FC Le Locle (Jun.A)\r\r\n  - Fixture opponent\r\r\nDESCRIPTION:championnat Juniors A\r\r\n  - Groupe 1\\n\\nN° match 123456\\npas encore joué\r\r\n${extra}\r\r\nEND:VEVENT`;
const feed = (ics = calendar(event()), overrides = {}) => ({ schemaVersion: 1, teamId: '34107', checkedAt: new Date(NOW).toISOString(), checkFailed: false, calendar: ics, ...overrides });
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
  for (const id of ['summary-lelocle', 'lelocle-matches', 'lelocle-status', 'lelocle-warning']) nodes.set(id, new Element());
  const doc = { hidden: false, getElementById: id => nodes.get(id), createElement: () => new Element(), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }), addEventListener() {}, removeEventListener() {} };
  const win = { navigator: { onLine: !options.offline }, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  const instance = initializeLeLocleFixtures({ document: doc, window: win, now: () => clock,
    storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
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
    assert.ok(text(h.nodes.get('lelocle-matches')).includes('Aucun prochain match annoncé'));
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
