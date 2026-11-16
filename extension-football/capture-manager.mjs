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
  const teamIds = options.teamIds || reader.TEAMS.map(team => team.id);
  if (!teamIds.length || teamIds.some(id => !reader.getTeam(id)) || new Set(teamIds).size !== teamIds.length) throw new Error('invalid_team_configuration');
  const state = Object.fromEntries(teamIds.map(id => [id, { sample: null, attemptAt: 0, failed: true }]));
  let flight = null, pending = [], queue = Promise.resolve(), loaded = false, creating = false, closing = null;
  const protectedActivations = new Set(), protectedNavigations = new Set();
  const serialize = callback => { const result = queue.then(callback, callback); queue = result.catch(() => {}); return result; };
  const supported = id => typeof id === 'string' && Object.hasOwn(state, id);
  const sourceFor = (url, id) => reader.isSourceUrl(url, id);
  const due = (id, manual = false) => now() - state[id].attemptAt >= (manual ? REFRESH_COOLDOWN_MS : PERIOD_MS);
  async function saveState() { await api.storage.local.set({ [LOCAL_KEY]: { teams: state } }); }
  async function saveFlight() {
    if (flight || pending.length) await api.storage.session.set({ [SESSION_KEY]: { ...flight, pendingQueue: pending } });
    else await api.storage.session.remove(SESSION_KEY);
  }
  async function scheduleNextCheck() {
    const attempts = teamIds.filter(id => state[id].attemptAt > 0).map(id => state[id].attemptAt + PERIOD_MS);
    await api.alarms.create(PERIODIC_ALARM, { when: Math.max(now() + 1_000, attempts.length ? Math.min(...attempts) : now() + PERIOD_MS), periodInMinutes: PERIOD_MS / 60_000 });
  }
  function recoverSample(saved, id) {
    if (!saved || !Number.isFinite(saved.attemptAt) || saved.attemptAt > now() + 60_000 || typeof saved.failed !== 'boolean') return;
    state[id].attemptAt = saved.attemptAt; state[id].failed = saved.failed;
    const at = Date.parse(saved.sample?.checkedAt || '');
    if (Number.isFinite(at) && at <= now() + 60_000 && now() - at <= 366 * 24 * 60 * 60_000) {
      try { state[id].sample = { checkedAt: new Date(at).toISOString(), results: reader.normalizeResults(saved.sample.results, now(), id) }; } catch { /* Invalid public cache is ignored per team. */ }
    }
  }
  async function load() {
    if (loaded) return;
    const saved = (await api.storage.local.get(LOCAL_KEY))[LOCAL_KEY];
    for (const id of teamIds) recoverSample(saved?.teams?.[id] || (id === '34107' ? saved : null), id);
    const recovered = (await api.storage.session.get(SESSION_KEY))[SESSION_KEY];
    if (Array.isArray(recovered?.pendingQueue)) {
      const seen = new Set();
      pending = recovered.pendingQueue.filter(item => supported(item?.teamId) && typeof item.manual === 'boolean' && !seen.has(item.teamId) && seen.add(item.teamId)).slice(0, teamIds.length);
    }
    const id = recovered?.teamId || '34107';
    if (supported(id) && Number.isInteger(recovered?.tabId) && typeof recovered.requestId === 'string' && recovered.requestId.length <= 100
        && Number.isFinite(recovered.createdAt) && recovered.createdAt <= now() + 60_000 && Number.isFinite(recovered.deadlineAt)
        && recovered.deadlineAt === recovered.createdAt + CAPTURE_TIMEOUT_MS && typeof recovered.activated === 'boolean' && typeof recovered.navigated === 'boolean') {
      flight = { ...recovered, teamId: id }; delete flight.pendingQueue;
      pending = pending.filter(item => item.teamId !== id);
      await api.alarms.create(TIMEOUT_ALARM, { when: Math.max(now() + 1_000, flight.deadlineAt) });
    }
    for (const tabId of protectedActivations) if (tabId !== flight?.tabId) protectedActivations.delete(tabId);
    if (flight && protectedActivations.has(flight.tabId)) { flight.activated = true; await saveFlight(); }
    loaded = true;
  }
  function view(id) {
    const current = state[id], sample = current.sample;
    return { installed: true, protocol: PROTOCOL, version: api.runtime.getManifest().version, teamId: id,
      resultsState: sample ? 'ready' : 'unavailable', results: sample ? sample.results.map(row => ({ ...row })) : [], resultsCheckedAt: sample?.checkedAt || null,
      resultsCheckFailed: !sample || current.failed || now() - Date.parse(sample.checkedAt) > PERIOD_MS + CAPTURE_TIMEOUT_MS,
      refreshing: flight?.teamId === id || pending.some(item => item.teamId === id) };
  }
  async function closeOwned(capture) {
    if (!capture || capture.activated || capture.navigated) return;
    closing = capture;
    try {
      const tab = await api.tabs.get(capture.tabId);
      if (!tab.active && !protectedActivations.has(capture.tabId) && !protectedNavigations.has(capture.tabId) && sourceFor(tab.url, capture.teamId)) await api.tabs.remove(capture.tabId);
    } catch { /* Never search for or close a different tab. */ }
    finally { closing = null; protectedActivations.delete(capture.tabId); protectedNavigations.delete(capture.tabId); }
  }
  async function finishFailed() {
    const capture = flight; flight = null;
    if (!capture) return;
    state[capture.teamId].failed = true;
    await saveState(); await saveFlight(); await api.alarms.clear(TIMEOUT_ALARM); await closeOwned(capture);
  }
  async function expire() { if (flight && now() >= flight.deadlineAt) await finishFailed(); }
  function enqueue(id, manual) {
    if (flight?.teamId === id || !due(id, manual)) return;
    const existing = pending.find(item => item.teamId === id);
    if (existing) existing.manual ||= manual;
    else pending.push({ teamId: id, manual });
  }
  async function drain() {
    while (!flight && pending.length) {
      const { teamId: id, manual } = pending.shift();
      if (!due(id, manual)) continue;
      state[id].attemptAt = now(); await saveState(); await saveFlight(); await scheduleNextCheck();
      try {
        creating = true;
        const tab = await api.tabs.create({ url: reader.getTeam(id).sourceUrl, active: false });
        if (!Number.isInteger(tab.id)) throw new Error('missing_capture_tab');
        flight = { teamId: id, tabId: tab.id, requestId: randomId(), createdAt: state[id].attemptAt,
          deadlineAt: state[id].attemptAt + CAPTURE_TIMEOUT_MS, activated: tab.active === true || protectedActivations.has(tab.id), navigated: false, reachedSource: sourceFor(tab.url, id) };
        await saveFlight(); await api.alarms.create(TIMEOUT_ALARM, { when: flight.deadlineAt });
      } catch { state[id].failed = true; await saveState(); }
      finally { creating = false; }
    }
    await saveFlight();
  }
  async function request(id, manual) { await expire(); enqueue(id, manual); await drain(); }
  function authorizeSource(sender, message) {
    return !!flight && sender?.id === api.runtime.id && sender.frameId === 0 && sender.tab?.id === flight.tabId
      && sourceFor(sender.url, flight.teamId) && sourceFor(sender.tab?.url, flight.teamId)
      && (message.teamId === flight.teamId || message.teamId === undefined && flight.teamId === '34107')
      && (message.type === 'SOURCE_HELLO' || message.requestId === flight.requestId);
  }
  async function initialize() {
    return serialize(async () => { await load(); await expire(); const alarm = await api.alarms.get(PERIODIC_ALARM);
      if (alarm?.periodInMinutes !== PERIOD_MS / 60_000) await scheduleNextCheck(); await drain(); });
  }
  function requestTeam(message) { const id = message?.teamId === undefined ? '34107' : message.teamId; return supported(id) ? id : null; }
  return {
    initialize,
    async external(message, sender) {
      const id = requestTeam(message);
      if (!isDashboardSender(sender) || !message || !id || !['GET_RESULTS', 'REFRESH_RESULTS'].includes(message.type)
          || message.protocol !== undefined && message.protocol !== PROTOCOL) return { error: 'sender_or_command_not_allowed' };
      return serialize(async () => { await load(); await request(id, message.type === 'REFRESH_RESULTS'); return view(id); });
    },
    async popup(message, sender) {
      const id = requestTeam(message);
      if (!id || sender?.id !== api.runtime.id || sender?.url !== api.runtime.getURL('popup.html') || !['GET_RESULTS', 'REFRESH_RESULTS'].includes(message?.type)) return { error: 'sender_or_command_not_allowed' };
      return serialize(async () => { await load(); await request(id, message.type === 'REFRESH_RESULTS'); return view(id); });
    },
    async source(message, sender) {
      return serialize(async () => {
        await load(); await expire();
        if (!authorizeSource(sender, message)) { await drain(); return { capture: false }; }
        if (message.type === 'SOURCE_HELLO') return { capture: true, teamId: flight.teamId, requestId: flight.requestId, deadlineAt: flight.deadlineAt };
        if (message.type === 'SOURCE_FAILED') { await finishFailed(); await drain(); return { accepted: true }; }
        if (message.type !== 'SOURCE_RESULTS') return { accepted: false };
        let results;
        try { results = reader.normalizeResults(message.results, now(), flight.teamId); }
        catch { await finishFailed(); await drain(); return { accepted: false }; }
        state[flight.teamId].sample = { checkedAt: new Date(now()).toISOString(), results }; state[flight.teamId].failed = false;
        const capture = flight; flight = null;
        await saveState(); await saveFlight(); await api.alarms.clear(TIMEOUT_ALARM); await closeOwned(capture); await drain();
        return { accepted: true };
      });
    },
    async alarm(alarm) {
      if (![PERIODIC_ALARM, TIMEOUT_ALARM].includes(alarm?.name)) return;
      return serialize(async () => { await load(); await expire(); if (alarm.name === PERIODIC_ALARM) teamIds.forEach(id => enqueue(id, false)); await drain(); await scheduleNextCheck(); });
    },
    async startup() { return serialize(async () => { await load(); await expire(); teamIds.forEach(id => enqueue(id, false)); await drain(); }); },
    async activated(info) {
      if (!loaded || creating || flight?.tabId === info?.tabId || closing?.tabId === info?.tabId) protectedActivations.add(info.tabId);
      return serialize(async () => { await load(); if (flight?.tabId === info?.tabId) { flight.activated = true; await saveFlight(); } });
    },
    async updated(tabId, changes, tab) {
      const tracked = flight?.tabId === tabId ? flight : closing?.tabId === tabId ? closing : null;
      if (tracked && (changes?.url !== undefined && !sourceFor(changes.url, tracked.teamId) && (changes.url !== 'about:blank' || tracked.reachedSource)
          || changes?.status === 'loading' && tracked.reachedSource && !sourceFor(tab?.url, tracked.teamId))) protectedNavigations.add(tabId);
      return serialize(async () => {
        await load(); if (flight?.tabId !== tabId) return;
        if (tab?.active) flight.activated = true;
        if (changes?.url !== undefined) {
          if (sourceFor(changes.url, flight.teamId)) flight.reachedSource = true;
          else if (changes.url !== 'about:blank' || flight.reachedSource) flight.navigated = true;
        } else if (changes?.status === 'loading') {
          try { const current = await api.tabs.get(tabId); if (!sourceFor(current.url, flight.teamId) && (current.url !== 'about:blank' || flight.reachedSource)) flight.navigated = true; }
          catch { flight.navigated = true; }
        }
        await saveFlight();
      });
    },
    async removed(tabId) { return serialize(async () => { await load(); if (flight?.tabId === tabId) { await finishFailed(); await drain(); } }); }
  };
}

