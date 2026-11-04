import { SESSION_KEY, SOURCE_URL, CLEANUP_ALARM, CAPTURE_INTERVAL_MS, FORCE_INTERVAL_MS, CAPTURE_DEADLINE_MS,
  validateRequest, restoreState, publicState, copySnapshot, sameOwner } from './protocol.mjs';

export function createCaptureManager({ extensionId, storage, tabs, alarms, now = Date.now, ready = Promise.resolve() }) {
  let tail = Promise.resolve();
  const activated = new Set();
  const safeError = () => ({ ok: false, error: 'unavailable' });
  function enqueue(operation) {
    const result = tail.then(async () => {
      await ready;
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0) return safeError();
      return operation(at);
    });
    tail = result.catch(() => {});
    return result.catch(safeError);
  }
  const load = async at => restoreState((await storage.get(SESSION_KEY))?.[SESSION_KEY], at);
  const synchronizeAlarm = async state => {
    if (state.job) {
      if (!alarms?.create) throw new Error('Cleanup unavailable');
      await alarms.create(CLEANUP_ALARM, { when: state.job.deadlineAt });
    } else if (alarms?.clear) await alarms.clear(CLEANUP_ALARM);
  };
  const save = async state => { await storage.set({ [SESSION_KEY]: state }); await synchronizeAlarm(state); };
  function release(state) {
    state.job = null; state.captureState = 'attention'; state.reason = 'user_interaction';
  }
  function sameDocument(job, request) {
    return job?.bound && sameOwner(job, request.owner);
  }
  function retryCleanup(state) {
    state.job.phase = 'closing'; state.job.deadlineAt = now() + 30_000;
    state.captureState = 'attention'; state.reason ||= 'unavailable';
  }
  // Removal only uses the current stored ID returned by tabs.create. A tab
  // activated by its user is released, including activation during tabs.get.
  async function closeJob(state) {
    const job = state.job;
    if (!job) return;
    let tab;
    try { tab = await tabs.get(job.tabId); }
    catch { retryCleanup(state); return; }
    if (!tab || tab.id !== job.tabId || tab.active !== false || activated.has(job.tabId)) {
      release(state); return;
    }
    try { await tabs.remove(job.tabId); }
    catch { if (activated.has(job.tabId)) release(state); else retryCleanup(state); return; }
    state.job = null;
  }
  async function overdue(state, at) {
    if (!state.job || state.job.deadlineAt > at) return;
    if (state.job.phase === 'reading') { state.captureState = 'attention'; state.reason = 'timeout'; }
    else if (state.job.phase === 'captured') { state.captureState = 'idle'; state.reason = ''; }
    state.job.phase = 'closing';
    await closeJob(state);
  }
  async function begin(state, at, force, windowId) {
    if (state.job || state.lastAttemptAt !== null && at - state.lastAttemptAt < (force ? FORCE_INTERVAL_MS : CAPTURE_INTERVAL_MS)) return;
    state.lastAttemptAt = at; state.captureState = 'attention'; state.reason = 'unavailable';
    // Failed attempts are throttled too. Record this before opening a browser tab.
    await save(state);
    if (!tabs?.create || !tabs?.get || !tabs?.remove || !alarms?.create || !alarms?.clear) return;
    try {
      const created = await tabs.create({ url: SOURCE_URL, active: false, ...(windowId === undefined ? {} : { windowId }) });
      if (!Number.isSafeInteger(created?.id) || created.id < 0) return;
      state.job = { tabId: created.id, documentId: null, bound: false, deadlineAt: at + CAPTURE_DEADLINE_MS, phase: 'reading' };
      state.captureState = 'reading'; state.reason = '';
      await save(state);
      if (created.active !== false || activated.has(created.id)) release(state);
    } catch {
      state.captureState = 'attention'; state.reason = 'unavailable';
      if (state.job) { state.job.phase = 'closing'; await closeJob(state); }
    }
  }
  async function handle(message, sender) {
    return enqueue(async at => {
      const request = validateRequest(message, sender, { extensionId, now: at });
      if (!request.ok) return request;
      const state = await load(at);
      await overdue(state, at);
      if (request.type === 'MYABACUS_READ' || request.type === 'MYABACUS_CAPTURE') {
        await begin(state, at, request.type === 'MYABACUS_CAPTURE', request.windowId);
        await save(state); return publicState(state);
      }
      if (request.type === 'MYABACUS_STOP') {
        state.snapshot = null; state.captureState = 'idle'; state.reason = '';
        if (state.job) state.job.phase = 'closing';
        await save(state); return publicState(state);
      }
      const job = state.job;
      if (!job || job.tabId !== request.owner.tabId || job.phase === 'closing') {
        await save(state); return { ok: true, managed: false };
      }
      if (activated.has(job.tabId)) { release(state); await save(state); return { ok: true, managed: false }; }
      if (request.type === 'MYABACUS_HELLO') {
        if (job.phase !== 'reading' && !sameDocument(job, request)) return { ok: true, managed: false };
        job.documentId = request.owner.documentId; job.bound = true;
        await save(state); return { ok: true, managed: true };
      }
      if (request.type === 'MYABACUS_RELEASE') {
        if (job.bound && !sameDocument(job, request)) return { ok: false, error: 'source_mismatch' };
        release(state); await save(state); return { ok: true, managed: false };
      }
      if (!sameDocument(job, request)) return { ok: false, error: 'source_mismatch' };
      if (request.type === 'MYABACUS_CLEAR') {
        // A successful capture survives source navigation and pagehide.
        await save(state); return { ok: true, state: job.phase === 'captured' ? 'captured' : 'reading' };
      }
      if (request.type === 'MYABACUS_PUBLISH') {
        if (job.phase !== 'reading') return { ok: false, error: 'already_captured' };
        state.snapshot = { ...copySnapshot(request.snapshot), readAt: at, seenAt: at };
        job.phase = 'captured'; state.captureState = 'idle'; state.reason = '';
        await save(state); return { ok: true, state: 'captured' };
      }
      if (request.type === 'MYABACUS_DONE') {
        if (job.phase !== 'captured') return { ok: false, error: 'not_captured' };
        job.phase = 'closing'; await save(state); return { ok: true, state: 'captured' };
      }
      if (request.type === 'MYABACUS_FAILURE') {
        const account = request.reason === 'account';
        if (account) state.snapshot = null;
        state.captureState = 'attention'; state.reason = account ? 'account' : 'unavailable';
        job.phase = 'closing'; await save(state); return { ok: true, state: 'attention' };
      }
      return { ok: false, error: 'invalid_request' };
    });
  }
  const afterResponse = (message, sender) => enqueue(async at => {
    const request = validateRequest(message, sender, { extensionId, now: at });
    if (!request.ok || !['MYABACUS_DONE', 'MYABACUS_FAILURE', 'MYABACUS_STOP'].includes(request.type)) return { ok: false, error: 'invalid_request' };
    const state = await load(at);
    if (state.job?.phase === 'closing' && (request.type === 'MYABACUS_STOP' || sameDocument(state.job, request))) {
      await closeJob(state); await save(state);
    }
    return { ok: true };
  });
  const recover = () => enqueue(async at => {
    const state = await load(at);
    await overdue(state, at);
    if (state.job) {
      if (state.job.phase === 'closing') await closeJob(state);
      else {
        let tab;
        try { tab = await tabs.get(state.job.tabId); } catch { /* Removed while the worker slept. */ }
        if (!tab) retryCleanup(state);
        else if (tab.active !== false || activated.has(state.job.tabId)) release(state);
      }
    }
    await save(state); return publicState(state);
  });
  const handleAlarm = alarm => {
    if (alarm?.name !== CLEANUP_ALARM) return Promise.resolve({ ok: false, error: 'unknown_alarm' });
    return enqueue(async at => {
      const state = await load(at);
      await overdue(state, at);
      await save(state); return publicState(state);
    });
  };
  const handleActivated = info => {
    if (!Number.isSafeInteger(info?.tabId) || info.tabId < 0) return Promise.resolve({ ok: false, error: 'invalid_tab' });
    activated.add(info.tabId);
    if (activated.size > 128) activated.delete(activated.values().next().value);
    return enqueue(async at => {
      const state = await load(at);
      if (state.job?.tabId === info.tabId) { release(state); await save(state); }
      return { ok: true };
    });
  };
  const handleRemoved = tabId => enqueue(async at => {
    const state = await load(at);
    if (state.job?.tabId === tabId) {
      const completed = state.job.phase !== 'reading';
      state.job = null;
      if (!completed) { state.captureState = 'attention'; state.reason = 'unavailable'; }
      await save(state);
    }
    activated.delete(tabId);
    return { ok: true };
  });
  return { handle, afterResponse, recover, handleAlarm, handleActivated, handleRemoved, idle: () => tail };
}
