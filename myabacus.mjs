import {
  MICROSOFT_DEPLOYMENT, getMicrosoftClient, getRememberedMicrosoftAccount,
  isDashboardMicrosoftAccount, subscribeMicrosoftSignIn, subscribeMicrosoftSignOut
} from './microsoft-session.mjs';
import {
  MYABACUS_CHANNEL, MYABACUS_READ_STALE_MS, normalizeMyAbacusResult,
  myAbacusExpiry, formatMyAbacusHours, formatMyAbacusDays
} from './myabacus-core.mjs';

export function initializeMyAbacus(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const get = id => doc.getElementById(id);
  const block = get('summary-myabacus'), hours = get('myabacus-hours'), vacation = get('myabacus-vacation');
  const status = get('myabacus-status'), detail = get('myabacus-detail'), lastRead = get('myabacus-last-read');
  const open = get('myabacus-open'), dialog = get('myabacus-setup'), close = get('myabacus-close');
  const refreshButton = get('myabacus-refresh');
  if (!block || !hours || !vacation || !status) return null;
  const config = MICROSOFT_DEPLOYMENT, now = options.now || Date.now;
  const clientFor = options.getMicrosoftClient || getMicrosoftClient;
  const remembered = options.getRememberedMicrosoftAccount || getRememberedMicrosoftAccount;
  const ownerAccount = options.isDashboardMicrosoftAccount || isDashboardMicrosoftAccount;
  const subscribeIn = options.subscribeMicrosoftSignIn || subscribeMicrosoftSignIn;
  const subscribeOut = options.subscribeMicrosoftSignOut || subscribeMicrosoftSignOut;
  const loadSdk = options.loadSdk || (() => import('./vendor/msal.js'));
  const redirectUri = new URL('auth-redirect.html', doc.baseURI).href;
  const origin = win.location.origin;
  const clock = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' });
  let storage = null;
  // Only the existing Microsoft preference is read. Balances never enter web storage.
  try { storage = Object.hasOwn(options, 'storage') ? options.storage : win.localStorage; } catch { /* Session remains unavailable. */ }
  let application = null, disposed = false, signOutPending = false, generation = 0;
  let pending = null, pollTimer = null, expiryTimer = null, staleTimer = null, displayed = null;
  let viewCaptureState = 'idle', stoppedForSignOut = false, ownerSessionActive = false;
  const clearTimer = timer => { if (timer !== null) win.clearTimeout(timer); };
  function clearDisplayTimers() { clearTimer(expiryTimer); clearTimer(staleTimer); expiryTimer = staleTimer = null; }
  function stopPolling() { if (pollTimer !== null) win.clearInterval(pollTimer); pollTimer = null; }
  function invalidate() { generation++; pending?.cancel(); pending = null; }
  // This is a local display/privacy gate. The extension grants no new Microsoft scope.
  function hasOwner() {
    if (!application || disposed || signOutPending) return false;
    try {
      const account = remembered({ application, config, storage });
      return !!account && ownerAccount(account, config);
    } catch { return false; }
  }
  function updateControls() {
    block.setAttribute('aria-busy', String(!!pending || viewCaptureState === 'reading'));
    if (refreshButton) refreshButton.disabled = !hasOwner() || !!pending;
  }
  const requestId = () => options.randomUUID ? options.randomUUID() : win.crypto.randomUUID();
  function stopCapture() {
    if (stoppedForSignOut) return;
    stoppedForSignOut = true; ownerSessionActive = false;
    // STOP has no reply listener and is never emitted during a page reload.
    try { win.postMessage({ channel: MYABACUS_CHANNEL, type: 'STOP', requestId: requestId() }, origin); }
    catch { /* Local values are cleared even if the extension is unavailable. */ }
  }
  function empty(state, message, captureState = 'idle') {
    clearDisplayTimers(); displayed = null;
    viewCaptureState = captureState;
    hours.textContent = vacation.textContent = '—';
    if (detail) { detail.textContent = message; detail.hidden = false; }
    if (lastRead) { lastRead.textContent = ''; lastRead.title = ''; lastRead.removeAttribute?.('datetime'); }
    block.dataset.state = state; status.textContent = message; updateControls();
  }
  function renderEmpty(result) {
    if (result?.mode !== 'capture') { empty('empty', 'Ouvrir MyAbacus'); return; }
    if (result.captureState === 'reading') { empty('loading', 'Lecture de MyAbacus…', 'reading'); return; }
    if (result.captureState === 'attention') { empty('empty', 'Connexion MyAbacus à vérifier', 'attention'); return; }
    empty('empty', 'MyAbacus à actualiser');
  }
  function renderSnapshot(result) {
    clearDisplayTimers(); displayed = result.snapshot;
    viewCaptureState = result.mode === 'capture' ? result.captureState : 'idle';
    const snapshot = displayed;
    hours.textContent = formatMyAbacusHours(snapshot.timeBalanceHours);
    vacation.textContent = formatMyAbacusDays(snapshot.vacationRemainingDays);
    if (detail) {
      detail.hidden = snapshot.vacationAvailableDays === null;
      detail.textContent = detail.hidden ? '' : `Après congés planifiés : ${formatMyAbacusDays(snapshot.vacationAvailableDays)}`;
    }
    if (lastRead) {
      const [year, month, day] = snapshot.sourceDate.split('-');
      const reading = result.mode === 'capture' ? 'toutes les 10 min' : `données du ${day}.${month}`;
      lastRead.textContent = `Lu à ${clock.format(new Date(snapshot.readAt))} · ${reading}${result.state === 'stale' ? ' · lecture ancienne' : ''}`;
      lastRead.setAttribute?.('datetime', new Date(snapshot.readAt).toISOString());
      lastRead.title = `Données du ${day}.${month}.${year} · lecture locale de MyAbacus`;
    }
    block.dataset.state = result.state;
    status.textContent = result.state === 'stale' ? `Dernière lecture ancienne${result.mode === 'capture' ? ' · connexion MyAbacus à vérifier' : ''}`
      : viewCaptureState === 'reading' ? 'Lecture de MyAbacus…' : 'Lecture locale';
    updateControls();
    const expire = () => {
      if (disposed || displayed !== snapshot) return;
      if (!hasOwner()) { stopCapture(); invalidate(); stopPolling(); empty('disconnected', 'Connectez Microsoft'); return; }
      renderEmpty(result);
    };
    expiryTimer = win.setTimeout(expire, Math.max(0, myAbacusExpiry(snapshot, now(), result.mode) - now()));
    if (result.mode !== 'capture' && result.state !== 'stale') {
      staleTimer = win.setTimeout(() => {
        if (disposed || displayed !== snapshot) return;
        if (!hasOwner()) { stopCapture(); invalidate(); stopPolling(); empty('disconnected', 'Connectez Microsoft'); return; }
        const next = normalizeMyAbacusResult({ ok: true, state: 'ready', snapshot }, now());
        if (next) renderSnapshot(next); else expire();
      }, Math.max(0, snapshot.readAt + MYABACUS_READ_STALE_MS - now()));
    }
  }
  function requestSnapshot(type) {
    let settle, timer = null, finished = false;
    const promise = new Promise(resolve => { settle = resolve; });
    const finish = value => {
      if (finished) return;
      finished = true; clearTimer(timer); win.removeEventListener('message', receive); settle(value);
    };
    let id;
    const receive = event => {
      const message = event.data;
      if (event.source !== win || event.origin !== origin || !message || message.channel !== MYABACUS_CHANNEL
        || message.type !== 'RESULT' || message.requestId !== id) return;
      finish({ kind: 'result', result: message.result });
    };
    try {
      id = requestId();
      win.addEventListener('message', receive);
      timer = win.setTimeout(() => finish({ kind: 'timeout' }), 1500);
      win.postMessage({ channel: MYABACUS_CHANNEL, type, requestId: id }, origin);
    } catch { finish({ kind: 'timeout' }); }
    return { promise, cancel: () => finish({ kind: 'cancelled' }) };
  }
  function read(type = 'REQUEST') {
    if (disposed) return Promise.resolve();
    if (!hasOwner()) {
      if (ownerSessionActive) stopCapture();
      invalidate(); stopPolling(); empty('disconnected', 'Connectez Microsoft'); return Promise.resolve();
    }
    ownerSessionActive = true; stoppedForSignOut = false;
    if (pollTimer === null) pollTimer = win.setInterval(() => { void read(); }, 20_000);
    if (pending && type !== 'FORCE') return pending.promise;
    if (pending) invalidate();
    const version = ++generation, request = requestSnapshot(type);
    const active = { cancel: request.cancel, promise: null };
    pending = active;
    updateControls();
    active.promise = request.promise.then(outcome => {
      if (disposed || version !== generation || outcome.kind === 'cancelled') return;
      if (!hasOwner()) { stopCapture(); invalidate(); stopPolling(); empty('disconnected', 'Connectez Microsoft'); return; }
      if (outcome.kind === 'timeout') { empty('unavailable', 'Extension à installer'); return; }
      const result = normalizeMyAbacusResult(outcome.result, now());
      if (!result || result.state === 'empty') { renderEmpty(result); return; }
      renderSnapshot(result);
    }).finally(() => {
      if (pending === active) { pending = null; updateControls(); }
    });
    return active.promise;
  }
  const refresh = () => read();
  const forceRefresh = () => read('FORCE');
  const onSignOut = inProgress => {
    signOutPending = !!inProgress; invalidate(); stopPolling(); empty('disconnected', 'Connectez Microsoft'); stopCapture();
  };
  const unsubscribeOut = subscribeOut({ config, window: win }, onSignOut);
  const unsubscribeIn = subscribeIn({ config, window: win }, account => {
    invalidate(); stopPolling(); empty('disconnected', 'Connectez Microsoft');
    signOutPending = false;
    if (!ownerAccount(account, config)) return;
    return ready.then(() => refresh());
  });
  const showSetup = () => { if (dialog && !dialog.open) { dialog.showModal(); close?.focus(); } };
  const hideSetup = () => dialog?.close();
  const restoreFocus = () => open?.focus();
  open?.addEventListener('click', showSetup); close?.addEventListener('click', hideSetup);
  const forceClick = () => { void forceRefresh(); };
  refreshButton?.addEventListener('click', forceClick);
  dialog?.addEventListener('close', restoreFocus);
  const visibility = () => { if (doc.visibilityState !== 'hidden') void refresh(); };
  doc.addEventListener?.('visibilitychange', visibility);
  const pagehide = event => { if (!event.persisted) dispose(); };
  win.addEventListener?.('pagehide', pagehide);
  empty('disconnected', 'Connectez Microsoft');
  const preparingGeneration = generation;
  const ready = Promise.resolve().then(() => clientFor({ config, redirectUri, loadSdk, window: win })).then(result => {
    if (disposed) return;
    application = result.application;
    if (generation === preparingGeneration) return refresh();
  }).catch(() => {
    if (!disposed && generation === preparingGeneration) empty('disconnected', 'Connexion Microsoft indisponible');
  });
  function dispose() {
    if (disposed) return;
    disposed = true; invalidate(); stopPolling(); clearDisplayTimers(); displayed = null;
    unsubscribeOut?.(); unsubscribeIn?.();
    open?.removeEventListener('click', showSetup); close?.removeEventListener('click', hideSetup);
    refreshButton?.removeEventListener('click', forceClick);
    dialog?.removeEventListener('close', restoreFocus); doc.removeEventListener?.('visibilitychange', visibility);
    win.removeEventListener?.('pagehide', pagehide);
  }
  return { ready, refresh, forceRefresh, dispose };
}

if (typeof document !== 'undefined') initializeMyAbacus();
