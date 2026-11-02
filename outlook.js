import {
  OUTLOOK_CONFIG_KEY, OUTLOOK_SCOPES, normalizeOutlookConfig, localDateKey,
  calendarWindow, calendarRequestUrl, safeGraphPage, normalizeCalendarEvents,
  groupCalendarEvents, eventTimeLabel, retryAfterMilliseconds
} from './outlook-core.mjs';

// This module deliberately keeps tokens, Microsoft account and calendar events in memory.
// Only the two public Entra application identifiers are saved in localStorage.
export function initializeOutlookAgenda(options = {}) {
  const doc = options.document || globalThis.document;
  const win = options.window || globalThis.window;
  const get = selector => doc.querySelector(selector);
  if (!get('#outlook-agenda')) return null;
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  const loadSdk = options.loadSdk || (() => import('./vendor/msal.js'));
  const now = options.now || (() => new Date());
  const redirectUri = new URL('auth-redirect.html', doc.baseURI).href;
  let storage = null, config = null, storageProblem = false;
  try {
    storage = options.storage || win.localStorage;
    const saved = storage.getItem(OUTLOOK_CONFIG_KEY);
    config = saved ? normalizeOutlookConfig(JSON.parse(saved)) : null;
    if (saved && !config) storageProblem = true;
  } catch { storageProblem = true; }
  let pca = null, sdk = null, account = null, sdkLoading = false, authBusy = false;
  let needsReconnect = false, fetching = false, selectedRange = 'today';
  let sdkGeneration = 0, connectionGeneration = 0, requestGeneration = 0;
  let controller = null, retryUntil = 0, retryTimer = null, dialogTrigger = null;
  let lastWindowDay = localDateKey(now());

  function setStatus(message, state = '') {
    get('#outlook-status').textContent = message;
    get('#outlook-status').dataset.state = state;
  }
  function message(text) {
    const element = doc.createElement('p');
    element.className = 'outlook-empty'; element.textContent = text;
    get('#outlook-events').replaceChildren(element);
  }
  function clearEvents(text) {
    get('#outlook-last-updated').textContent = '';
    message(text);
  }
  function renderControls() {
    const connected = !!account;
    const connect = get('#outlook-connect');
    connect.hidden = connected && !needsReconnect;
    connect.disabled = sdkLoading || authBusy;
    connect.textContent = !config ? 'Configurer Outlook' : sdkLoading ? 'Préparation…' : authBusy ? 'Connexion…' : needsReconnect ? 'Reconnecter Microsoft 365' : 'Connecter Microsoft 365';
    get('#outlook-refresh').hidden = !connected;
    get('#outlook-refresh').disabled = !connected || needsReconnect || fetching || authBusy || Date.now() < retryUntil;
    get('#outlook-disconnect').hidden = !connected;
    get('#outlook-disconnect').disabled = authBusy;
    get('#outlook-configure').disabled = authBusy;
    get('#outlook-account').textContent = connected ? account.username || account.name || 'Compte Microsoft 365 connecté' : 'Compte professionnel Microsoft 365';
    doc.querySelectorAll('[data-outlook-range]').forEach(button => {
      button.disabled = !connected || needsReconnect || authBusy;
      button.setAttribute('aria-pressed', String(button.dataset.outlookRange === selectedRange));
    });
    get('#outlook-events').setAttribute('aria-busy', String(fetching));
    const forget = get('#outlook-forget-config');
    if (forget) forget.hidden = !config;
  }
  function cancelRequests() {
    requestGeneration++;
    controller?.abort(); controller = null; fetching = false;
    clearTimeout(retryTimer); retryUntil = 0;
  }
  function formError(text) {
    get('#outlook-config-error').textContent = text;
    get('#outlook-config-error').hidden = !text;
  }
  function showSetup() {
    dialogTrigger = doc.activeElement;
    get('#outlook-client-id').value = config?.clientId || '';
    get('#outlook-tenant-id').value = config?.tenantId || '';
    get('#outlook-redirect-uri').value = redirectUri;
    formError('');
    get('#outlook-setup').showModal();
    const focusTarget = config ? get('#outlook-client-id') : get('#outlook-setup-title');
    if (!config) focusTarget.tabIndex = -1;
    focusTarget.focus({ preventScroll: true });
    get('#outlook-setup').scrollTop = 0;
  }
  function closeSetup() { get('#outlook-setup').close(); }

  async function clearApplicationCache(instance, currentAccount) {
    if (!instance) return;
    try {
      instance.setActiveAccount(null);
      await instance.clearCache(currentAccount ? { account: currentAccount } : undefined);
    } catch { /* Account and token references are discarded even if cache cleanup fails. */ }
  }

  async function prepareSdk() {
    if (!config) return;
    const generation = ++sdkGeneration, snapshot = { ...config };
    sdkLoading = true; pca = null;
    setStatus('Préparation de la connexion Microsoft 365…', 'loading'); renderControls();
    try {
      const library = await loadSdk();
      const application = new library.PublicClientApplication({
        auth: { clientId: snapshot.clientId, authority: `https://login.microsoftonline.com/${snapshot.tenantId}`, redirectUri },
        cache: { cacheLocation: 'memoryStorage' },
        system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } }
      });
      await application.initialize();
      if (generation !== sdkGeneration) { await clearApplicationCache(application, null); return; }
      sdk = library; pca = application;
      setStatus(storageProblem ? 'Configuration disponible pour cette session. La sauvegarde locale est indisponible.' : 'Prêt à connecter votre calendrier en lecture seule.');
    } catch {
      if (generation !== sdkGeneration) return;
      setStatus('La connexion Microsoft ne peut pas être préparée. Vérifiez votre connexion, puis réessayez.', 'error');
    } finally {
      if (generation === sdkGeneration) { sdkLoading = false; renderControls(); }
    }
  }

  function authErrorMessage(error) {
    const code = error?.errorCode || '';
    if (['user_cancelled', 'user_canceled'].includes(code)) return 'Connexion annulée. Vous pourrez réessayer quand vous le souhaitez.';
    if (['popup_window_error', 'empty_window_error', 'popup_window_timeout', 'monitor_popup_timeout'].includes(code)) return 'La fenêtre Microsoft n’a pas pu terminer la connexion. Autorisez les fenêtres de ce site ou ouvrez le dashboard directement dans votre navigateur.';
    if (['consent_required', 'access_denied'].includes(code)) return 'L’accès au calendrier n’a pas été autorisé. Votre organisation peut demander l’accord d’un administrateur.';
    if (code === 'interaction_in_progress') return 'Une connexion Microsoft est déjà en cours. Terminez ou fermez sa fenêtre avant de réessayer.';
    if (code === 'network_error') return 'Microsoft est momentanément inaccessible. Vérifiez votre connexion puis réessayez.';
    return 'La connexion Microsoft n’a pas abouti. Vérifiez les identifiants de l’application, son adresse de retour et les autorisations de votre organisation.';
  }

  async function connect() {
    if (!config) { showSetup(); return; }
    if (sdkLoading || authBusy) return;
    if (!pca) { await prepareSdk(); return; }
    const generation = ++connectionGeneration, application = pca;
    authBusy = true; cancelRequests();
    clearEvents('Connexion sécurisée à Microsoft 365…');
    setStatus('Terminez la connexion dans la fenêtre Microsoft.', 'loading'); renderControls();
    try {
      // No await before loginPopup: preserve the explicit user gesture for popup blockers.
      const response = await application.loginPopup({ scopes: [...OUTLOOK_SCOPES], redirectUri, prompt: 'select_account' });
      if (generation !== connectionGeneration) { await clearApplicationCache(application, response.account); return; }
      if (!response.account || response.account.tenantId?.toLowerCase() !== config.tenantId) throw new Error('Unexpected Microsoft tenant');
      account = response.account; needsReconnect = false;
      application.setActiveAccount(account);
      authBusy = false; renderControls();
      await refresh(response.accessToken || null);
    } catch (error) {
      if (generation !== connectionGeneration) return;
      account = null; needsReconnect = false;
      await clearApplicationCache(application, null);
      clearEvents('Votre calendrier n’est pas connecté.');
      setStatus(authErrorMessage(error), 'error');
    } finally {
      if (generation === connectionGeneration) { authBusy = false; renderControls(); }
    }
  }

  function renderEvents(events, window) {
    const fragment = doc.createDocumentFragment();
    const groups = groupCalendarEvents(events, window, now());
    for (const group of groups) {
      const section = doc.createElement('section'); section.className = 'outlook-day-group';
      const heading = doc.createElement('h3'); heading.className = 'outlook-day-heading';
      heading.textContent = new Intl.DateTimeFormat('fr-CH', { weekday: 'long', day: 'numeric', month: 'long' }).format(group.date);
      section.append(heading);
      for (const event of group.events) {
        const row = doc.createElement('article'); row.className = 'outlook-event';
        row.classList.toggle('is-all-day', event.isAllDay);
        row.classList.toggle('is-current', group.isToday && event.start <= now() && event.end > now());
        const time = doc.createElement('span'); time.className = 'outlook-event-time'; time.textContent = eventTimeLabel(event, group);
        const details = doc.createElement('div'); details.className = 'outlook-event-details';
        const title = doc.createElement(event.url ? 'a' : 'strong'); title.className = 'outlook-event-title'; title.textContent = event.title;
        if (event.url) { title.href = event.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; title.referrerPolicy = 'no-referrer'; title.setAttribute('aria-label', `${event.title} — ouvrir dans Outlook`); }
        details.append(title);
        if (event.location) { const location = doc.createElement('small'); location.className = 'outlook-event-location'; location.textContent = event.location; details.append(location); }
        row.append(time, details); section.append(row);
      }
      fragment.append(section);
    }
    if (groups.length) get('#outlook-events').replaceChildren(fragment);
    else message(selectedRange === 'week' ? 'Aucun rendez-vous cette semaine. De la place pour l’essentiel.' : 'Aucun rendez-vous aujourd’hui. Profitez de cet espace libre.');
  }

  async function refresh(accessToken = null) {
    if (!account || !pca || needsReconnect || authBusy || Date.now() < retryUntil) return;
    cancelRequests();
    const generation = requestGeneration, application = pca, signedInAccount = account;
    const window = calendarWindow(selectedRange, now());
    const abortController = new AbortController(); controller = abortController;
    fetching = true; clearEvents('Chargement de vos rendez-vous…');
    setStatus('Lecture du calendrier Outlook…', 'loading'); renderControls();
    let timeout;
    try {
      const token = accessToken || (await application.acquireTokenSilent({ account: signedInAccount, scopes: [...OUTLOOK_SCOPES], redirectUri })).accessToken;
      if (generation !== requestGeneration) return;
      if (!token) throw new Error('Missing calendar access token');
      let page = calendarRequestUrl(window), values = [], pages = 0, limited = false;
      const visited = new Set();
      while (page) {
        const safePage = safeGraphPage(page);
        if (!safePage || visited.has(safePage)) throw new Error('Unsafe calendar pagination');
        visited.add(safePage);
        timeout = setTimeout(() => abortController.abort(), 20000);
        const response = await fetcher(safePage, {
          method: 'GET', headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' },
          signal: abortController.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer'
        });
        if (generation !== requestGeneration) return;
        if (!response.ok) {
          const error = new Error('Calendar request failed');
          error.httpStatus = response.status;
          if (response.status === 429) error.retryAfter = retryAfterMilliseconds(response.headers.get('Retry-After'));
          throw error;
        }
        const body = await response.json();
        clearTimeout(timeout);
        if (generation !== requestGeneration) return;
        if (!Array.isArray(body.value)) throw new Error('Invalid calendar response');
        values.push(...body.value.slice(0, 2000 - values.length));
        page = body['@odata.nextLink'] || null; pages++;
        if (page && (pages >= 20 || values.length >= 2000)) { limited = true; break; }
      }
      const events = normalizeCalendarEvents(values).filter(event => event.start < window.end && (event.end > window.start || event.start.getTime() === event.end.getTime() && event.start >= window.start));
      if (generation !== requestGeneration) return;
      renderEvents(events, window);
      lastWindowDay = localDateKey(now());
      get('#outlook-last-updated').textContent = `Actualisé à ${new Intl.DateTimeFormat('fr-CH', { hour: '2-digit', minute: '2-digit' }).format(now())}`;
      setStatus(limited ? 'Le nombre de résultats dépasse cet aperçu. Choisissez une période plus courte ou consultez Outlook.' : `${events.length} rendez-vous · lecture seule · heures de votre appareil`, 'connected');
    } catch (error) {
      if (generation !== requestGeneration) return;
      clearEvents('Les rendez-vous ne sont pas disponibles pour le moment.');
      const interactionRequired = sdk?.InteractionRequiredAuthError && error instanceof sdk.InteractionRequiredAuthError;
      if (interactionRequired || ['interaction_required', 'login_required', 'consent_required'].includes(error?.errorCode) || error.httpStatus === 401) {
        needsReconnect = true;
        setStatus('Votre session Microsoft doit être renouvelée. Reconnectez votre compte pour afficher l’agenda.', 'error');
      } else if (error.httpStatus === 403) setStatus('Votre organisation n’autorise pas encore la lecture du calendrier. Demandez à votre administrateur l’accès délégué Calendars.ReadBasic pour cette application.', 'error');
      else if (error.httpStatus === 429) {
        retryUntil = Date.now() + error.retryAfter;
        setStatus(`Microsoft limite temporairement les demandes. Réessayez dans ${Math.ceil(error.retryAfter / 1000)} secondes.`, 'error');
        retryTimer = setTimeout(() => { retryUntil = 0; setStatus('Vous pouvez maintenant actualiser le calendrier.'); renderControls(); }, error.retryAfter);
      } else if (error.name === 'AbortError') setStatus('Microsoft met trop de temps à répondre. Réessayez avec le bouton Actualiser.', 'error');
      else setStatus('Le calendrier n’a pas pu être chargé. Vérifiez votre connexion et réessayez avec Actualiser.', 'error');
    } finally {
      clearTimeout(timeout);
      if (generation === requestGeneration) { fetching = false; controller = null; renderControls(); }
    }
  }

  async function disconnect() {
    connectionGeneration++;
    const oldAccount = account, application = pca;
    account = null; needsReconnect = false; authBusy = false; cancelRequests();
    clearEvents('Connectez votre compte pour retrouver vos prochains rendez-vous.');
    setStatus('Calendrier déconnecté de ce dashboard.'); renderControls();
    await clearApplicationCache(application, oldAccount);
  }

  get('#outlook-connect').addEventListener('click', connect);
  get('#outlook-configure').addEventListener('click', showSetup);
  get('#outlook-refresh').addEventListener('click', () => refresh());
  get('#outlook-disconnect').addEventListener('click', disconnect);
  doc.querySelectorAll('[data-outlook-range]').forEach(button => button.addEventListener('click', () => {
    selectedRange = button.dataset.outlookRange === 'week' ? 'week' : 'today';
    renderControls(); refresh();
  }));
  doc.querySelectorAll('[data-outlook-close]').forEach(button => button.addEventListener('click', closeSetup));
  get('#outlook-setup').addEventListener('close', () => { if (dialogTrigger?.isConnected) dialogTrigger.focus(); });
  get('#outlook-config-form').addEventListener('submit', async event => {
    event.preventDefault();
    const nextConfig = normalizeOutlookConfig({ clientId: get('#outlook-client-id').value, tenantId: get('#outlook-tenant-id').value });
    if (!nextConfig) { formError('Saisissez les deux identifiants au format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.'); return; }
    sdkGeneration++; connectionGeneration++;
    const application = pca, oldAccount = account;
    cancelRequests(); account = null; pca = null; config = nextConfig; needsReconnect = false;
    try { storage?.setItem(OUTLOOK_CONFIG_KEY, JSON.stringify(config)); storageProblem = !storage; }
    catch { storageProblem = true; }
    closeSetup(); clearEvents('La configuration est prête. Connectez maintenant votre compte Microsoft 365.'); renderControls();
    await clearApplicationCache(application, oldAccount);
    prepareSdk();
  });
  get('#outlook-copy-redirect').addEventListener('click', async () => {
    try { await win.navigator.clipboard.writeText(redirectUri); get('#outlook-copy-redirect').textContent = 'Adresse copiée'; }
    catch { get('#outlook-redirect-uri').focus(); get('#outlook-redirect-uri').select(); formError('Copiez l’adresse sélectionnée avec Ctrl+C (ou ⌘C).'); }
  });
  get('#outlook-forget-config')?.addEventListener('click', async () => {
    sdkGeneration++;
    await disconnect(); config = null; pca = null; sdkLoading = false;
    try { storage?.removeItem(OUTLOOK_CONFIG_KEY); } catch { storageProblem = true; }
    get('#outlook-client-id').value = ''; get('#outlook-tenant-id').value = '';
    formError(''); setStatus('Ajoutez la configuration Microsoft 365 pour connecter Outlook.'); renderControls();
  });
  doc.addEventListener('visibilitychange', () => {
    if (!doc.hidden && account && lastWindowDay !== localDateKey(now())) setStatus('Le jour a changé. Actualisez pour afficher les nouveaux rendez-vous.');
  });

  get('#outlook-redirect-uri').value = redirectUri;
  clearEvents('Vos rendez-vous professionnels, au même endroit que vos priorités.');
  setStatus(config ? 'Préparation de la connexion Microsoft 365…' : storageProblem ? 'La configuration sauvegardée est indisponible. Configurez Outlook pour continuer.' : 'Une première configuration Microsoft 365 est nécessaire.');
  renderControls();
  if (config) prepareSdk();
  return { disconnect, refresh, showSetup };
}

if (typeof document !== 'undefined') initializeOutlookAgenda();
