import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkIntranet, TARGET, APPLICATION_TARGET } from '../scripts/check-intranet.mjs';
import { HEALTH_MAX_AGE_MS, INTRANET_HEALTH_URL, INTRANET_HEALTH_CACHE_KEY, parseIntranetHealth, intranetHealthView } from '../intranet-health-core.mjs';
import { initializeIntranetHealth } from '../intranet-health.mjs';
const now = Date.parse('2026-11-05T18:00:00Z');
const sample = (extra = {}) => ({ schemaVersion: 1, target: TARGET, checkedAt: new Date(now).toISOString(), outcome: 'online', httpStatus: 200, error: null, latencyMs: 25, ...extra });

test('Probe follows only same-origin HTTPS redirects and records the final real HTTP error', async () => {
  for (const status of [200, 404, 500, 502, 503, 504, 401, 403, 429]) {
    const urls = [];
    const result = await checkIntranet({ now: () => now, request: async url => { urls.push(url); return urls.length === 1 ? { status: 302, location: '/login' } : { status }; } });
    assert.deepEqual(urls, [TARGET, 'https://intranet.isp-spi.ch/login']);
    const parsed = parseIntranetHealth(result, now), view = intranetHealthView(parsed, now);
    assert.equal(parsed.httpStatus, status); assert.match(view.description, new RegExp(`HTTP ${status}`));
    assert.equal(view.state, status === 200 ? 'online' : 'error');
  }
  for (const location of ['https://login.microsoftonline.com/authorize?state=private', 'http://intranet.isp-spi.ch/login', 'https://user:secret@intranet.isp-spi.ch/login']) {
    let calls = 0; const result = await checkIntranet({ now: () => now, request: async () => { calls++; return { status: 302, location }; } });
    assert.equal(calls, 1); assert.equal(result.outcome, 'redirect'); assert.equal(JSON.stringify(result).includes('secret'), false); assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('Timeout, DNS, TLS, network failure and redirect loops never become an HTTP zero or healthy state', async () => {
  for (const [code, kind] of [['ETIMEDOUT', 'timeout'], ['ENOTFOUND', 'dns'], ['CERT_HAS_EXPIRED', 'tls'], ['ECONNREFUSED', 'network']]) {
    const result = await checkIntranet({ now: () => now, request: async () => { throw Object.assign(new Error('private detail'), { code }); } });
    assert.equal(result.httpStatus, null); assert.equal(result.error, kind); assert.equal(intranetHealthView(parseIntranetHealth(result, now), now).state, 'error');
    assert.equal(JSON.stringify(result).includes('private detail'), false);
  }
  let calls = 0; const loop = await checkIntranet({ now: () => now, request: async () => { calls++; return { status: 302, location: '/login' }; } });
  assert.equal(calls, 6); assert.equal(loop.error, 'redirect_loop');
});

test('Expected Microsoft SSO redirects use application health without visiting Microsoft or retaining OAuth parameters', async () => {
  for (const status of [200, 404, 503]) {
    const urls = [];
    const result = await checkIntranet({ now: () => now, request: async url => { urls.push(url); return url === TARGET
      ? { status: 302, location: 'https://login.microsoftonline.com/fixture/oauth2/v2.0/authorize?state=private' } : { status }; } });
    assert.deepEqual(urls, [TARGET, APPLICATION_TARGET]); assert.equal(result.entryHttpStatus, 302); assert.equal(result.applicationHttpStatus, status);
    const parsed = parseIntranetHealth(result, now);
    assert.equal(intranetHealthView(parsed, now).state, status === 200 ? 'online' : 'error'); assert.equal(parsed.httpStatus, status);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('Old, unavailable and offline checks retain the last green or red result and mark it as retained', () => {
  for (const [extra, state] of [[{}, 'online'], [{ outcome: 'http_error', httpStatus: 503 }, 'error']]) {
    const last = parseIntranetHealth(sample(extra), now);
    for (const view of [intranetHealthView(last, now + HEALTH_MAX_AGE_MS + 1), intranetHealthView(last, now, { feedUnavailable: true }), intranetHealthView(last, now, { offline: true })]) {
      assert.equal(view.state, state); assert.equal(view.retained, true); assert.match(view.description, state === 'online' ? /HTTP 200/ : /HTTP 503/);
    }
  }
  assert.equal(intranetHealthView(null, now).state, 'unknown');
  for (const extra of [{ httpStatus: 503 }, { checkedAt: new Date(now + 180_000).toISOString() }, { target: 'https://example.test' }, { httpStatus: 0 }, { outcome: 'http_error' }]) assert.throws(() => parseIntranetHealth(sample(extra), now));
});

test('Frontend uses only the anonymous fixed feed, refreshes every minute, and replaces green with HTTP 503', async () => {
  const nodes = new Map(['intranet-health', 'intranet-health-label', 'intranet-health-time'].map(id => [`#${id}`, { dataset: {}, textContent: '', setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; } }]));
  const events = new Map(), timers = new Map(), requests = [];
  let currentNow = now, mode = 'online', config, stopped = false, resolveLate, timerId = 0;
  const win = { navigator: { onLine: true }, addEventListener: (k, fn) => events.set(k, fn), removeEventListener: k => events.delete(k) };
  const doc = { hidden: false, querySelector: k => nodes.get(k), addEventListener() {}, removeEventListener() {} };
  const service = initializeIntranetHealth({ document: doc, window: win, now: () => currentNow,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    autoRefreshFactory(value) { config = value; return { start() {}, dispose() { stopped = true; } }; },
    fetch: async (url, options) => { requests.push([url, options]); if (mode === 'late') return new Promise(resolve => { resolveLate = resolve; }); if (mode === 'failed') throw new Error('offline feed'); return new Response(JSON.stringify(sample(mode === '503' ? { outcome: 'http_error', httpStatus: 503 } : {}))); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('#intranet-health').dataset.state, 'online'); assert.equal(config.intervalMs, 60_000);
  assert.equal(requests[0][0].split('?')[0], INTRANET_HEALTH_URL); assert.equal(requests[0][1].credentials, 'omit'); assert.equal(requests[0][1].headers, undefined);
  mode = '503'; await service.refresh(); assert.match(nodes.get('#intranet-health-label').textContent, /HTTP 503/); assert.equal(nodes.get('#intranet-health').dataset.state, 'error');
  mode = 'online'; await service.refresh(); currentNow += HEALTH_MAX_AGE_MS + 1; [...timers.values()].at(-1).fn(); assert.equal(nodes.get('#intranet-health').dataset.state, 'online'); assert.match(nodes.get('#intranet-health').title, /relevé ancien/);
  currentNow = now; mode = 'failed'; await service.refresh(); assert.equal(nodes.get('#intranet-health').dataset.state, 'online'); assert.match(nodes.get('#intranet-health').title, /actualisation indisponible/);
  win.navigator.onLine = false; events.get('offline')(); assert.equal(nodes.get('#intranet-health').dataset.state, 'online'); assert.match(nodes.get('#intranet-health').title, /hors ligne/);
  win.navigator.onLine = true; mode = 'late'; const pending = service.refresh(); service.dispose(); resolveLate(new Response(JSON.stringify(sample()))); await pending;
  assert.equal(stopped, true); assert.equal(nodes.get('#intranet-health').dataset.state, 'online');
});

test('The latest known status survives reload, failed reads and older feed responses until a newer observation replaces it', async () => {
  const old = now - 86_400_000;
  const values = new Map([[INTRANET_HEALTH_CACHE_KEY, JSON.stringify(sample({ outcome: 'http_error', httpStatus: 503, checkedAt: new Date(old).toISOString() }))]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  let response = sample({ checkedAt: new Date(old - 1000).toISOString() }), offline = false;
  function start() {
    const nodes = new Map(['intranet-health', 'intranet-health-label', 'intranet-health-time'].map(id => [`#${id}`, { dataset: {}, setAttribute() {}, removeAttribute() {} }]));
    const win = { navigator: { onLine: !offline }, localStorage: storage };
    const instance = initializeIntranetHealth({ document: { hidden: false, querySelector: key => nodes.get(key) }, window: win, now: () => now,
      setTimeout: () => 1, clearTimeout() {}, autoRefreshFactory: () => ({ start() {}, dispose() {} }),
      fetch: async () => { if (response === null) throw new Error('feed unavailable'); return new Response(JSON.stringify(response)); } });
    return { instance, nodes };
  }
  const first = start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.nodes.get('#intranet-health-label').textContent, 'HTTP 503');
  assert.equal(first.nodes.get('#intranet-health').dataset.retained, 'true');
  assert.equal(JSON.parse(values.get(INTRANET_HEALTH_CACHE_KEY)).httpStatus, 503);
  response = null; await first.instance.refresh(); assert.equal(first.nodes.get('#intranet-health').dataset.state, 'error'); first.instance.dispose();
  offline = true; const reloaded = start(); assert.equal(reloaded.nodes.get('#intranet-health-label').textContent, 'HTTP 503'); reloaded.instance.dispose();
  offline = false; response = sample(); const recovered = start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(recovered.nodes.get('#intranet-health').dataset.state, 'online'); assert.equal(JSON.parse(values.get(INTRANET_HEALTH_CACHE_KEY)).httpStatus, 200); recovered.instance.dispose();
});
