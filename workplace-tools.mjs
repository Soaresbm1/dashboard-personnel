import { INTRANET_CONFIG_KEY, INTRANET_DEPLOYMENT_IDS, normalizeIntranetConfig, intranetScope } from './intranet-core.mjs';
import { OUTLOOK_CONFIG_KEY, normalizeOutlookConfig, retryAfterMilliseconds } from './outlook-core.mjs';
import { MICROSOFT_DEPLOYMENT, getMicrosoftClient, getRememberedMicrosoftAccount, isDashboardMicrosoftAccount,
  subscribeMicrosoftSignIn, subscribeMicrosoftSignOut } from './microsoft-session.mjs';
import { createAutoRefresh } from './auto-refresh.mjs';
import { DIRECTORY_API_URL, ROOM_SCOPES, ROOM_SCHEDULE_URL, ROOM_LIMIT, normalizeDirectoryResponse, filterDirectoryPeople,
  roomListUrl, normalizeRoomsPage, roomScheduleRequests, normalizeRoomAvailability, roomAvailabilityLabel } from './workplace-core.mjs';

export function initializeWorkplaceTools(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const get = selector => doc.querySelector(selector);
  if (!get('#workplace-tools')) return null;
  const now = options.now || (() => new Date()), nowMs = options.autoRefreshOptions?.nowMs || (() => +now());
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis), loadSdk = options.loadSdk || (() => import('./vendor/msal.js'));
  const redirectUri = new URL('auth-redirect.html', doc.baseURI).href;
  const scheduleTimer = options.setTimeout || globalThis.setTimeout.bind(globalThis), cancelTimer = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  let storage = null, disposed = false;
  try { storage = options.storage || win.localStorage; } catch { /* Common sign-in also supports session-only use. */ }
  const read = (key, normalize, fallback) => {
    try { return normalize(JSON.parse(storage?.getItem(key) || 'null')) || normalize(fallback); }
    catch { return normalize(fallback); }
  };
  const listeners = [];
  function listen(node, event, callback) { node?.addEventListener?.(event, callback); listeners.push(() => node?.removeEventListener?.(event, callback)); }
  const stamp = date => new Intl.DateTimeFormat('fr-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
  function empty(id, message) { const node = doc.createElement('p'); node.className = 'workplace-empty'; node.textContent = message; get(`#${id}-items`).replaceChildren(node); }
  function externalLink(node, url) { node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; node.referrerPolicy = 'no-referrer'; }
  let directorySnapshot = null;

  function renderDirectory(snapshot) {
    directorySnapshot = snapshot;
    const matches = filterDirectoryPeople(snapshot.people, get('#directory-search').value), fragment = doc.createDocumentFragment();
    for (const person of matches.slice(0, 100)) {
      const row = doc.createElement('article'); row.className = 'workplace-person';
      const heading = doc.createElement('h3');
      const title = doc.createElement(person.url ? 'a' : 'strong'); title.className = 'workplace-name'; title.textContent = person.displayName;
      if (person.url) externalLink(title, person.url);
      const details = doc.createElement('p'); details.className = 'workplace-meta'; details.textContent = [person.jobTitle, person.department, person.location].filter(Boolean).join(' · ');
      heading.append(title); row.append(heading); if (details.textContent) row.append(details);
      if (person.email) { const email = doc.createElement('a'); email.className = 'directory-email'; email.href = `mailto:${encodeURIComponent(person.email).replace(/%40/g, '@')}`; email.textContent = person.email; row.append(email); }
      fragment.append(row);
    }
    if (matches.length) get('#directory-items').replaceChildren(fragment);
    else empty('directory', snapshot.people.length ? 'Aucun collègue ne correspond à cette recherche.' : 'Aucun contact disponible dans l’annuaire.');
    get('#directory-count').textContent = `${matches.length} ${matches.length === 1 ? 'contact' : 'contacts'}${matches.length > 100 ? ' · 100 affichés, précisez la recherche' : ''}${snapshot.hasMore ? ' · aperçu non exhaustif' : ''}`;
  }

  function updateRoomsSummary(snapshot, stale = false) {
    const count = snapshot.rooms.filter(room => room.availability === 'free').length;
    const allUnknown = snapshot.rooms.length && snapshot.rooms.every(room => room.availability === 'unknown');
    get('#rooms-summary').textContent = stale ? 'À actualiser' : allUnknown ? 'À vérifier'
      : snapshot.rooms.length ? `${count}${snapshot.hasMore ? '+' : ''} ${count === 1 ? 'libre' : 'libres'}` : 'Aucune salle';
  }
  function renderRooms(snapshot, { stale = false } = {}) {
    const fragment = doc.createDocumentFragment();
    for (const room of snapshot.rooms) {
      const row = doc.createElement('article'); row.className = 'workplace-room'; row.dataset.availability = room.availability;
      const details = doc.createElement('div'), name = doc.createElement('h3'); name.className = 'workplace-name'; name.textContent = room.displayName;
      const meta = doc.createElement('p'); meta.className = 'workplace-meta';
      meta.textContent = [room.building, room.floorLabel ? `Étage ${room.floorLabel}` : '', room.capacity ? `${room.capacity} places` : ''].filter(Boolean).join(' · ');
      details.append(name); if (meta.textContent) details.append(meta);
      const availability = doc.createElement('span'); availability.className = 'room-availability';
      availability.textContent = `${stale ? 'Dernier état : ' : ''}${roomAvailabilityLabel(room.availability)}`;
      row.append(details, availability); fragment.append(row);
    }
    if (snapshot.rooms.length) get('#rooms-items').replaceChildren(fragment);
    else empty('rooms', 'Aucune salle retournée par Microsoft 365.');
    updateRoomsSummary(snapshot, stale);
  }

  async function requestJson(url, token, signal, method = 'GET', body = null) {
    const response = await fetcher(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json', Prefer: 'outlook.timezone="UTC"' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal, redirect: 'error', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw Object.assign(new Error('Workplace request failed'), { httpStatus: response.status,
      retryAfter: response.status === 429 ? retryAfterMilliseconds(response.headers.get('Retry-After'), nowMs()) : null });
    try { return await response.json(); } catch { throw Object.assign(new Error('Invalid workplace response'), { unsafeResponse: true }); }
  }

  function createService({ id, readConfig, scopes, load, render, connectedMessage }) {
    const statusNode = get(`#${id}-status`), probe = get(`#${id}-connect`), dialog = get(`#${id}-setup`);
    let config = readConfig(), application = null, sdk = null, account = null, preparing = false, fetching = false, needsReconnect = false, blocked = false;
    let signingOut = false, sdkEpoch = 0, requestEpoch = 0, controller = null, lastGood = null, retryUntil = 0, lastAttempt = -Infinity;
    let unsubscribeSignIn, unsubscribeSignOut, pendingAccount = null;
    const auto = (options.autoRefreshFactory || createAutoRefresh)({ ...options.autoRefreshOptions, document: doc, window: win, nowMs,
      refresh: () => refresh({ automatic: true }), canRefresh: () => !disposed && !!account && !!application && !preparing && !fetching && !needsReconnect && !blocked,
      retryAt: () => retryUntil, lastAttemptAt: () => lastAttempt });
    function status(message, state = '') { statusNode.textContent = message; statusNode.dataset.state = state; }
    function controls() {
      probe.hidden = !!account && !needsReconnect;
      const reconnectPanel = dialog.querySelector?.('.workplace-reconnect');
      if (reconnectPanel) reconnectPanel.hidden = !!account && !needsReconnect && !blocked;
      get(`#${id}-items`).setAttribute('aria-busy', String(fetching));
    }
    function cancel() { requestEpoch++; controller?.abort(); controller = null; fetching = false; }
    function clear(message) {
      lastGood = null; dialog.dataset.stale = 'false'; get(`#${id}-last-updated`).textContent = ''; empty(id, message);
      if (id === 'directory') { directorySnapshot = null; get('#directory-count').textContent = ''; }
      else get('#rooms-summary').textContent = '—';
    }
    function signedOut(pending = false) {
      if (disposed) return;
      auto.stop(); sdkEpoch++; pendingAccount = null; account = null; preparing = false; signingOut = !!pending; needsReconnect = false; blocked = false;
      retryUntil = 0; cancel(); clear('Connectez Microsoft pour consulter ces informations.'); status('Utilisez « Tout reconnecter » pour retrouver vos services.'); controls();
    }
    function bindSession() {
      unsubscribeSignIn?.(); unsubscribeSignOut?.(); const bound = config;
      unsubscribeSignIn = subscribeMicrosoftSignIn({ config, window: win }, identity => {
        if (!disposed && bound === config) return resume(identity);
      });
      unsubscribeSignOut = subscribeMicrosoftSignOut({ config, window: win }, pending => {
        if (!disposed && bound === config) signedOut(pending);
      });
    }
    function syncConfig() {
      if (disposed) return false;
      const next = readConfig();
      if (JSON.stringify(next) === JSON.stringify(config)) return false;
      signedOut(); application = null; config = next; bindSession(); prepare(); return true;
    }
    async function prepare() {
      if (disposed || signingOut) return;
      const epoch = ++sdkEpoch, snapshot = { ...config }; preparing = true; controls(); status('Préparation de la connexion…', 'loading');
      try {
        const prepared = await getMicrosoftClient({ config: snapshot, redirectUri, loadSdk, window: win });
        if (disposed || epoch !== sdkEpoch) return;
        application = prepared.application; sdk = prepared.sdk; preparing = false;
        if (pendingAccount) { const identity = pendingAccount; pendingAccount = null; await resume(identity); return; }
        account = getRememberedMicrosoftAccount({ application, config: snapshot, storage });
        if (account) { auto.start(); await refresh(); }
        else status('Connectez Microsoft depuis « Tout reconnecter ».');
      } catch {
        if (!disposed && epoch === sdkEpoch) status('La connexion Microsoft est indisponible. Réessayez depuis Connexions.', 'error');
      } finally { if (!disposed && epoch === sdkEpoch) { preparing = false; controls(); } }
    }
    async function resume(identity) {
      if (disposed || signingOut || !isDashboardMicrosoftAccount(identity, config) || syncConfig()) return;
      if (preparing || !application) { pendingAccount = identity; if (!preparing) await prepare(); return; }
      auto.stop(); cancel(); account = identity; retryUntil = 0; needsReconnect = false; blocked = false; lastAttempt = -Infinity; controls(); auto.start(); await refresh();
    }
    async function refresh({ automatic = false } = {}) {
      if (disposed || syncConfig() || !application || !account || preparing || fetching || signingOut || needsReconnect || blocked || nowMs() < retryUntil) return;
      lastAttempt = nowMs(); cancel(); const epoch = requestEpoch, identity = account, client = application, snapshot = { ...config };
      controller = new AbortController(); const abort = controller; fetching = true;
      const retain = automatic && !!lastGood;
      if (!retain) { clear('Chargement…'); status('Lecture en cours…', 'loading'); }
      else if (id === 'rooms') get('#rooms-summary').textContent = 'Actualisation…';
      controls(); let timeout;
      try {
        const response = await client.acquireTokenSilent({ account: identity, scopes: scopes(snapshot), redirectUri });
        if (disposed || epoch !== requestEpoch) return;
        if (!isDashboardMicrosoftAccount(identity, snapshot) || response.account && !isDashboardMicrosoftAccount(response.account, snapshot)) {
          throw Object.assign(new Error('Unexpected owner identity'), { httpStatus: 403 });
        }
        if (!response.accessToken) throw new Error('Missing access token');
        timeout = scheduleTimer(() => abort.abort(), id === 'rooms' ? 60000 : 20000); timeout?.unref?.();
        const data = await load(response.accessToken, abort.signal, () => !disposed && epoch === requestEpoch);
        if (disposed || epoch !== requestEpoch) return;
        const at = data.checkedAt || now(), signature = JSON.stringify(id === 'rooms' ? { rooms: data.rooms, hasMore: data.hasMore } : data);
        // Leave focused links and list positions intact when the data itself has not changed.
        if (!lastGood || lastGood.signature !== signature || dialog.dataset.stale === 'true') render(data);
        else if (id === 'rooms') updateRoomsSummary(data);
        lastGood = { data, at, signature }; dialog.dataset.stale = 'false';
        get(`#${id}-last-updated`).textContent = `Actualisé à ${stamp(at)}`;
        status(connectedMessage(data), 'connected'); auto.start();
      } catch (error) {
        if (disposed || epoch !== requestEpoch) return;
        const expired = !!(sdk?.InteractionRequiredAuthError && error instanceof sdk.InteractionRequiredAuthError)
          || ['interaction_required', 'login_required', 'consent_required'].includes(error.errorCode) || error.httpStatus === 401;
        const forbidden = error.httpStatus === 403;
        const transient = !error.unsafeResponse && (error.httpStatus === 429 || error.httpStatus >= 500 || error.name === 'AbortError'
          || !error.httpStatus && (error instanceof TypeError || ['network_error', 'no_network_connectivity', 'post_request_failed', 'get_request_failed', 'timed_out'].includes(error.errorCode)));
        const keep = retain && transient && !expired && !forbidden;
        if (!keep) clear('Les données sont indisponibles pour le moment.');
        else { dialog.dataset.stale = 'true'; if (id === 'rooms') render(lastGood.data, { stale: true }); }
        if (expired || forbidden) {
          auto.stop(); needsReconnect = expired || id === 'rooms' && forbidden; blocked = forbidden;
          status(id === 'rooms' ? 'Reconnectez Microsoft. Si l’accès reste refusé, la permission de lecture des salles doit être accordée.'
            : expired ? 'Reconnectez Microsoft pour retrouver l’annuaire.' : 'Ce compte n’est pas autorisé à consulter l’annuaire.', 'error');
        } else {
          if (error.httpStatus === 429) retryUntil = nowMs() + error.retryAfter;
          status(keep ? `Actualisation impossible. Dernières données reçues à ${stamp(lastGood.at)}.`
            : error.httpStatus === 404 || error.httpStatus === 503 ? 'Ce service n’est pas encore disponible.' : 'Lecture impossible. Réessayez depuis le réseau professionnel.', 'error');
        }
      } finally { cancelTimer(timeout); if (!disposed && epoch === requestEpoch) { fetching = false; controller = null; controls(); } }
    }
    const configSubmitted = () => queueMicrotask(syncConfig);
    for (const selector of ['#outlook-config-form', '#intranet-config-form']) listen(get(selector), 'submit', configSubmitted);
    for (const selector of ['#outlook-setup', '#intranet-setup']) listen(get(selector), 'close', configSubmitted);
    const storageChanged = event => { if ([OUTLOOK_CONFIG_KEY, INTRANET_CONFIG_KEY, null].includes(event.key)) syncConfig(); };
    listen(win, 'storage', storageChanged); listen(win, 'dashboard-intranet-config-changed', syncConfig);
    listen(get(`#${id}-open`), 'click', () => {
      if (disposed) return;
      if (!dialog.open) dialog.showModal();
      if (id === 'directory') get('#directory-search').focus?.();
      if (lastGood && nowMs() - +lastGood.at > 90000) {
        dialog.dataset.stale = 'true'; if (id === 'rooms') render(lastGood.data, { stale: true });
        status(`Dernières données reçues à ${stamp(lastGood.at)}. Actualisation en cours.`, 'stale');
      }
      if (!lastGood || nowMs() - lastAttempt >= 60000) refresh({ automatic: !!lastGood });
    });
    listen(get(`#${id}-close`), 'click', () => dialog.close());
    clear('Ces informations apparaîtront après connexion.'); bindSession(); controls(); prepare();
    return { refresh, dispose() { auto.dispose(); sdkEpoch++; pendingAccount = null; cancel(); unsubscribeSignIn?.(); unsubscribeSignOut?.(); clear('Ce service est fermé.'); } };
  }

  const directory = createService({ id: 'directory', readConfig: () => read(INTRANET_CONFIG_KEY, normalizeIntranetConfig, INTRANET_DEPLOYMENT_IDS),
    scopes: config => [intranetScope(config)], render: renderDirectory,
    load: async (token, signal) => {
      const value = await requestJson(DIRECTORY_API_URL, token, signal);
      try { return normalizeDirectoryResponse(value); } catch { throw Object.assign(new Error('Invalid directory response'), { unsafeResponse: true }); }
    }, connectedMessage: snapshot => snapshot.hasMore ? 'Aperçu non exhaustif. Consultez l’annuaire complet dans l’intranet.' : 'Recherchez un collègue par nom, fonction, service ou mail.' });
  const rooms = createService({ id: 'rooms', readConfig: () => read(OUTLOOK_CONFIG_KEY, normalizeOutlookConfig, MICROSOFT_DEPLOYMENT),
    scopes: () => [...ROOM_SCOPES], render: renderRooms,
    load: async (token, signal, current) => {
      let url = roomListUrl(), hasMore = false; const catalog = [], seenIds = new Set(), seenEmails = new Set(), seenUrls = new Set();
      // Cap page count separately: empty/duplicate pages cannot create an unbounded walk.
      for (let pageCount = 0; url && pageCount < 20; pageCount++) {
        if (!current()) throw new DOMException('Cancelled', 'AbortError');
        if (seenUrls.has(url)) throw Object.assign(new Error('Cyclic room continuation'), { unsafeResponse: true });
        seenUrls.add(url);
        const raw = await requestJson(url, token, signal); let page;
        try { page = normalizeRoomsPage(raw); } catch { throw Object.assign(new Error('Invalid room response'), { unsafeResponse: true }); }
        for (const room of page.rooms) {
          if (seenIds.has(room.id) || room.email && seenEmails.has(room.email)) continue;
          if (catalog.length >= ROOM_LIMIT) { hasMore = true; break; }
          seenIds.add(room.id); if (room.email) seenEmails.add(room.email); catalog.push(room);
        }
        hasMore ||= page.hasMore; url = page.next;
        if (catalog.length >= ROOM_LIMIT) { hasMore ||= !!url; break; }
      }
      hasMore ||= !!url;
      const responses = [], checkedAt = now(), windowEnd = new Date(+checkedAt + 1800000);
      for (const body of roomScheduleRequests(catalog, checkedAt)) {
        if (!current()) throw new DOMException('Cancelled', 'AbortError');
        const raw = await requestJson(ROOM_SCHEDULE_URL, token, signal, 'POST', body);
        if (!Array.isArray(raw?.value)) throw Object.assign(new Error('Invalid schedule response'), { unsafeResponse: true });
        // Retain only free/busy strings. Subjects, organizers and scheduleItems are deliberately discarded.
        responses.push({ value: raw.value.map(item => ({ scheduleId: item?.scheduleId, availabilityView: item?.availabilityView, error: !!item?.error })) });
      }
      let items;
      try { items = normalizeRoomAvailability(catalog, responses); } catch { throw Object.assign(new Error('Invalid availability response'), { unsafeResponse: true }); }
      return { rooms: items, hasMore, checkedAt, windowStart: checkedAt, windowEnd };
    }, connectedMessage: snapshot => {
      if (!snapshot.rooms.length) return `Aucune salle retournée par Microsoft 365.${snapshot.hasMore ? ' Liste partielle.' : ''}`;
      const time = date => new Intl.DateTimeFormat('fr-CH', { hour: '2-digit', minute: '2-digit' }).format(date);
      const unknown = snapshot.rooms.filter(room => room.availability === 'unknown').length;
      return `Disponibilités du créneau ${time(snapshot.windowStart)}–${time(snapshot.windowEnd)}.${unknown ? ` ${unknown} ${unknown === 1 ? 'disponibilité inconnue' : 'disponibilités inconnues'}.` : ''}${snapshot.hasMore ? ' Liste partielle.' : ''}`;
    } });
  listen(get('#directory-search'), 'input', () => { if (directorySnapshot) renderDirectory(directorySnapshot); });
  for (const button of doc.querySelectorAll('[data-workplace-reconnect]')) listen(button, 'click', () => {
    get('#directory-setup').close(); get('#rooms-setup').close();
    (get('#microsoft-connect-menu') || get('#microsoft-connect'))?.click();
  });
  return { directory, rooms, dispose() {
    if (disposed) return; disposed = true; directory.dispose(); rooms.dispose(); directorySnapshot = null;
    for (const unlisten of listeners) unlisten();
  } };
}

if (typeof document !== 'undefined') initializeWorkplaceTools();
