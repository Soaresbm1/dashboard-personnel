export const PROTOCOL = 'dashboard-football-v1';
export const PERIOD_MS = 5 * 24 * 60 * 60_000;
export const CAPTURE_TIMEOUT_MS = 90_000;
export const REFRESH_COOLDOWN_MS = 30_000;
export const PERIODIC_ALARM = 'dashboard-football-refresh';
export const TIMEOUT_ALARM = 'dashboard-football-capture-timeout';
const LOCAL_KEY = 'dashboardFootballResultsV1';
const SESSION_KEY = 'dashboardFootballCaptureV1';

export function isDashboardSender(sender) {
  try {
    const url = new URL(sender?.url || '');
    return url.origin === 'https://soaresbm1.github.io' && !url.username && !url.password
      && ['/dashboard-personnel/', '/dashboard-personnel/index.html'].includes(url.pathname);
  } catch { return false; }
}

export function createCaptureManager(api, reader, options = {}) {
  const now = options.now || Date.now, randomId = options.randomId || (() => crypto.randomUUID());
  let state = { sample: null, attemptAt: 0, failed: true }, flight = null, queue = Promise.resolve();
  let loaded = false, creating = false, closing = null;
  const protectedActivations = new Set(), protectedNavigations = new Set();
  const serialize = callback => {
    const result = queue.then(callback, callback); queue = result.catch(() => {}); return result;
  };
  async function saveState() { await api.storage.local.set({ [LOCAL_KEY]: state }); }
  async function scheduleNextCheck() {
    await api.alarms.create(PERIODIC_ALARM, {
      when: state.attemptAt ? Math.max(now() + 1_000, state.attemptAt + PERIOD_MS) : now() + PERIOD_MS,
      periodInMinutes: PERIOD_MS / 60_000
    });
  }
  async function saveFlight() {
    if (flight) await api.storage.session.set({ [SESSION_KEY]: flight });
    else await api.storage.session.remove(SESSION_KEY);
  }
  async function load() {
    if (loaded) return;
    const saved = (await api.storage.local.get(LOCAL_KEY))[LOCAL_KEY];
    if (saved && Number.isFinite(saved.attemptAt) && saved.attemptAt <= now() + 60_000 && typeof saved.failed === 'boolean') {
      state.attemptAt = saved.attemptAt; state.failed = saved.failed;
      const at = Date.parse(saved.sample?.checkedAt || '');
      if (Number.isFinite(at) && at <= now() + 60_000 && now() - at <= 366 * 24 * 60 * 60_000) {
        try { state.sample = { checkedAt: new Date(at).toISOString(), results: reader.normalizeResults(saved.sample.results, now()) }; } catch { /* Bad local public cache is ignored. */ }
      }
    }
    const pending = (await api.storage.session.get(SESSION_KEY))[SESSION_KEY];
    if (pending && Number.isInteger(pending.tabId) && typeof pending.requestId === 'string' && pending.requestId.length <= 100
        && Number.isFinite(pending.createdAt) && pending.createdAt <= now() + 60_000 && Number.isFinite(pending.deadlineAt)
        && pending.deadlineAt === pending.createdAt + CAPTURE_TIMEOUT_MS
        && typeof pending.activated === 'boolean' && typeof pending.navigated === 'boolean') flight = pending;
    if (flight) await api.alarms.create(TIMEOUT_ALARM, { when: Math.max(now() + 1_000, flight.deadlineAt) });
    // Event callbacks can arrive while storage is being recovered. Keep their
    // immediate protections until the pending capture's tab ID is known.
    for (const id of protectedActivations) if (id !== flight?.tabId) protectedActivations.delete(id);
    if (flight && protectedActivations.has(flight.tabId)) { flight.activated = true; await saveFlight(); }
    loaded = true;
  }
  function view() {
    const sample = state.sample;
    return { installed: true, protocol: PROTOCOL, version: api.runtime.getManifest().version,
      resultsState: sample ? 'ready' : 'unavailable', results: sample ? sample.results.map(row => ({ ...row })) : [],
      resultsCheckedAt: sample?.checkedAt || null,
      resultsCheckFailed: !sample || state.failed || now() - Date.parse(sample.checkedAt) > PERIOD_MS + CAPTURE_TIMEOUT_MS,
      refreshing: !!flight };
  }
  async function closeOwned(capture) {
    if (!capture || capture.activated || capture.navigated) return;
    closing = capture;
    try {
      const tab = await api.tabs.get(capture.tabId);
      if (!tab.active && !protectedActivations.has(capture.tabId) && !protectedNavigations.has(capture.tabId) && reader.isSourceUrl(tab.url)) await api.tabs.remove(capture.tabId);
    } catch { /* Missing, navigated or unavailable tab: never search for another tab. */ }
    finally { closing = null; protectedActivations.delete(capture.tabId); protectedNavigations.delete(capture.tabId); }
  }
  async function finishFailed() {
    const capture = flight; flight = null;
    state.failed = true;
    await saveState(); await saveFlight(); await api.alarms.clear(TIMEOUT_ALARM);
    await closeOwned(capture);
  }
  async function expire() {
    if (flight && now() >= flight.deadlineAt) await finishFailed();
  }
  async function launch(manual = false) {
    await expire();
    if (flight || now() - state.attemptAt < (manual ? REFRESH_COOLDOWN_MS : PERIOD_MS)) return;
    state.attemptAt = now(); await saveState();
    await scheduleNextCheck();
    try {
      creating = true;
      const tab = await api.tabs.create({ url: reader.SOURCE_URL, active: false });
      if (!Number.isInteger(tab.id)) throw new Error('missing_capture_tab');
      flight = { tabId: tab.id, requestId: randomId(), createdAt: state.attemptAt, deadlineAt: state.attemptAt + CAPTURE_TIMEOUT_MS,
        activated: tab.active === true || protectedActivations.has(tab.id), navigated: false, reachedSource: reader.isSourceUrl(tab.url) };
      await saveFlight();
      await api.alarms.create(TIMEOUT_ALARM, { when: flight.deadlineAt });
    } catch { state.failed = true; await saveState(); }
    finally { creating = false; }
  }
  async function authorizeSource(sender, message) {
    if (!flight || sender?.id !== api.runtime.id || sender.frameId !== 0 || sender.tab?.id !== flight.tabId || !reader.isSourceUrl(sender.url) || !reader.isSourceUrl(sender.tab?.url)) return false;
    if (message?.type !== 'SOURCE_HELLO' && message?.requestId !== flight.requestId) return false;
    return true;
  }
  async function initialize() {
    return serialize(async () => {
      await load(); await expire();
      const alarm = await api.alarms.get(PERIODIC_ALARM);
      if (alarm?.periodInMinutes !== PERIOD_MS / 60_000) await scheduleNextCheck();
    });
  }
  return {
    initialize,
    async external(message, sender) {
      if (!isDashboardSender(sender) || !message || !['GET_RESULTS', 'REFRESH_RESULTS'].includes(message.type)
          || message.protocol !== undefined && message.protocol !== PROTOCOL) return { error: 'sender_or_command_not_allowed' };
      return serialize(async () => { await load(); await launch(message.type === 'REFRESH_RESULTS'); return view(); });
    },
    async popup(message, sender) {
      if (sender?.id !== api.runtime.id || sender?.url !== api.runtime.getURL('popup.html') || !['GET_RESULTS', 'REFRESH_RESULTS'].includes(message?.type)) return { error: 'sender_or_command_not_allowed' };
      return serialize(async () => { await load(); await launch(message.type === 'REFRESH_RESULTS'); return view(); });
    },
    async source(message, sender) {
      return serialize(async () => {
        await load(); await expire();
        if (!await authorizeSource(sender, message)) return { capture: false };
        if (message.type === 'SOURCE_HELLO') return { capture: true, requestId: flight.requestId, deadlineAt: flight.deadlineAt };
        if (message.type === 'SOURCE_FAILED') { await finishFailed(); return { accepted: true }; }
        if (message.type !== 'SOURCE_RESULTS') return { accepted: false };
        let results;
        try { results = reader.normalizeResults(message.results, now()); }
        catch { await finishFailed(); return { accepted: false }; }
        state.sample = { checkedAt: new Date(now()).toISOString(), results };
        state.failed = false;
        const capture = flight; flight = null;
        await saveState(); await saveFlight(); await api.alarms.clear(TIMEOUT_ALARM);
        await closeOwned(capture);
        return { accepted: true };
      });
    },
    async alarm(alarm) {
      if (![PERIODIC_ALARM, TIMEOUT_ALARM].includes(alarm?.name)) return;
      return serialize(async () => { await load(); if (alarm.name === TIMEOUT_ALARM) await expire(); else await launch(false); });
    },
    async startup() { return serialize(async () => { await load(); await launch(false); }); },
    async activated(info) {
      if (!loaded || creating || flight?.tabId === info?.tabId || closing?.tabId === info?.tabId) protectedActivations.add(info.tabId);
      return serialize(async () => { await load(); if (flight?.tabId === info?.tabId) { flight.activated = true; await saveFlight(); } });
    },
    async updated(tabId, changes, tab) {
      const tracked = flight?.tabId === tabId ? flight : closing?.tabId === tabId ? closing : null;
      if (tracked && (changes?.url !== undefined && !reader.isSourceUrl(changes.url) && (changes.url !== 'about:blank' || tracked.reachedSource)
          || changes?.status === 'loading' && tracked.reachedSource && !reader.isSourceUrl(tab?.url))) protectedNavigations.add(tabId);
      return serialize(async () => {
        await load(); if (flight?.tabId !== tabId) return;
        if (tab?.active) flight.activated = true;
        if (changes?.url !== undefined) {
          if (reader.isSourceUrl(changes.url)) flight.reachedSource = true;
          else if (changes.url !== 'about:blank' || flight.reachedSource) flight.navigated = true;
        } else if (changes?.status === 'loading') {
          try { const current = await api.tabs.get(tabId); if (!reader.isSourceUrl(current.url) && (current.url !== 'about:blank' || flight.reachedSource)) flight.navigated = true; }
          catch { flight.navigated = true; }
        }
        await saveFlight();
      });
    },
    async removed(tabId) { return serialize(async () => { await load(); if (flight?.tabId === tabId) await finishFailed(); }); }
  };
}
