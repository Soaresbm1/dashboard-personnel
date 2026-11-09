import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../reader-core.js';
import { createCaptureManager, CAPTURE_TIMEOUT_MS, PERIOD_MS, PERIODIC_ALARM, TIMEOUT_ALARM, isDashboardSender } from '../capture-manager.mjs';
const reader = globalThis.DashboardFootballReader;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const dashboard = { url: 'https://soaresbm1.github.io/dashboard-personnel/#overview' };
const row = overrides => ({ id: '21', home: 'FC Le Locle', away: 'Fixture opponent', startsAt: '2026-11-08T14:00:00Z', timeConfirmed: true, scoreHome: 0, scoreAway: 2, league: 'Juniors A', url: reader.SOURCE_URL, ...overrides });
function harness() {
  let clock = NOW, nextId = 10;
  const local = {}, session = {}, tabs = new Map(), alarms = new Map(), created = [], removed = [];
  const area = state => ({ async get(key) { return structuredClone({ [key]: state[key] }); }, async set(values) { Object.assign(state, structuredClone(values)); }, async remove(key) { delete state[key]; } });
  const api = { runtime: { id: 'alepjbcpdhcadcbggjgelichkenlmepc', getManifest: () => ({ version: '1.0.0' }), getURL: path => `chrome-extension://alepjbcpdhcadcbggjgelichkenlmepc/${path}` },
    storage: { local: area(local), session: area(session) },
    tabs: { async create(options) { const tab = { id: nextId++, ...options }; created.push(tab); tabs.set(tab.id, tab); return { ...tab }; }, async get(id) { if (!tabs.has(id)) throw Error('missing'); return { ...tabs.get(id) }; }, async remove(id) { removed.push(id); tabs.delete(id); } },
    alarms: { async create(name, config) { alarms.set(name, config); }, async get(name) { return alarms.get(name); }, async clear(name) { return alarms.delete(name); } }
  };
  const make = () => createCaptureManager(api, reader, { now: () => clock, randomId: () => 'fixture-request' });
  const manager = make();
  const sender = (id = created.at(-1)?.id) => ({ id: api.runtime.id, frameId: 0, url: reader.SOURCE_URL, tab: { id, url: reader.SOURCE_URL } });
  async function capture(rows = [row()]) { const hello = await manager.source({ type: 'SOURCE_HELLO' }, sender()); return manager.source({ type: 'SOURCE_RESULTS', requestId: hello.requestId, results: rows }, sender()); }
  return { api, manager, make, tabs, alarms, created, removed, local, session, sender, capture, advance: milliseconds => { clock += milliseconds; } };
}

test('Only the configured dashboard can read or request refresh; foreign origins, paths and commands never create tabs', async () => {
  const h = harness();
  for (const url of ['https://evil.test/', 'https://soaresbm1.github.io/other/', 'http://soaresbm1.github.io/dashboard-personnel/', 'https://user@soaresbm1.github.io/dashboard-personnel/']) {
    assert.equal(isDashboardSender({ url }), false); assert.ok((await h.manager.external({ type: 'GET_RESULTS' }, { url })).error);
  }
  assert.ok((await h.manager.external({ type: 'WRITE_RESULTS' }, dashboard)).error);
  assert.equal(h.created.length, 0);
});

test('GET responds with cached state immediately and creates only one inactive fixed-source tab; read-only results close that tab', async () => {
  const h = harness(); await h.manager.initialize();
  const initial = await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  assert.equal(initial.installed, true); assert.equal(initial.refreshing, true); assert.equal(initial.resultsState, 'unavailable');
  assert.deepEqual(h.created.map(tab => ({ active: tab.active, url: tab.url })), [{ active: false, url: reader.SOURCE_URL }]);
  await h.manager.external({ type: 'GET_RESULTS' }, dashboard); assert.equal(h.created.length, 1);
  assert.equal((await h.capture()).accepted, true); assert.deepEqual(h.removed, [10]);
  const value = await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  assert.equal(value.results[0].scoreHome, 0); assert.equal(value.resultsCheckFailed, false); assert.equal(value.refreshing, false);
  assert.equal(value.resultsCheckedAt, new Date(NOW).toISOString());
  assert.equal(h.alarms.get(PERIODIC_ALARM).periodInMinutes, 7_200);
});

