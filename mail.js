import { MAIL_SCOPES, MAIL_PREVIEW_LIMIT, MAIL_PREVIEW_PAGES, mailListUrl, inboxUnreadCountUrl,
  safeMailGraphUrl, normalizeUnreadCount, normalizeMailMessages, mailDateLabel } from './mail-core.mjs';
import { OUTLOOK_CONFIG_KEY, normalizeOutlookConfig, retryAfterMilliseconds } from './outlook-core.mjs';
import { MICROSOFT_DEPLOYMENT, getMicrosoftClient, getRememberedMicrosoftAccount, isDashboardMicrosoftAccount,
  rememberMicrosoftAccount, clearMicrosoftSession, subscribeMicrosoftSignOut } from './microsoft-session.mjs';
import { createAutoRefresh } from './auto-refresh.mjs';

// Mail metadata lives only in memory. Authentication and sign-out use the shared Microsoft session.
export function initializeMailPreview(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const get = selector => doc.querySelector(selector);
  if (!get('#mail-preview')) return null;
  const now = options.now || (() => new Date()), nowMs = options.autoRefreshOptions?.nowMs || Date.now;
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  const loadSdk = options.loadSdk || (() => import('./vendor/msal.js'));
  const redirectUri = new URL('auth-redirect.html', doc.baseURI).href;
  let storage = null;
  try { storage = options.storage || win.localStorage; } catch { /* The Microsoft connection can still work for this page. */ }
  function readConfig() {
    try { return normalizeOutlookConfig(JSON.parse(storage?.getItem(OUTLOOK_CONFIG_KEY) || 'null')) || normalizeOutlookConfig(MICROSOFT_DEPLOYMENT); }
    catch { return normalizeOutlookConfig(MICROSOFT_DEPLOYMENT); }
  }
  let config = readConfig(), pca = null, sdk = null, account = null;
  let sdkLoading = false, authBusy = false, signingOut = false, needsReconnect = false, accessBlocked = false, fetching = false;
  let selectedFilter = 'unread', sdkGeneration = 0, connectionGeneration = 0, requestGeneration = 0;
  let controller = null, retryUntil = 0, retryTimer = null, lastRequestStartedAt = -Infinity, lastGood = null, unsubscribeSignOut = null;

  function setStatus(text, state = '') { get('#mail-status').textContent = text; get('#mail-status').dataset.state = state; }
  function empty(text) { const element = doc.createElement('p'); element.className = 'mail-empty'; element.textContent = text; get('#mail-items').replaceChildren(element); }
  function renderUnreadCount(count) {
    const element = get('#mail-unread-count');
    element.textContent = count === null ? '—' : new Intl.NumberFormat('fr-CH').format(count);
    const label = count === null ? 'Nombre de mails non lus dans la boîte de réception indisponible' : `${count} mail${count > 1 ? 's' : ''} non lu${count > 1 ? 's' : ''} dans la boîte de réception`;
    element.title = label; element.setAttribute('aria-label', label);
  }
  function clearMessages(text) { lastGood = null; get('#mail-last-updated').textContent = ''; renderUnreadCount(null); empty(text); }
  function exactTime(date) { return new Intl.DateTimeFormat('fr-CH', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date); }
  function staleWarning(text) { return lastGood ? `${text} Dernières données reçues le ${exactTime(lastGood.at)}.` : text; }
  function renderControls() {
    const connect = get('#mail-connect');
    connect.hidden = !!account && !needsReconnect;
    connect.disabled = sdkLoading || authBusy;
    connect.textContent = !config ? 'Configurer Outlook' : sdkLoading ? 'Préparation…' : authBusy ? signingOut ? 'Déconnexion…' : 'Connexion…' : needsReconnect ? 'Autoriser les mails Outlook' : 'Connecter les mails Outlook';
    get('#mail-refresh').hidden = !account;
    get('#mail-refresh').disabled = !account || fetching || authBusy || needsReconnect || nowMs() < retryUntil;
    get('#mail-disconnect').hidden = !account;
    get('#mail-disconnect').disabled = authBusy;
    get('#mail-account').textContent = account ? account.username || account.name || 'Compte Microsoft 365 connecté' : 'Boîte de réception Microsoft 365';
    get('#mail-items').setAttribute('aria-busy', String(fetching));
    doc.querySelectorAll('[data-mail-filter]').forEach(button => {
      button.disabled = !account || authBusy || needsReconnect || nowMs() < retryUntil;
      button.setAttribute('aria-pressed', String(button.dataset.mailFilter === selectedFilter));
    });
  }
  function cancelRequests({ resetThrottle = false } = {}) {
    requestGeneration++; controller?.abort(); controller = null; fetching = false;
    if (resetThrottle) { clearTimeout(retryTimer); retryUntil = 0; }
  }
  function signedOut(pending = false) {
    autoRefresh.stop(); connectionGeneration++; account = null; needsReconnect = false; accessBlocked = false;
    signingOut = pending; authBusy = pending; cancelRequests({ resetThrottle: true });
    clearMessages('Connectez Outlook pour afficher vos cinq derniers mails.');
    setStatus('Microsoft déconnecté de ce dashboard.'); renderControls();
  }
  function observeSignOut() { unsubscribeSignOut?.(); unsubscribeSignOut = subscribeMicrosoftSignOut({ config, window: win }, signedOut); }
  function configChanged() {
    const next = readConfig();
    if (next?.clientId === config?.clientId && next?.tenantId === config?.tenantId) return false;
    autoRefresh.stop(); sdkGeneration++; connectionGeneration++; cancelRequests({ resetThrottle: true });
    account = null; pca = null; needsReconnect = false; accessBlocked = false; authBusy = false; signingOut = false; config = next;
    observeSignOut(); clearMessages('La configuration Microsoft a changé. Connectez de nouveau les mails Outlook.'); renderControls();
    if (config) prepareSdk();
    return true;
  }
  async function prepareSdk() {
    if (!config) return;
    const generation = ++sdkGeneration, snapshot = { ...config };
    sdkLoading = true; pca = null; setStatus('Préparation de la connexion aux mails Outlook…', 'loading'); renderControls();
    try {
      const result = await getMicrosoftClient({ config: snapshot, redirectUri, loadSdk, window: win });
      if (generation !== sdkGeneration) return;
      pca = result.application; sdk = result.sdk;
      setStatus('Connectez Outlook pour autoriser la lecture des sujets et des expéditeurs.');
      const restored = getRememberedMicrosoftAccount({ application: pca, config: snapshot, storage });
      if (restored) { account = restored; needsReconnect = false; sdkLoading = false; renderControls(); autoRefresh.start(); await refresh(); }
    } catch {
      if (generation === sdkGeneration) setStatus('La connexion Microsoft ne peut pas être préparée. Vérifiez votre connexion et réessayez.', 'error');
    } finally { if (generation === sdkGeneration) { sdkLoading = false; renderControls(); } }
  }
  function loginError(error) {
    if (['user_cancelled', 'user_canceled'].includes(error?.errorCode)) return 'Connexion annulée. Vos mails restent masqués.';
    if (['popup_window_error', 'empty_window_error', 'popup_window_timeout', 'monitor_popup_timeout', 'timed_out'].includes(error?.errorCode)) return 'La fenêtre Microsoft n’a pas terminé la connexion. Autorisez les fenêtres de ce site ou ouvrez le dashboard directement dans votre navigateur.';
    if (error?.errorCode === 'dashboard_account_not_allowed') return 'Choisissez le compte personnellement affecté au dashboard pour connecter les mails.';
    if (['consent_required', 'access_denied'].includes(error?.errorCode)) return 'La lecture des mails doit être autorisée. Votre organisation peut demander l’accord d’un administrateur pour Mail.ReadBasic.';
    return 'La connexion aux mails Outlook n’a pas abouti. Vérifiez la connexion et l’autorisation Mail.ReadBasic de cette application.';
  }
  async function connect() {
    if (configChanged()) return;
    if (!config) { get('#outlook-configure')?.click(); return; }
    if (sdkLoading || authBusy) return;
    if (!pca) { await prepareSdk(); return; }
    const generation = ++connectionGeneration, application = pca;
    autoRefresh.stop(); authBusy = true; cancelRequests({ resetThrottle: true }); clearMessages('Connexion sécurisée aux mails Outlook…');
    setStatus('Autorisez les métadonnées des mails dans la fenêtre Microsoft.', 'loading'); renderControls();
    try {
      const response = await application.loginPopup({ scopes: [...MAIL_SCOPES], redirectUri, prompt: 'select_account' });
      if (generation !== connectionGeneration) return;
      if (!isDashboardMicrosoftAccount(response.account, config)) {
        if (response.account && !isDashboardMicrosoftAccount(response.account, MICROSOFT_DEPLOYMENT)) { try { await application.clearCache({ account: response.account }); } catch { /* Preserve the owner's shared session. */ } }
        throw Object.assign(new Error('Unexpected Microsoft account'), { errorCode: 'dashboard_account_not_allowed' });
      }
      account = response.account; needsReconnect = false; accessBlocked = false;
      rememberMicrosoftAccount({ application, account, config, storage });
      authBusy = false; renderControls(); autoRefresh.start(); await refresh(response.accessToken || null);
    } catch (error) {
      if (generation !== connectionGeneration) return;
      autoRefresh.stop(); account = null; clearMessages('Vos mails ne sont pas connectés.'); setStatus(loginError(error), 'error');
    } finally { if (generation === connectionGeneration) { authBusy = false; renderControls(); } }
  }

  function renderMessages(messages) {
    if (!messages.length) { empty(selectedFilter === 'important' ? 'Aucun mail d’importance haute dans votre boîte de réception.' : 'Aucun mail non lu dans votre boîte de réception.'); return; }
    const fragment = doc.createDocumentFragment();
    for (const message of messages) {
      const row = doc.createElement('article'); row.className = 'mail-item'; row.classList.toggle('is-important', message.importance === 'high');
      const heading = doc.createElement('div'); heading.className = 'mail-item-heading';
      const subject = doc.createElement(message.url ? 'a' : 'strong'); subject.className = 'mail-item-subject'; subject.textContent = message.subject;
      if (message.url) { subject.href = message.url; subject.target = '_blank'; subject.rel = 'noopener noreferrer'; subject.referrerPolicy = 'no-referrer'; subject.setAttribute('aria-label', `${message.subject} — ouvrir dans Outlook`); }
      const time = doc.createElement('time'); time.className = 'mail-item-date'; time.dateTime = message.receivedAt.toISOString(); time.textContent = mailDateLabel(message.receivedAt, now()); time.title = exactTime(message.receivedAt);
      heading.append(subject, time);
      const from = doc.createElement('p'); from.className = 'mail-item-from';
      from.textContent = message.senderName && message.senderAddress && message.senderName !== message.senderAddress ? `${message.senderName} · ${message.senderAddress}` : message.senderName || message.senderAddress || 'Expéditeur inconnu';
      const meta = doc.createElement('span'); meta.className = 'mail-item-meta'; meta.textContent = `${message.importance === 'high' ? 'Importance haute · ' : ''}${message.isRead ? 'Lu' : 'Non lu'}`;
      row.append(heading, from, meta); fragment.append(row);
    }
    get('#mail-items').replaceChildren(fragment);
  }

  async function refresh(accessToken = null, { automatic = false } = {}) {
    if (configChanged()) return;
    if (!account || !pca || sdkLoading || authBusy || needsReconnect || nowMs() < retryUntil || automatic && (fetching || accessBlocked)) return;
    lastRequestStartedAt = nowMs(); cancelRequests();
    const generation = requestGeneration, application = pca, signedInAccount = account, requestedFilter = selectedFilter;
    const preserve = automatic && lastGood?.account === signedInAccount && lastGood.filter === requestedFilter;
    const abortController = new AbortController(); controller = abortController; fetching = true;
    if (!preserve) { clearMessages('Chargement des mails Outlook…'); setStatus('Lecture de la boîte de réception…', 'loading'); }
    renderControls();
    async function getJson(url, { messagesOnly = false } = {}) {
      const safeUrl = safeMailGraphUrl(url, { messagesOnly });
      if (!safeUrl) throw new Error('Unsafe mail request');
      const timeout = setTimeout(() => abortController.abort(), 20000);
      try {
        const response = await fetcher(safeUrl, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: abortController.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
        if (!response.ok) {
          const error = Object.assign(new Error('Mail request failed'), { httpStatus: response.status });
          if (response.status === 429) error.retryAfter = retryAfterMilliseconds(response.headers.get('Retry-After'), nowMs());
          throw error;
        }
        return await response.json();
      } finally { clearTimeout(timeout); }
    }
    let token;
    try {
      token = accessToken || (await application.acquireTokenSilent({ account: signedInAccount, scopes: [...MAIL_SCOPES], redirectUri })).accessToken;
      if (generation !== requestGeneration) return;
      if (!token) throw new Error('Missing mail access token');
      const folder = await getJson(inboxUnreadCountUrl());
      if (generation !== requestGeneration) return;
      const unreadCount = normalizeUnreadCount(folder.unreadItemCount);
      if (unreadCount === null) throw new Error('Invalid inbox count');
      let page = mailListUrl(requestedFilter), pages = 0, values = [], messages = [];
      const visited = new Set();
      while (page && messages.length < MAIL_PREVIEW_LIMIT && pages < MAIL_PREVIEW_PAGES) {
        const safePage = safeMailGraphUrl(page, { messagesOnly: true });
        if (!safePage || visited.has(safePage)) throw new Error('Unsafe mail pagination');
        visited.add(safePage);
        const body = await getJson(safePage, { messagesOnly: true });
        if (generation !== requestGeneration) return;
        if (!Array.isArray(body.value)) throw new Error('Invalid mail response');
        values.push(...body.value.slice(0, 100));
        messages = normalizeMailMessages(values, requestedFilter); pages++; page = body['@odata.nextLink'] || null;
      }
      if (generation !== requestGeneration) return;
      const at = now(), limited = !!page;
      const signature = JSON.stringify({ filter: requestedFilter, localDay: [at.getFullYear(), at.getMonth(), at.getDate()], messages });
      if (!preserve || signature !== lastGood.signature) {
        if (limited && !messages.length) empty('Cet aperçu est partiel. Consultez Outlook pour voir tous les messages de ce filtre.');
        else renderMessages(messages);
      }
      lastGood = { account: signedInAccount, filter: requestedFilter, at, messages, unreadCount, signature };
      accessBlocked = false;
      renderUnreadCount(unreadCount);
      get('#mail-last-updated').textContent = `Actualisé le ${exactTime(at)}`;
      const description = requestedFilter === 'important' ? 'mails importants · lus ou non' : 'mails non lus';
      setStatus(`${messages.length === MAIL_PREVIEW_LIMIT ? 'Les 5 derniers' : `${messages.length}`} ${description} · actualisation automatique${limited && messages.length < MAIL_PREVIEW_LIMIT ? ' · aperçu partiel' : ''}`, 'connected');
      autoRefresh.start();
    } catch (error) {
      if (generation !== requestGeneration) return;
      const interactionRequired = sdk?.InteractionRequiredAuthError && error instanceof sdk.InteractionRequiredAuthError;
      if (interactionRequired || ['interaction_required', 'login_required', 'consent_required'].includes(error?.errorCode) || error.httpStatus === 401) {
        autoRefresh.stop(); needsReconnect = true; clearMessages('Autorisez la lecture des mails pour afficher cet aperçu.');
        setStatus('La session ou l’autorisation des mails doit être renouvelée. Cliquez sur « Autoriser les mails Outlook ».', 'error');
      } else if (error.httpStatus === 403) {
        autoRefresh.stop(); accessBlocked = true; needsReconnect = true; clearMessages('Microsoft n’autorise pas encore cet aperçu des mails.');
        setStatus('L’accès Mail.ReadBasic n’est pas autorisé. Cliquez sur « Autoriser les mails Outlook » ; votre organisation peut demander un accord administrateur.', 'error');
      } else {
        if (!preserve) clearMessages('Les mails ne sont pas disponibles pour le moment.');
        if (error.httpStatus === 429) {
          retryUntil = nowMs() + error.retryAfter;
          setStatus(staleWarning(`Microsoft limite les demandes. Nouvelle tentative dans au moins ${Math.ceil(error.retryAfter / 1000)} secondes.`), 'error');
          clearTimeout(retryTimer); retryTimer = setTimeout(() => { retryUntil = 0; renderControls(); }, error.retryAfter);
        } else setStatus(staleWarning(error.name === 'AbortError' ? 'Microsoft met trop de temps à répondre. Une nouvelle tentative sera effectuée automatiquement.' : 'L’actualisation des mails a échoué. Une nouvelle tentative sera effectuée automatiquement.'), 'error');
      }
    } finally { token = null; if (generation === requestGeneration) { fetching = false; controller = null; renderControls(); } }
  }
  async function disconnect() { await clearMicrosoftSession({ application: pca, account, config, storage, window: win }); }
  const autoRefresh = (options.autoRefreshFactory || createAutoRefresh)({
    ...options.autoRefreshOptions, document: doc, window: win, nowMs,
    refresh: () => refresh(null, { automatic: true }),
    canRefresh: () => !!(account && pca && !sdkLoading && !authBusy && !fetching && !needsReconnect && !accessBlocked),
    retryAt: () => retryUntil, lastAttemptAt: () => lastRequestStartedAt, intervalMs: 60000
  });
  get('#mail-connect').addEventListener('click', connect);
  get('#mail-refresh').addEventListener('click', () => refresh());
  get('#mail-disconnect').addEventListener('click', disconnect);
  doc.querySelectorAll('[data-mail-filter]').forEach(button => button.addEventListener('click', () => {
    if (authBusy || needsReconnect || nowMs() < retryUntil) return;
    selectedFilter = button.dataset.mailFilter === 'important' ? 'important' : 'unread'; renderControls(); refresh();
  }));
  const onStorage = event => { if (event.key === OUTLOOK_CONFIG_KEY || event.key === null) configChanged(); };
  const onConfigSubmit = () => queueMicrotask(configChanged);
  const onForgetConfig = () => {
    autoRefresh.stop(); sdkGeneration++; connectionGeneration++; cancelRequests({ resetThrottle: true });
    account = null; pca = null; sdkLoading = false; needsReconnect = false; accessBlocked = false;
    clearMessages('La configuration Microsoft a été retirée. Connectez de nouveau les mails Outlook.');
    setStatus('Les mails sont masqués après le retrait de la configuration Microsoft.'); renderControls();
  };
  win.addEventListener?.('storage', onStorage);
  get('#outlook-config-form')?.addEventListener('submit', onConfigSubmit);
  get('#outlook-forget-config')?.addEventListener('click', onForgetConfig);
  clearMessages('Les sujets et les expéditeurs de vos derniers mails, sans corps ni pièces jointes.');
  setStatus('Une autorisation Mail.ReadBasic permet cet aperçu en lecture seule.'); renderControls();
  if (config) { observeSignOut(); prepareSdk(); }
  return { connect, refresh, disconnect, dispose() {
    autoRefresh.dispose(); cancelRequests({ resetThrottle: true }); unsubscribeSignOut?.(); win.removeEventListener?.('storage', onStorage);
    get('#outlook-config-form')?.removeEventListener?.('submit', onConfigSubmit); get('#outlook-forget-config')?.removeEventListener?.('click', onForgetConfig);
  } };
}

if (typeof document !== 'undefined') initializeMailPreview();
