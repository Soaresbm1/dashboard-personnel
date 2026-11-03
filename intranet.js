import { OUTLOOK_CONFIG_KEY, normalizeOutlookConfig, retryAfterMilliseconds } from './outlook-core.mjs';
import { INTRANET_CONFIG_KEY, INTRANET_API_URL, INTRANET_DEPLOYMENT_IDS, normalizeIntranetConfig, intranetScope, normalizeIntranetWork,
  intranetStatusLabel, intranetPriority, intranetDueLabel } from './intranet-core.mjs';
import { getMicrosoftClient, isDashboardMicrosoftAccount, getRememberedMicrosoftAccount, rememberMicrosoftAccount,
  clearMicrosoftSession, subscribeMicrosoftSignOut } from './microsoft-session.mjs';

// Work items stay in memory. Microsoft manages the persistent sign-in cache separately.
export function initializeIntranetWork(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const get = selector => doc.querySelector(selector);
  if (!get('#intranet-work')) return null;
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  const loadSdk = options.loadSdk || (() => import('./vendor/msal.js'));
  const now = options.now || (() => new Date());
  const redirectUri = new URL('auth-redirect.html', doc.baseURI).href;
  let storage = null, config = null, storageProblem = false;
  try {
    storage = options.storage || win.localStorage;
    const saved = storage.getItem(INTRANET_CONFIG_KEY);
    config = saved ? normalizeIntranetConfig(JSON.parse(saved)) : null;
    if (saved && !config) storageProblem = true;
  } catch { storageProblem = true; }
  config ||= normalizeIntranetConfig(INTRANET_DEPLOYMENT_IDS);
  let pca = null, sdk = null, account = null, work = null, selectedKind = 'tasks';
  let sdkLoading = false, authBusy = false, fetching = false, needsReconnect = false, signingOut = false;
  let sdkGeneration = 0, connectionGeneration = 0, requestGeneration = 0;
  let controller = null, retryTimer = null, retryUntil = 0, dialogTrigger = null;
  let unsubscribeSignOut = null;

  function setStatus(message, state = '') {
    get('#intranet-status').textContent = message; get('#intranet-status').dataset.state = state;
  }
  function empty(message) {
    const element = doc.createElement('p'); element.className = 'intranet-empty'; element.textContent = message;
    get('#intranet-items').replaceChildren(element);
  }
  function clearWork(message) {
    work = null; get('#intranet-last-updated').textContent = ''; empty(message);
    get('#intranet-task-count').textContent = ''; get('#intranet-ticket-count').textContent = '';
    get('#intranet-limit').hidden = true;
  }
  function controls() {
    const connected = !!account, connect = get('#intranet-connect');
    connect.hidden = connected && !needsReconnect;
    connect.disabled = sdkLoading || authBusy;
    connect.textContent = !config ? 'Configurer l’intranet' : signingOut ? 'Déconnexion…' : sdkLoading ? 'Préparation…' : authBusy ? 'Connexion…' : needsReconnect ? 'Reconnecter l’intranet' : 'Connecter l’intranet';
    get('#intranet-refresh').hidden = !connected;
    get('#intranet-refresh').disabled = !connected || needsReconnect || fetching || authBusy || Date.now() < retryUntil;
    get('#intranet-disconnect').hidden = !connected; get('#intranet-disconnect').disabled = authBusy;
    get('#intranet-configure').disabled = authBusy;
    get('#intranet-account').textContent = connected ? work?.displayName || account.username || 'Compte Microsoft connecté' : 'Tâches et tickets qui vous sont attribués';
    get('#intranet-items').setAttribute('aria-busy', String(fetching));
    doc.querySelectorAll('[data-intranet-kind]').forEach(button => {
      button.disabled = !work || fetching || authBusy;
      button.setAttribute('aria-pressed', String(button.dataset.intranetKind === selectedKind));
    });
    get('#intranet-forget-config').hidden = !config; get('#intranet-forget-config').disabled = authBusy;
  }
  function cancelRequests() {
    requestGeneration++; controller?.abort(); controller = null; fetching = false;
    clearTimeout(retryTimer); retryUntil = 0;
  }
  function formError(message) { get('#intranet-config-error').textContent = message; get('#intranet-config-error').hidden = !message; }
  function showSetup() {
    dialogTrigger = doc.activeElement;
    let calendarConfig = null;
    try { calendarConfig = normalizeOutlookConfig(JSON.parse(storage?.getItem(OUTLOOK_CONFIG_KEY) || 'null')); } catch { /* The form remains available. */ }
    get('#intranet-client-id').value = config?.clientId || calendarConfig?.clientId || INTRANET_DEPLOYMENT_IDS.clientId;
    get('#intranet-tenant-id').value = config?.tenantId || calendarConfig?.tenantId || INTRANET_DEPLOYMENT_IDS.tenantId;
    get('#intranet-api-client-id').value = config?.apiClientId || INTRANET_DEPLOYMENT_IDS.apiClientId;
    formError(''); get('#intranet-setup').showModal();
    get('#intranet-setup-title').focus({ preventScroll: true }); get('#intranet-setup').scrollTop = 0;
  }
  function closeSetup() { get('#intranet-setup').close(); }
  function clearSignedOutView(pending = false) {
    connectionGeneration++; account = null; needsReconnect = false; signingOut = Boolean(pending); authBusy = signingOut; cancelRequests();
    clearWork('Connectez votre compte pour retrouver vos tâches et vos tickets.');
    setStatus(signingOut ? 'Déconnexion de Microsoft en cours…' : 'Microsoft est déconnecté de ce dashboard.'); controls();
  }
  function bindSignOut() {
    unsubscribeSignOut?.();
    unsubscribeSignOut = subscribeMicrosoftSignOut({ config, window: win }, clearSignedOutView);
  }
  async function prepareSdk() {
    if (!config) return;
    const generation = ++sdkGeneration, snapshot = { ...config };
    sdkLoading = true; pca = null; setStatus('Préparation de la connexion à l’intranet…', 'loading'); controls();
    try {
      const { application, sdk: library } = await getMicrosoftClient({ config: snapshot, redirectUri, loadSdk, window: win });
      if (generation !== sdkGeneration) return;
      sdk = library; pca = application;
      const restored = getRememberedMicrosoftAccount({ application, config: snapshot, storage });
      sdkLoading = false;
      if (restored) {
        account = restored; needsReconnect = false; controls();
        await refresh();
      } else setStatus(storageProblem ? 'Configuration disponible pour cette session. La sauvegarde locale est indisponible.' : 'Connectez votre compte pour lire vos tâches et vos tickets.');
    } catch {
      if (generation === sdkGeneration) setStatus('La connexion Microsoft ne peut pas être préparée. Vérifiez votre connexion puis réessayez.', 'error');
    } finally { if (generation === sdkGeneration) { sdkLoading = false; controls(); } }
  }
  function connectionError(error) {
    const code = error?.errorCode || '';
    if (['user_cancelled', 'user_canceled'].includes(code)) return 'Connexion annulée. Vous pourrez réessayer quand vous le souhaitez.';
    if (code === 'interaction_in_progress') return 'Une connexion Microsoft est déjà ouverte. Terminez-la avant de connecter l’intranet.';
    if (['popup_window_error', 'empty_window_error', 'popup_window_timeout', 'monitor_popup_timeout', 'timed_out'].includes(code)) return 'La fenêtre Microsoft n’a pas pu terminer la connexion. Autorisez les fenêtres de ce site ou ouvrez le dashboard dans votre navigateur.';
    if (['consent_required', 'access_denied'].includes(code)) return 'La permission de lecture de l’intranet n’a pas été autorisée pour cette application.';
    if (code === 'dashboard_account_not_allowed') return 'Choisissez le compte personnellement affecté au dashboard pour connecter l’intranet.';
    return 'La connexion à l’intranet n’a pas abouti. Vérifiez la configuration Microsoft et réessayez.';
  }
  async function connect() {
    if (!config) { showSetup(); return; }
    if (sdkLoading || authBusy) return;
    if (!pca) { await prepareSdk(); return; }
    const generation = ++connectionGeneration, application = pca, snapshot = { ...config };
    authBusy = true; cancelRequests(); clearWork('Connexion sécurisée à Microsoft…');
    setStatus('Terminez la connexion dans la fenêtre Microsoft.', 'loading'); controls();
    try {
      // Start from the user's click, without awaiting another operation before the popup.
      const response = await application.loginPopup({ scopes: [intranetScope(snapshot)], redirectUri, prompt: 'select_account' });
      if (generation !== connectionGeneration) return;
      if (!isDashboardMicrosoftAccount(response.account, snapshot)) {
        if (response.account && !isDashboardMicrosoftAccount(response.account, INTRANET_DEPLOYMENT_IDS)) {
          try { await application.clearCache({ account: response.account }); } catch { /* Never purge the authorized account here. */ }
        }
        throw Object.assign(new Error('Unexpected Microsoft account'), { errorCode: 'dashboard_account_not_allowed' });
      }
      if (!response.accessToken) throw new Error('Invalid account response');
      rememberMicrosoftAccount({ application, account: response.account, config: snapshot, storage });
      account = response.account; needsReconnect = false;
      authBusy = false; controls(); await refresh(response.accessToken);
    } catch (error) {
      if (generation !== connectionGeneration) return;
      account = null; needsReconnect = false;
      clearWork('Vos tâches et vos tickets ne sont pas connectés.'); setStatus(connectionError(error), 'error');
    } finally { if (generation === connectionGeneration) { authBusy = false; controls(); } }
  }
  function renderItems() {
    if (!work) return;
    const values = work[selectedKind], fragment = doc.createDocumentFragment();
    for (const item of values) {
      const row = doc.createElement('article'); row.className = 'intranet-item';
      const priority = intranetPriority(item.priority); row.dataset.priority = priority.level;
      const body = doc.createElement('div'); body.className = 'intranet-item-body';
      const title = doc.createElement(item.url ? 'a' : 'strong'); title.className = 'intranet-item-title';
      title.textContent = selectedKind === 'tickets' && item.key ? `${item.key} · ${item.title}` : item.title;
      if (item.url) { title.href = item.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; title.referrerPolicy = 'no-referrer'; title.setAttribute('aria-label', `${title.textContent} — ouvrir dans l’intranet`); }
      const details = doc.createElement('div'); details.className = 'intranet-item-meta';
      const status = doc.createElement('span'); status.textContent = intranetStatusLabel(item.status); details.append(status);
      if (priority.label) { const badge = doc.createElement('span'); badge.className = 'intranet-priority'; badge.textContent = priority.label; details.append(badge); }
      body.append(title, details);
      const due = doc.createElement('span'); due.className = 'intranet-due'; due.textContent = intranetDueLabel(item.dueAt, now());
      const today = now(); today.setHours(0, 0, 0, 0); if (item.dueAt && item.dueAt < today) due.dataset.overdue = 'true';
      row.append(body, due); fragment.append(row);
    }
    if (values.length) get('#intranet-items').replaceChildren(fragment);
    else empty(selectedKind === 'tasks' ? 'Aucune tâche ouverte ne vous est attribuée.' : 'Aucun ticket ouvert ne vous est attribué.');
    get('#intranet-task-count').textContent = `(${work.tasks.length}${work.tasksHasMore ? '+' : ''})`;
    get('#intranet-ticket-count').textContent = `(${work.tickets.length}${work.ticketsHasMore ? '+' : ''})`;
    get('#intranet-limit').hidden = !(selectedKind === 'tasks' ? work.tasksHasMore : work.ticketsHasMore);
  }
  async function refresh(accessToken = null) {
    if (!account || !pca || needsReconnect || authBusy || Date.now() < retryUntil) return;
    cancelRequests();
    const generation = requestGeneration, application = pca, signedInAccount = account;
    const abortController = new AbortController(); controller = abortController;
    fetching = true; clearWork('Chargement de vos tâches et de vos tickets…'); setStatus('Lecture de l’intranet…', 'loading'); controls();
    let timeout;
    try {
      const token = accessToken || (await application.acquireTokenSilent({ account: signedInAccount, scopes: [intranetScope(config)], redirectUri })).accessToken;
      if (generation !== requestGeneration) return;
      if (!token) throw new Error('Missing intranet access token');
      timeout = setTimeout(() => abortController.abort(), 20000);
      const response = await fetcher(INTRANET_API_URL, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: abortController.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (generation !== requestGeneration) return;
      if (!response.ok) { const error = new Error('Intranet request failed'); error.httpStatus = response.status;
        if (response.status === 429) error.retryAfter = retryAfterMilliseconds(response.headers.get('Retry-After')); throw error; }
      const body = await response.json();
      if (generation !== requestGeneration) return;
      work = normalizeIntranetWork(body); renderItems();
      get('#intranet-last-updated').textContent = `Actualisé à ${new Intl.DateTimeFormat('fr-CH', { hour: '2-digit', minute: '2-digit' }).format(now())}`;
      setStatus('Vos éléments attribués · lecture seule', 'connected');
    } catch (error) {
      if (generation !== requestGeneration) return;
      clearWork('Vos tâches et vos tickets sont indisponibles pour le moment.');
      const interactionRequired = sdk?.InteractionRequiredAuthError && error instanceof sdk.InteractionRequiredAuthError;
      if (interactionRequired || ['interaction_required', 'login_required', 'consent_required'].includes(error?.errorCode) || error.httpStatus === 401) {
        needsReconnect = true; setStatus('Votre session doit être renouvelée. Reconnectez l’intranet pour afficher vos éléments.', 'error');
      } else if (error.httpStatus === 403) {
        account = null; needsReconnect = false;
        setStatus('Ce compte n’est pas autorisé à consulter cette API. Utilisez le compte personnellement affecté au dashboard.', 'error');
      } else if (error.httpStatus === 503) setStatus('La connexion n’est pas encore activée sur l’intranet. Réessayez après son activation.', 'error');
      else if (error.httpStatus === 429) {
        retryUntil = Date.now() + error.retryAfter; setStatus(`L’intranet limite temporairement les demandes. Réessayez dans ${Math.ceil(error.retryAfter / 1000)} secondes.`, 'error');
        retryTimer = setTimeout(() => { retryUntil = 0; setStatus('Vous pouvez maintenant actualiser l’intranet.'); controls(); }, error.retryAfter);
      } else if (error.name === 'AbortError') setStatus('L’intranet met trop de temps à répondre. Réessayez avec Actualiser.', 'error');
      else setStatus('L’intranet ne répond pas correctement. Vérifiez votre connexion au réseau professionnel puis réessayez.', 'error');
    } finally { clearTimeout(timeout); if (generation === requestGeneration) { fetching = false; controller = null; controls(); } }
  }
  async function disconnect() {
    const application = pca, oldAccount = account;
    connectionGeneration++;
    account = null; needsReconnect = false; signingOut = true; authBusy = true; cancelRequests();
    clearWork('Connectez votre compte pour retrouver vos tâches et vos tickets.'); setStatus('Intranet déconnecté de ce dashboard.'); controls();
    // The shared sign-out notifications own the pending state until all cache cleanup ends.
    await clearMicrosoftSession({ application, account: oldAccount, config, storage, window: win });
  }

  get('#intranet-connect').addEventListener('click', connect);
  get('#intranet-configure').addEventListener('click', showSetup);
  get('#intranet-refresh').addEventListener('click', () => refresh());
  get('#intranet-disconnect').addEventListener('click', disconnect);
  doc.querySelectorAll('[data-intranet-kind]').forEach(button => button.addEventListener('click', () => {
    selectedKind = button.dataset.intranetKind === 'tickets' ? 'tickets' : 'tasks'; renderItems(); controls();
  }));
  doc.querySelectorAll('[data-intranet-close]').forEach(button => button.addEventListener('click', closeSetup));
  get('#intranet-setup').addEventListener('close', () => { if (dialogTrigger?.isConnected) dialogTrigger.focus(); });
  get('#intranet-config-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (authBusy) { formError('Patientez pendant la connexion ou la déconnexion de Microsoft.'); return; }
    const next = normalizeIntranetConfig({ clientId: get('#intranet-client-id').value, tenantId: get('#intranet-tenant-id').value, apiClientId: get('#intranet-api-client-id').value });
    if (!next) { formError('Renseignez les trois identifiants au format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.'); return; }
    sdkGeneration++; connectionGeneration++;
    cancelRequests(); account = null; pca = null; config = next; needsReconnect = false;
    bindSignOut();
    try { storage?.setItem(INTRANET_CONFIG_KEY, JSON.stringify(config)); storageProblem = !storage; } catch { storageProblem = true; }
    closeSetup(); clearWork('La configuration est prête. Connectez maintenant votre compte.'); controls();
    prepareSdk();
  });
  get('#intranet-forget-config').addEventListener('click', async () => {
    if (authBusy) return;
    sdkGeneration++; await disconnect(); unsubscribeSignOut?.(); config = null; pca = null; sdkLoading = false;
    try { storage?.removeItem(INTRANET_CONFIG_KEY); } catch { storageProblem = true; }
    get('#intranet-api-client-id').value = ''; formError(''); setStatus('La connexion à l’intranet est à configurer.'); controls();
  });
  clearWork('Vos tâches et vos tickets professionnels, au même endroit.');
  setStatus(config ? 'Préparation de la connexion à l’intranet…' : storageProblem ? 'La configuration sauvegardée est indisponible. Configurez l’intranet pour continuer.' : 'La connexion à l’intranet est à configurer.');
  bindSignOut();
  controls(); if (config) prepareSdk();
  return { disconnect, refresh, showSetup };
}

if (typeof document !== 'undefined') initializeIntranetWork();