test('A user-activated tab is preserved even after becoming inactive again', async () => {
  const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  await h.manager.activated({ tabId: 10 }); h.tabs.get(10).active = false;
  await h.capture(); assert.deepEqual(h.removed, []); assert.ok(h.tabs.has(10));
});

test('Navigation away, a missing URL or an active tab prevents automatic closure', async () => {
  for (const change of ['navigate', 'hidden-url', 'active']) {
    const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
    if (change === 'navigate') { await h.manager.updated(10, { url: 'https://evil.test/' }, { active: false }); h.tabs.get(10).url = reader.SOURCE_URL; }
    else if (change === 'hidden-url') delete h.tabs.get(10).url;
    else h.tabs.get(10).active = true;
    await h.capture(); assert.deepEqual(h.removed, [], change);
  }
});

test('A source message must come from the owned top frame, exact team URL and current request nonce', async () => {
  const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  for (const sender of [{ ...h.sender(), frameId: 1 }, h.sender(99), { ...h.sender(), url: 'https://evil.test/' }, { ...h.sender(), id: 'other' }]) {
    assert.equal((await h.manager.source({ type: 'SOURCE_HELLO' }, sender)).capture, false);
  }
  assert.equal((await h.manager.source({ type: 'SOURCE_RESULTS', requestId: 'old', results: [row()] }, h.sender())).capture, false);
  assert.equal(h.removed.length, 0); await h.capture(); assert.equal(h.removed.length, 1);
});

test('Failed or malformed capture retains the last good scores and original timestamp, never replacing them with a fake empty result', async () => {
  const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard); await h.capture();
  h.advance(PERIOD_MS); await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  const hello = await h.manager.source({ type: 'SOURCE_HELLO' }, h.sender());
  await h.manager.source({ type: 'SOURCE_RESULTS', requestId: hello.requestId, results: [row({ scoreHome: '-' })] }, h.sender());
  const value = await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  assert.equal(value.results[0].scoreHome, 0); assert.equal(value.resultsCheckedAt, new Date(NOW).toISOString()); assert.equal(value.resultsCheckFailed, true);
});

test('Timeout survives service-worker restart and closes only its own untouched inactive tab', async () => {
  const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  const reloaded = h.make(); await reloaded.initialize();
  await reloaded.external({ type: 'GET_RESULTS' }, dashboard); assert.equal(h.created.length, 1);
  h.advance(CAPTURE_TIMEOUT_MS); await reloaded.alarm({ name: TIMEOUT_ALARM });
  assert.deepEqual(h.removed, [10]); assert.equal((await reloaded.external({ type: 'GET_RESULTS' }, dashboard)).resultsState, 'unavailable');
});

test('A valid capture can complete after worker restart and successful empty data deliberately clears prior scores', async () => {
  const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  const reloaded = h.make(); await reloaded.initialize();
  const hello = await reloaded.source({ type: 'SOURCE_HELLO' }, h.sender());
  await reloaded.source({ type: 'SOURCE_RESULTS', requestId: hello.requestId, results: [row()] }, h.sender());
  h.advance(PERIOD_MS); await h.manager.external({ type: 'GET_RESULTS' }, dashboard); await h.capture([]);
  const value = await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  assert.equal(value.resultsState, 'ready'); assert.deepEqual(value.results, []); assert.equal(value.resultsCheckFailed, false);
});

test('Manual refresh is bounded by thirty seconds and automatic requests by five days', async () => {
  const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard); await h.capture();
  await h.manager.external({ type: 'REFRESH_RESULTS' }, dashboard); assert.equal(h.created.length, 1);
  h.advance(30_000); await h.manager.external({ type: 'REFRESH_RESULTS' }, dashboard); assert.equal(h.created.length, 2); await h.capture();
  await h.manager.alarm({ name: PERIODIC_ALARM }); assert.equal(h.created.length, 2);
});

