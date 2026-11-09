import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOOTBALL_EXTENSION_ID, requestFootballExtension, subscribeFootballExtension } from '../football-extension.mjs';

const packet = { installed: true, version: '1.0.0', resultsState: 'ready', results: [], resultsCheckedAt: '2026-11-09T12:00:00Z', resultsCheckFailed: false, refreshing: false };
test('Web bridge contacts only the fixed football extension and requests public results without sending page data', async () => {
  let call;
  const win = { chrome: { runtime: { sendMessage(id, message, callback) { call = { id, message }; callback(packet); } } } };
  assert.deepEqual(await requestFootballExtension({ window: win }), packet);
  assert.deepEqual(call, { id: FOOTBALL_EXTENSION_ID, message: { type: 'GET_RESULTS' } });
  assert.match(FOOTBALL_EXTENSION_ID, /^[a-p]{32}$/);
});
test('Absent extension APIs, runtime errors and malformed replies are handled as an unavailable bridge', async () => {
  assert.equal((await requestFootballExtension({ window: {} })).installed, false);
  for (const runtime of [
    { sendMessage() { throw new Error('not installed'); } },
    { lastError: { message: 'not installed' }, sendMessage(id, message, callback) { callback(packet); } },
    { sendMessage(id, message, callback) { callback({ ...packet, installed: false }); } },
    { sendMessage(id, message, callback) { callback({ ...packet, version: null }); } }
  ]) assert.equal((await requestFootballExtension({ window: { chrome: { runtime } } })).installed, false);
  const malformed = await requestFootballExtension({ window: { chrome: { runtime: { sendMessage(id, message, callback) { callback({ ...packet, results: Array(20).fill({}) }); } } } } });
  assert.equal(malformed.installed, true); assert.equal(malformed.resultsState, 'unavailable');
});
test('Local polling pauses on hidden pages and disposal ignores a late extension reply', async () => {
  let settings, reply, received = 0, stopped = false;
  const doc = { hidden: false }, win = { chrome: { runtime: { sendMessage(id, message, callback) { reply = callback; } } } };
  const bridge = subscribeFootballExtension(() => { received++; }, { document: doc, window: win,
    autoRefreshFactory: config => { settings = config; return { start() {}, dispose() { stopped = true; } }; } });
  assert.equal(settings.intervalMs, 15_000);
  bridge.dispose(); reply(packet); await new Promise(resolve => setImmediate(resolve));
  assert.equal(received, 0); assert.equal(stopped, true);
});
