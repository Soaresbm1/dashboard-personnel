import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../reader-core.js';
import { createCaptureManager, CAPTURE_TIMEOUT_MS, PERIOD_MS, PERIODIC_ALARM, TIMEOUT_ALARM, isDashboardSender } from '../capture-manager.mjs';
const reader = globalThis.DashboardFootballReader;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const dashboard = { url: 'https://soaresbm1.github.io/dashboard-personnel/#overview' };
const row = overrides => ({ id: '21', home: 'FC Le Locle', away: 'Fixture opponent', startsAt: '2026-11-08T14:00:00Z', timeConfirmed: true, scoreHome: 0, scoreAway: 2, league: 'Juniors A', url: reader.SOURCE_URL, ...overrides });
function harness(teamIds = ['34107']) {
  let clock = NOW, nextId = 10;
  const local = {}, session = {}, tabs = new Map(), alarms = new Map(), created = [], removed = [];
  const area = state => ({ async get(key) { return structuredClone({ [key]: state[key] }); }, async set(values) { Object.assign(state, structuredClone(values)); }, async remove(key) { delete state[key]; } });
  const api = { runtime: { id: 'alepjbcpdhcadcbggjgelichkenlmepc', getManifest: () => ({ version: '1.0.0' }), getURL: path => `chrome-extension://alepjbcpdhcadcbggjgelichkenlmepc/${path}` },
    storage: { local: area(local), session: area(session) },
    tabs: { async create(options) { const tab = { id: nextId++, ...options }; created.push(tab); tabs.set(tab.id, tab); return { ...tab }; }, async get(id) { if (!tabs.has(id)) throw Error('missing'); return { ...tabs.get(id) }; }, async remove(id) { removed.push(id); tabs.delete(id); } },
    alarms: { async create(name, config) { alarms.set(name, config); }, async get(name) { return alarms.get(name); }, async clear(name) { return alarms.delete(name); } }
  };
  const make = () => createCaptureManager(api, reader, { now: () => clock, randomId: () => 'fixture-request', teamIds });
  const manager = make();
  const sender = (id = created.at(-1)?.id) => ({ id: api.runtime.id, frameId: 0, url: tabs.get(id)?.url, tab: { id, url: tabs.get(id)?.url } });
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

const allTeams = reader.TEAMS.map(team => team.id);
const teamRow = (teamId, extra = {}) => { const team = reader.getTeam(teamId); return row({ home: team.owners[0], league: team.category, url: team.sourceUrl, ...extra }); };
async function captureTeam(h, teamId, rows = [teamRow(teamId)], manager = h.manager) {
  const sender = h.sender();
  const hello = await manager.source({ type: 'SOURCE_HELLO', teamId }, sender);
  assert.equal(hello.capture, true); assert.equal(hello.teamId, teamId);
  return manager.source({ type: 'SOURCE_RESULTS', teamId, requestId: hello.requestId, results: rows }, sender);
}

test('Only known string team selectors are accepted, while omitted team remains the original Juniors A contract', async () => {
  const h = harness(allTeams);
  for (const teamId of [null, 74009, '', 'other', {}, ['74009']]) {
    assert.ok((await h.manager.external({ type: 'GET_RESULTS', teamId }, dashboard)).error);
  }
  assert.equal(h.created.length, 0);
  const value = await h.manager.external({ type: 'GET_RESULTS' }, dashboard);
  assert.equal(value.teamId, '34107'); assert.equal(h.created[0].url, reader.SOURCE_URL);
});

test('A selected futsal team receives its own fixed-source tab, nonce and cache; cross-team messages and rows are rejected', async () => {
  const h = harness(allTeams);
  const value = await h.manager.external({ type: 'GET_RESULTS', teamId: '74009' }, dashboard);
  assert.equal(value.teamId, '74009'); assert.equal(value.refreshing, true);
  assert.equal(h.created[0].url, reader.getTeam('74009').sourceUrl); assert.equal(h.created[0].active, false);
  assert.equal((await h.manager.source({ type: 'SOURCE_HELLO' }, h.sender())).capture, false);
  assert.equal((await h.manager.source({ type: 'SOURCE_HELLO', teamId: '68914' }, h.sender())).capture, false);
  const hello = await h.manager.source({ type: 'SOURCE_HELLO', teamId: '74009' }, h.sender());
  assert.equal((await h.manager.source({ type: 'SOURCE_RESULTS', teamId: '74009', requestId: hello.requestId, results: [teamRow('68914')] }, h.sender())).accepted, false);
  assert.equal((await h.manager.external({ type: 'GET_RESULTS', teamId: '74009' }, dashboard)).resultsState, 'unavailable');
  h.advance(30_000); await h.manager.external({ type: 'REFRESH_RESULTS', teamId: '74009' }, dashboard);
  assert.equal((await captureTeam(h, '74009')).accepted, true);
  const own = await h.manager.external({ type: 'GET_RESULTS', teamId: '74009' }, dashboard);
  assert.equal(own.results[0].home, 'FC Le Parc'); assert.equal(own.resultsCheckFailed, false);
  assert.equal((await h.manager.external({ type: 'GET_RESULTS' }, dashboard)).resultsState, 'unavailable');
  assert.equal(h.local.dashboardFootballResultsV1.teams['34107'].sample, null);
});

test('Automatic checks refresh all three teams sequentially at five days and retain each last good observation on failure', async () => {
  const h = harness(allTeams); await h.manager.startup();
  assert.equal(h.created.length, 1);
  for (const [index, teamId] of allTeams.entries()) {
    assert.equal(h.created.length, index + 1);
    assert.equal(h.created.at(-1).url, reader.getTeam(teamId).sourceUrl);
    assert.equal((await captureTeam(h, teamId)).accepted, true);
  }
  assert.deepEqual(h.removed, [10, 11, 12]);
  h.advance(PERIOD_MS - 1); await h.manager.alarm({ name: PERIODIC_ALARM }); assert.equal(h.created.length, 3);
  h.advance(1); await h.manager.alarm({ name: PERIODIC_ALARM }); assert.equal(h.created.length, 4);
  await captureTeam(h, '34107');
  const hello = await h.manager.source({ type: 'SOURCE_HELLO', teamId: '74009' }, h.sender());
  await h.manager.source({ type: 'SOURCE_FAILED', teamId: '74009', requestId: hello.requestId }, h.sender());
  await captureTeam(h, '68914');
  for (const teamId of allTeams) {
    const value = await h.manager.external({ type: 'GET_RESULTS', teamId }, dashboard);
    assert.equal(value.teamId, teamId); assert.equal(value.results[0].home, reader.getTeam(teamId).owners[0]);
    assert.equal(value.resultsCheckedAt, new Date(teamId === '74009' ? NOW : NOW + PERIOD_MS).toISOString());
    assert.equal(value.resultsCheckFailed, teamId === '74009');
  }
  assert.equal(h.created.length, 6); assert.equal(h.alarms.get(PERIODIC_ALARM).periodInMinutes, 7_200);
});

test('Legacy single-team cache migrates only to Juniors A; unvisited new teams are still checked automatically', async () => {
  const h = harness(allTeams);
  h.local.dashboardFootballResultsV1 = { attemptAt: NOW, failed: false, sample: { checkedAt: new Date(NOW).toISOString(), results: [row()] } };
  await h.manager.startup();
  assert.equal(h.created[0].url, reader.getTeam('74009').sourceUrl);
  assert.equal((await h.manager.external({ type: 'GET_RESULTS' }, dashboard)).results[0].home, 'FC Le Locle');
  const pending = await h.manager.external({ type: 'GET_RESULTS', teamId: '68914' }, dashboard);
  assert.equal(pending.resultsState, 'unavailable'); assert.equal(pending.refreshing, true);
  await captureTeam(h, '74009'); await captureTeam(h, '68914'); assert.equal(h.created.length, 2);
});

test('Sequential pending teams survive a worker restart; a user-used first tab is preserved without blocking the remaining teams', async () => {
  const h = harness(allTeams); await h.manager.startup();
  await h.manager.activated({ tabId: 10 });
  const restarted = h.make(); await restarted.initialize();
  await captureTeam(h, '34107', undefined, restarted);
  assert.equal(h.created.length, 2); assert.ok(h.tabs.has(10)); assert.equal(h.created[1].active, false);
  await captureTeam(h, '74009', undefined, restarted); await captureTeam(h, '68914', undefined, restarted);
  assert.deepEqual(h.removed, [11, 12]); assert.equal(h.session.dashboardFootballCaptureV1, undefined);
});

test('Navigation to another allowed team URL still protects the owned tab from closure and cannot submit the wrong team', async () => {
  const h = harness(allTeams); await h.manager.external({ type: 'GET_RESULTS', teamId: '74009' }, dashboard);
  const otherUrl = reader.getTeam('68914').sourceUrl;
  h.tabs.get(10).url = otherUrl; await h.manager.updated(10, { url: otherUrl }, h.tabs.get(10));
  assert.equal((await h.manager.source({ type: 'SOURCE_HELLO', teamId: '74009' }, h.sender())).capture, false);
  h.advance(CAPTURE_TIMEOUT_MS); await h.manager.alarm({ name: TIMEOUT_ALARM });
  assert.deepEqual(h.removed, []); assert.ok(h.tabs.has(10));
});