test('Updating the fifteen-minute alarm preserves cached scores and waits five days from the last attempt, including after restart', async () => {
  const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard); await h.capture();
  h.alarms.set(PERIODIC_ALARM, { periodInMinutes: 15, when: NOW + 15 * 60_000 });
  h.advance(15 * 60_000);
  const updated = h.make(); await updated.initialize();
  assert.equal(PERIOD_MS, 432_000_000);
  assert.deepEqual(h.alarms.get(PERIODIC_ALARM), { when: NOW + 432_000_000, periodInMinutes: 7_200 });
  await updated.startup();
  let value = await updated.external({ type: 'GET_RESULTS' }, dashboard);
  assert.equal(h.created.length, 1); assert.equal(value.resultsCheckedAt, new Date(NOW).toISOString());
  assert.equal(value.resultsCheckFailed, false);
  h.advance(432_000_000 - 15 * 60_000 - 1);
  await updated.alarm({ name: PERIODIC_ALARM }); assert.equal(h.created.length, 1);
  h.advance(1); await updated.alarm({ name: PERIODIC_ALARM });
  assert.equal(h.created.length, 2);
  assert.equal(h.alarms.get(PERIODIC_ALARM).when, NOW + 2 * 432_000_000);
});

test('A manual check resets the next five-day deadline without discarding the prior successful observation', async () => {
  const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard); await h.capture();
  h.advance(2 * 24 * 60 * 60_000);
  await h.manager.external({ type: 'REFRESH_RESULTS' }, dashboard);
  assert.equal(h.created.length, 2);
  assert.equal(h.alarms.get(PERIODIC_ALARM).when, NOW + 7 * 24 * 60 * 60_000);
  const hello = await h.manager.source({ type: 'SOURCE_HELLO' }, h.sender());
  await h.manager.source({ type: 'SOURCE_FAILED', requestId: hello.requestId }, h.sender());
  h.advance(3 * 24 * 60 * 60_000);
  await h.manager.alarm({ name: PERIODIC_ALARM });
  const value = await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  assert.equal(h.created.length, 2); assert.equal(value.resultsCheckedAt, new Date(NOW).toISOString());
  assert.equal(value.resultsCheckFailed, true);
});

test('A lost alarm is restored from the saved attempt and an overdue restart launches only one catch-up check', async () => {
  const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard); await h.capture();
  h.advance(4 * 24 * 60 * 60_000); h.alarms.delete(PERIODIC_ALARM);
  const restarted = h.make(); await restarted.initialize();
  assert.equal(h.alarms.get(PERIODIC_ALARM).when, NOW + 432_000_000);
  await restarted.startup(); assert.equal(h.created.length, 1);
  h.advance(2 * 24 * 60 * 60_000); h.alarms.delete(PERIODIC_ALARM);
  const overdue = h.make(); await overdue.initialize(); await overdue.startup();
  await overdue.external({ type: 'GET_RESULTS' }, dashboard); await overdue.alarm({ name: PERIODIC_ALARM });
  assert.equal(h.created.length, 2);
  assert.equal(h.alarms.get(PERIODIC_ALARM).when, NOW + 11 * 24 * 60 * 60_000);
});

test('Activation received while a capture is completing protects the tab without waiting for the serialized storage update', async () => {
  const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  const hello = await h.manager.source({ type: 'SOURCE_HELLO' }, h.sender());
  const pending = h.manager.source({ type: 'SOURCE_RESULTS', requestId: hello.requestId, results: [row()] }, h.sender());
  const activation = h.manager.activated({ tabId: 10 });
  await pending; await activation; assert.deepEqual(h.removed, []);
});

test('Activation during asynchronous session recovery protects the recovered tab before a queued result can close it', async () => {
  const h = harness(); await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  const originalGet = h.api.storage.session.get;
  let release;
  h.api.storage.session.get = key => new Promise(resolve => { release = async () => resolve(await originalGet(key)); });
  const reloaded = h.make();
  const capture = reloaded.source({ type: 'SOURCE_RESULTS', requestId: 'fixture-request', results: [row()] }, h.sender());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  const activation = reloaded.activated({ tabId: 10 });
  await release(); await capture; await activation;
  assert.deepEqual(h.removed, []); assert.ok(h.tabs.has(10));
});
