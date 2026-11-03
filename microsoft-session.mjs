// Public application identifiers. Authentication artifacts are managed only by MSAL.
export const MICROSOFT_DEPLOYMENT = Object.freeze({
  clientId: 'bd2a054b-f9ea-4740-b90c-16a132f90bc4',
  tenantId: '0b394bfa-2e05-46ef-9a28-487a32ca0014',
  ownerObjectId: '05a570a2-d339-481e-9991-fddfe03f9da3'
});

const clientsByWindow = new WeakMap();
const listenersByWindow = new WeakMap();
export const microsoftSessionKey = config => `mon-espace-microsoft-session-v1:${config.clientId}:${config.tenantId}`;

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

export function subscribeMicrosoftSignOut({ config, window: win }, callback) {
  const key = microsoftSessionKey(config);
  let listeners = listenersByWindow.get(win);
  if (!listeners) { listeners = new Map(); listenersByWindow.set(win, listeners); }
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(callback);
  const onStorage = event => {
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
  try { storage?.setItem(key, '0'); } catch { /* Current-page sign-out still applies. */ }
  // Clear both widgets before waiting for cache cleanup or any in-flight response.
  const notify = pending => { for (const listener of listenersByWindow.get(win)?.get(key) || []) listener(pending); };
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
    notify(false);
  }
}
