import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkIntranet, TARGET } from '../scripts/check-intranet.mjs';
import { HEALTH_MAX_AGE_MS, INTRANET_HEALTH_URL, parseIntranetHealth, intranetHealthView } from '../intranet-health-core.mjs';
import { initializeIntranetHealth } from '../intranet-health.mjs';
const now = Date.parse('2026-11-05T18:00:00Z');
const sample = (extra = {}) => ({ schemaVersion: 1, target: TARGET, checkedAt: new Date(now).toISOString(), outcome: 'online', httpStatus: 200, error: null, latencyMs: 25, ...extra });

test('Probe follows only same-origin HTTPS redirects and records the final real HTTP error', async () => {
  for (const status of [200, 404, 500, 502, 503, 504, 401, 403, 429]) {
    const urls = [];
    const result = await checkIntranet({ now: () => now, request: async url => { urls.push(url); return urls.length === 1 ? { status: 302, location: '/login' } : { status }; } });
    assert.deepEqual(urls, [TARGET, 'https://intranet.isp-spi.ch/login']);
    const parsed = parseIntranetHealth(result, now), view = intranetHealthView(parsed, now);
    assert.equal(parsed.httpStatus, status); assert.match(view.label, new RegExp(`HTTP ${status}`));
    assert.equal(view.state, status === 200 ? 'online' : [401, 403, 429].includes(status) ? 'warning' : 'error');
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

test('Old, unavailable and offline checks cannot display a current green indicator', () => {
  const good = parseIntranetHealth(sample(), now);
  assert.equal(intranetHealthView(good, now + HEALTH_MAX_AGE_MS + 1).state, 'unknown');
  assert.equal(intranetHealthView(good, now, { feedUnavailable: true }).state, 'unknown');
  assert.equal(intranetHealthView(good, now, { offline: true }).state, 'unknown');
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
  mode = 'online'; await service.refresh(); currentNow += HEALTH_MAX_AGE_MS + 1; [...timers.values()].at(-1).fn(); assert.equal(nodes.get('#intranet-health').dataset.state, 'unknown');
  currentNow = now; mode = 'failed'; await service.refresh(); assert.equal(nodes.get('#intranet-health').dataset.state, 'unknown');
  win.navigator.onLine = false; events.get('offline')(); assert.match(nodes.get('#intranet-health-label').textContent, /hors ligne/);
  win.navigator.onLine = true; mode = 'late'; const pending = service.refresh(); service.dispose(); resolveLate(new Response(JSON.stringify(sample()))); await pending;
  assert.equal(stopped, true); assert.equal(nodes.get('#intranet-health').dataset.state, 'unknown');
});
