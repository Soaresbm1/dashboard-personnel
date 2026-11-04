// Public application identifiers. Authentication artifacts are managed only by MSAL.
export const MICROSOFT_DEPLOYMENT = Object.freeze({
  clientId: 'bd2a054b-f9ea-4740-b90c-16a132f90bc4',
  tenantId: '0b394bfa-2e05-46ef-9a28-487a32ca0014',
  ownerObjectId: '05a570a2-d339-481e-9991-fddfe03f9da3'
});

const clientsByWindow = new WeakMap();
const listenersByWindow = new WeakMap();
const signInStatesByWindow = new WeakMap();
export const MICROSOFT_GRAPH_SCOPES = Object.freeze(['Calendars.ReadBasic', 'Mail.ReadBasic', 'Place.Read.All']);
export const microsoftSessionKey = config => `mon-espace-microsoft-session-v1:${config.clientId}:${config.tenantId}`;

function sessionState(win, key) {
  let states = signInStatesByWindow.get(win);
  if (!states) { states = new Map(); signInStatesByWindow.set(win, states); }
  if (!states.has(key)) {
    const state = { epoch: 0, signOuts: 0, externalSignOut: false, references: 0, listeners: new Set(), pending: null, lastStorageEvent: null };
    state.onStorage = event => storageSignOut(state, key, event);
    states.set(key, state);
  }
  return states.get(key);
}

function storageSignOut(state, key, event) {
  if (event.key !== key && event.key !== null || state.lastStorageEvent === event) return;
  state.lastStorageEvent = event;
  if (event.key === key && event.newValue === '1') { state.externalSignOut = false; return; }
  state.epoch++;
  state.externalSignOut = event.key === key && event.newValue === '0';
}

function retainSignInObserver(state, win) {
  if (state.references++ === 0) win.addEventListener?.('storage', state.onStorage);
}

function releaseSignInObserver(state, win) {
  if (state.references > 0 && --state.references === 0) win.removeEventListener?.('storage', state.onStorage);
}

const cancelledSignIn = () => Object.assign(new Error('Microsoft sign-in was cancelled by sign-out.'), { errorCode: 'dashboard_sign_in_cancelled' });

export function isDashboardMicrosoftAccount(account, config) {
  const tenant = account?.tenantId?.toLowerCase();
  const objectId = (account?.idTokenClaims?.oid || account?.localAccountId)?.toLowerCase();
  return config?.tenantId === MICROSOFT_DEPLOYMENT.tenantId && tenant === config.tenantId && objectId === MICROSOFT_DEPLOYMENT.ownerObjectId;
}

