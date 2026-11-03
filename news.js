import { INTRANET_CONFIG_KEY, INTRANET_DEPLOYMENT_IDS, normalizeIntranetConfig, intranetScope } from './intranet-core.mjs';
import { NEWS_API_URL, normalizeNewsResponse, newsDateLabel } from './news-core.mjs';
import { retryAfterMilliseconds } from './outlook-core.mjs';
import { getMicrosoftClient, getRememberedMicrosoftAccount, isDashboardMicrosoftAccount, rememberMicrosoftAccount,
  subscribeMicrosoftSignOut, clearMicrosoftSession } from './microsoft-session.mjs';
import { createAutoRefresh } from './auto-refresh.mjs';

export function initializeInternalNews(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const get = selector => doc.querySelector(selector);
  if (!get('#news-preview')) return null;
  const now = options.now || (() => new Date()), nowMs = options.autoRefreshOptions?.nowMs || Date.now;
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  const loadSdk = options.loadSdk || (() => import('./vendor/msal.js'));
  const redirectUri = new URL('auth-redirect.html', doc.baseURI).href;
  let storage = null;
  try { storage = options.storage || win.localStorage; } catch { /* Session-only sign-in remains available. */ }
  function readConfig() {
    try { return normalizeIntranetConfig(JSON.parse(storage?.getItem(INTRANET_CONFIG_KEY) || 'null')) || normalizeIntranetConfig(INTRANET_DEPLOYMENT_IDS); }
    catch { return normalizeIntranetConfig(INTRANET_DEPLOYMENT_IDS); }
  }
  let config = readConfig(), application = null, sdk = null, account = null;
  let preparing = false, authBusy = false, signingOut = false, fetching = false, reconnect = false, blocked = false;
  let sdkGeneration = 0, connectionGeneration = 0, requestGeneration = 0, controller = null;
  let lastGood = null, retryUntil = 0, retryTimer = null, lastAttempt = -Infinity, unsubscribe;
  const auto = (options.autoRefreshFactory || createAutoRefresh)({ ...options.autoRefreshOptions, document: doc, window: win,
    refresh: () => refresh(null, { automatic: true }),
    canRefresh: () => !!account && !!application && !preparing && !authBusy && !fetching && !reconnect && !blocked,
    retryAt: () => retryUntil, lastAttemptAt: () => lastAttempt });
  const stamp = date => new Intl.DateTimeFormat('fr-CH', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
  function status(message, state = '') { get('#news-status').textContent = message; get('#news-status').dataset.state = state; }
  function empty(message) { const node = doc.createElement('p'); node.className = 'news-empty'; node.textContent = message; get('#news-items').replaceChildren(node); }
  function clear(message) { lastGood = null; get('#news-last-updated').textContent = ''; empty(message); }
  function controls() {
    get('#news-connect').hidden = !!account && !reconnect;
    get('#news-connect').disabled = preparing || authBusy;
    get('#news-connect').textContent = signingOut ? 'Déconnexion…' : preparing ? 'Préparation…' : authBusy ? 'Connexion…' : reconnect ? 'Reconnecter les actualités' : 'Connecter les actualités';
    get('#news-refresh').hidden = !account;
    get('#news-refresh').disabled = !account || reconnect || preparing || authBusy || fetching || nowMs() < retryUntil;
    get('#news-disconnect').hidden = !account; get('#news-disconnect').disabled = authBusy;
    get('#news-account').textContent = 'Dernière publication de l’intranet';
    get('#news-items').setAttribute('aria-busy', String(fetching));
  }
  function cancel(reset = false) {
    requestGeneration++; controller?.abort(); controller = null; fetching = false;
    if (reset) { clearTimeout(retryTimer); retryTimer = null; retryUntil = 0; }
  }
  function signedOut(pending = false) {
    auto.stop(); sdkGeneration++; connectionGeneration++; account = null;
    reconnect = false; blocked = false; preparing = false; signingOut = !!pending; authBusy = !!pending; cancel(true);
    clear('Connectez votre compte pour lire la dernière publication.'); status('Microsoft déconnecté de ce dashboard.'); controls();
  }
  function bindSignOut() { unsubscribe?.(); unsubscribe = subscribeMicrosoftSignOut({ config, window: win }, signedOut); }
  function syncConfig() {
    const next = readConfig();
    if (JSON.stringify(next) === JSON.stringify(config)) return false;
    signedOut(false); application = null; config = next; bindSignOut(); prepare(); return true;
  }
  async function prepare() {
    const generation = ++sdkGeneration, snapshot = { ...config };
    preparing = true; status('Préparation des actualités…', 'loading'); controls();
    try {
      const client = await getMicrosoftClient({ config: snapshot, redirectUri, loadSdk, window: win });
      if (generation !== sdkGeneration) return;
      application = client.application; sdk = client.sdk; preparing = false;
      account = getRememberedMicrosoftAccount({ application, config: snapshot, storage });
      if (account) { auto.start(); await refresh(); }
      else status('Connectez l’intranet pour retrouver sa dernière publication.');
    } catch { if (generation === sdkGeneration) status('La connexion à Microsoft est indisponible. Réessayez.', 'error'); }
    finally { if (generation === sdkGeneration) { preparing = false; controls(); } }
  }
  async function connect() {
    if (syncConfig() || preparing || authBusy) return;
    if (!application) { await prepare(); return; }
    const generation = ++connectionGeneration, client = application, snapshot = { ...config };
    authBusy = true; auto.stop(); cancel(true); clear('Connexion à l’intranet…'); status('Terminez la connexion dans la fenêtre Microsoft.', 'loading'); controls();
    try {
      const response = await client.loginPopup({ scopes: [intranetScope(snapshot)], redirectUri, prompt: 'select_account' });
      if (generation !== connectionGeneration) return;
      if (!isDashboardMicrosoftAccount(response.account, snapshot)) {
        if (response.account && !isDashboardMicrosoftAccount(response.account, INTRANET_DEPLOYMENT_IDS)) {
          try { await client.clearCache({ account: response.account }); } catch { /* Do not touch the owner's cache. */ }
        }
        throw Object.assign(new Error('Unauthorized account'), { errorCode: 'dashboard_account_not_allowed' });
      }
      if (!response.accessToken) throw new Error('Missing token');
      rememberMicrosoftAccount({ application: client, account: response.account, config: snapshot, storage });
      account = response.account; reconnect = false; blocked = false; authBusy = false; controls(); await refresh(response.accessToken);
    } catch (error) {
      if (generation !== connectionGeneration) return;
      account = null; clear('Les actualités ne sont pas connectées.');
      status(['user_cancelled', 'user_canceled'].includes(error.errorCode) ? 'Connexion annulée.'
        : error.errorCode === 'interaction_in_progress' ? 'Une fenêtre Microsoft est déjà ouverte. Terminez cette connexion puis réessayez.'
          : error.errorCode === 'dashboard_account_not_allowed' ? 'Choisissez le seul compte affecté à ce dashboard.'
            : 'La connexion n’a pas abouti. Réessayez avec votre compte professionnel autorisé.', 'error');
    } finally { if (generation === connectionGeneration) { authBusy = false; controls(); } }
  }
  function render(snapshot) {
    const fragment = doc.createDocumentFragment();
    for (const item of snapshot.news) {
      const article = doc.createElement('article'); article.className = 'news-item';
      const heading = doc.createElement('div'); heading.className = 'news-item-heading';
      const title = doc.createElement(item.url ? 'a' : 'strong'); title.className = 'news-item-title'; title.textContent = item.title;
      if (item.url) { title.href = item.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; title.referrerPolicy = 'no-referrer'; title.setAttribute('aria-label', `${item.title} — ouvrir dans l’intranet`); }
      const date = doc.createElement('time'); date.className = 'news-item-date'; date.dateTime = item.publishedAt.toISOString(); date.textContent = newsDateLabel(item.publishedAt);
      heading.append(title, date); article.append(heading);
      const label = doc.createElement('p'); label.className = 'news-item-meta'; label.textContent = [item.isPinned ? 'Épinglée' : '', item.label].filter(Boolean).join(' · ');
      if (label.textContent) article.append(label);
      if (item.content) { const content = doc.createElement('p'); content.className = 'news-item-content'; content.textContent = item.content; article.append(content); }
      fragment.append(article);
    }
    if (snapshot.news.length) get('#news-items').replaceChildren(fragment);
    else empty('Aucune publication disponible pour le moment.');
  }
  async function refresh(token = null, { automatic = false } = {}) {
    if (syncConfig() || !application || !account || reconnect || preparing || authBusy || fetching || nowMs() < retryUntil) return;
    lastAttempt = nowMs(); cancel(); const generation = requestGeneration, client = application, identity = account;
    const retain = automatic && !!lastGood; fetching = true; controller = new AbortController(); const abort = controller;
    if (!retain) { clear('Chargement de la dernière publication…'); status('Lecture de l’intranet…', 'loading'); } controls();
    let timeout;
    try {
      const accessToken = token || (await client.acquireTokenSilent({ account: identity, scopes: [intranetScope(config)], redirectUri })).accessToken;
      if (generation !== requestGeneration) return;
      if (!accessToken) throw new Error('Missing token');
      timeout = setTimeout(() => abort.abort(), 20000);
      const response = await fetcher(NEWS_API_URL, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: abort.signal, redirect: 'error', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (generation !== requestGeneration) return;
      if (!response.ok) throw Object.assign(new Error('News request failed'), { httpStatus: response.status,
        retryAfter: response.status === 429 ? retryAfterMilliseconds(response.headers.get('Retry-After'), nowMs()) : null });
      let data;
      try { data = normalizeNewsResponse(await response.json()); }
      catch { throw Object.assign(new Error('Invalid news response'), { unsafeResponse: true }); }
      if (generation !== requestGeneration) return;
      const signature = JSON.stringify(data), at = now();
      if (!retain || lastGood.signature !== signature) render(data);
      lastGood = { data, signature, at }; blocked = false;
      get('#news-last-updated').textContent = `Actualisé le ${stamp(at)}`;
      status('Dernière publication visible · lecture seule', 'connected'); auto.start();
    } catch (error) {
      if (generation !== requestGeneration) return;
      const expired = sdk?.InteractionRequiredAuthError && error instanceof sdk.InteractionRequiredAuthError
        || ['interaction_required', 'login_required', 'consent_required'].includes(error.errorCode) || error.httpStatus === 401;
      const forbidden = error.httpStatus === 403;
      const transient = !error.unsafeResponse && (error.httpStatus === 429 || error.name === 'AbortError'
        || !error.httpStatus && (error instanceof TypeError || ['network_error', 'no_network_connectivity', 'post_request_failed', 'get_request_failed', 'timed_out'].includes(error.errorCode)));
      const keep = retain && transient && !expired && !forbidden;
      if (!keep) clear('Les actualités sont indisponibles pour le moment.');
      if (expired || forbidden) {
        auto.stop(); reconnect = !!expired; blocked = !!forbidden;
        status(expired ? 'Reconnectez l’intranet pour retrouver la dernière publication.' : 'Ce compte n’est pas autorisé à consulter cette publication.', 'error');
      } else {
        if (error.httpStatus === 429) {
          retryUntil = nowMs() + error.retryAfter; clearTimeout(retryTimer);
          retryTimer = setTimeout(() => { retryUntil = 0; controls(); }, error.retryAfter); retryTimer?.unref?.();
        }
        status(keep ? `Actualisation impossible. Dernières données reçues le ${stamp(lastGood.at)}.`
          : error.httpStatus === 404 || error.httpStatus === 503 ? 'La lecture des actualités n’est pas encore disponible sur l’intranet.'
            : 'La publication ne peut pas être chargée. Réessayez depuis le réseau professionnel.', 'error');
      }
    } finally { clearTimeout(timeout); if (generation === requestGeneration) { fetching = false; controller = null; controls(); } }
  }
  async function disconnect() { const client = application, identity = account; signedOut(true); await clearMicrosoftSession({ application: client, account: identity, config, storage, window: win }); }
  const storageChanged = event => { if (event.key === INTRANET_CONFIG_KEY || event.key === null) syncConfig(); };
  get('#news-connect').addEventListener('click', connect);
  get('#news-refresh').addEventListener('click', () => refresh());
  get('#news-disconnect').addEventListener('click', disconnect);
  get('#intranet-config-form')?.addEventListener('submit', syncConfig);
  win.addEventListener?.('storage', storageChanged);
  clear('La dernière publication apparaîtra ici après connexion.'); bindSignOut(); controls(); prepare();
  return { refresh, connect, disconnect, dispose() { auto.dispose(); sdkGeneration++; connectionGeneration++; cancel(true); unsubscribe?.(); win.removeEventListener?.('storage', storageChanged); get('#intranet-config-form')?.removeEventListener?.('submit', syncConfig); } };
}

if (typeof document !== 'undefined') initializeInternalNews();