export async function getMicrosoftClient({ config, redirectUri, loadSdk, window: win }) {
  let clients = clientsByWindow.get(win);
  if (!clients) { clients = new Map(); clientsByWindow.set(win, clients); }
  const key = `${config.clientId}:${config.tenantId}:${redirectUri}`;
  if (!clients.has(key)) {
    const prepared = (async () => {
      const sdk = await loadSdk();
      const application = new sdk.PublicClientApplication({
        auth: { clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}`, redirectUri },
        cache: { cacheLocation: 'localStorage' },
        system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } }
      });
      await application.initialize();
      return { application, sdk };
    })();
    clients.set(key, prepared);
    prepared.catch(() => { if (clients.get(key) === prepared) clients.delete(key); });
  }
  return clients.get(key);
}

export function getRememberedMicrosoftAccount({ application, config, storage }) {
  try { if (storage?.getItem(microsoftSessionKey(config)) !== '1') return null; }
  catch { return null; }
  const active = application.getActiveAccount();
  if (isDashboardMicrosoftAccount(active, config)) return active;
  return application.getAllAccounts().find(account => isDashboardMicrosoftAccount(account, config)) || null;
}

export function rememberMicrosoftAccount({ application, account, config, storage }) {
  if (!isDashboardMicrosoftAccount(account, config)) throw new Error('Unexpected Microsoft account');
  application.setActiveAccount(account);
  try { storage?.setItem(microsoftSessionKey(config), '1'); return !!storage; }
  catch { return false; }
}

export function subscribeMicrosoftSignIn({ config, window: win }, callback) {
  const state = sessionState(win, microsoftSessionKey(config)), subscription = { callback };
  state.listeners.add(subscription);
  retainSignInObserver(state, win);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false; state.listeners.delete(subscription); releaseSignInObserver(state, win);
  };
}

// Deliberately not async: MSAL must open its popup during the original click gesture.
// Graph and intranet tokens are never passed to service listeners; each acquires its own scope silently.
export function connectMicrosoftServices({ application, config, storage, window: win, redirectUri }) {
  if (!application?.loginPopup || !config?.clientId || !config?.tenantId || !win) {
    return Promise.reject(Object.assign(new Error('The Microsoft client must be initialized before connecting.'), { errorCode: 'dashboard_configuration_invalid' }));
  }
  const snapshot = { ...config }, key = microsoftSessionKey(snapshot), state = sessionState(win, key);
  if (state.pending) return state.pending.epoch === state.epoch ? state.pending.promise : Promise.reject(cancelledSignIn());
  if (state.signOuts || state.externalSignOut) return Promise.reject(cancelledSignIn());
  const epoch = state.epoch;
  retainSignInObserver(state, win);
  let popup;
  try {
    popup = application.loginPopup({ scopes: [...MICROSOFT_GRAPH_SCOPES], redirectUri, prompt: 'select_account' });
  } catch (error) {
    releaseSignInObserver(state, win);
    return Promise.reject(error);
  }
  const pending = Promise.resolve(popup).then(async response => {
    if (epoch !== state.epoch || state.signOuts || state.externalSignOut) throw cancelledSignIn();
    if (!isDashboardMicrosoftAccount(response?.account, snapshot)) {
      throw Object.assign(new Error('Unexpected Microsoft account'), { errorCode: 'dashboard_account_not_allowed' });
    }
    const account = response.account;
    rememberMicrosoftAccount({ application, account, config: snapshot, storage });
    const restorations = [];
    for (const subscription of [...state.listeners]) {
      if (epoch !== state.epoch || state.signOuts || state.externalSignOut) break;
      if (!state.listeners.has(subscription)) continue;
      try { restorations.push(Promise.resolve(subscription.callback(account))); }
      catch (error) { restorations.push(Promise.reject(error)); }
    }
    await Promise.allSettled(restorations);
    if (epoch !== state.epoch || state.signOuts || state.externalSignOut) throw cancelledSignIn();
    return account;
  }).finally(() => {
    if (state.pending?.promise === pending) state.pending = null;
    releaseSignInObserver(state, win);
  });
  state.pending = { promise: pending, epoch };
  return pending;
}

export function subscribeMicrosoftSignOut({ config, window: win }, callback) {
  const key = microsoftSessionKey(config);
  const state = sessionState(win, key);
  let listeners = listenersByWindow.get(win);
  if (!listeners) { listeners = new Map(); listenersByWindow.set(win, listeners); }
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(callback);
  const onStorage = event => {
    storageSignOut(state, key, event);
    if (event.key === key && event.newValue !== '1') callback(event.newValue === '0');
    else if (event.key === null) callback(false);
  };
  win.addEventListener?.('storage', onStorage);
  return () => {
    listeners.get(key)?.delete(callback);
    win.removeEventListener?.('storage', onStorage);
  };
}

export async function clearMicrosoftSession({ application, account, config, storage, window: win }) {
  if (!config) return;
  const key = microsoftSessionKey(config);
  const state = sessionState(win, key);
  state.epoch++; state.signOuts++;
  try { storage?.setItem(key, '0'); } catch { /* Current-page sign-out still applies. */ }
  // Clear both widgets before waiting for cache cleanup or any in-flight response.
  const notify = pending => {
    for (const listener of listenersByWindow.get(win)?.get(key) || []) {
      try { listener(pending); } catch { /* One widget must not block sign-out for the others. */ }
    }
  };
  notify(true);
  try {
    if (!application) return;
    const accounts = application.getAllAccounts().filter(candidate => isDashboardMicrosoftAccount(candidate, config));
    if (isDashboardMicrosoftAccount(account, config) && !accounts.some(candidate => candidate.homeAccountId === account.homeAccountId)) accounts.push(account);
    application.setActiveAccount(null);
    for (const candidate of accounts) {
      try { await application.clearCache({ account: candidate }); }
      catch { /* The disabled preference prevents automatic restoration after a cleanup failure. */ }
    }
  } finally {
    try { storage?.removeItem(key); } catch { /* A stored '0' also prevents restoration. */ }
    state.signOuts--;
    notify(state.signOuts > 0 || state.externalSignOut);
  }
}
