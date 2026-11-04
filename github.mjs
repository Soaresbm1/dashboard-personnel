import { GITHUB_API_URL, GITHUB_PROJECTS, normalizeGithubOverview, retainGithubOverview, githubDeploymentLabel } from './github-core.mjs';
import { INTRANET_CONFIG_KEY, INTRANET_DEPLOYMENT_IDS, normalizeIntranetConfig, intranetScope } from './intranet-core.mjs';
import { getMicrosoftClient, getRememberedMicrosoftAccount, isDashboardMicrosoftAccount, subscribeMicrosoftSignOut, subscribeMicrosoftSignIn } from './microsoft-session.mjs';
import { createAutoRefresh } from './auto-refresh.mjs';
import { retryAfterMilliseconds } from './outlook-core.mjs';

export function initializeGithubOverview(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const get = selector => doc.querySelector(selector);
  if (!get('#github-overview')) return null;
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis), nowMs = options.autoRefreshOptions?.nowMs || Date.now;
  const loadSdk = options.loadSdk || (() => import('./vendor/msal.js'));
  const redirectUri = new URL('auth-redirect.html', doc.baseURI).href;
  let storage; try { storage = options.storage || win.localStorage; } catch { /* Central sign-in can still restore this page. */ }
  const readConfig = () => { try { return normalizeIntranetConfig(JSON.parse(storage?.getItem(INTRANET_CONFIG_KEY) || 'null')) || normalizeIntranetConfig(INTRANET_DEPLOYMENT_IDS); } catch { return normalizeIntranetConfig(INTRANET_DEPLOYMENT_IDS); } };
  let config = readConfig(), application, account, preparing = false, signingOut = false, fetching = false, blocked = false, disposed = false;
  let sdkGeneration = 0, generation = 0, controller, pendingAccount, lastGood, retryUntil = 0, lastAttempt = -Infinity, unsubscribe, unsubscribeIn;
  const auto = (options.autoRefreshFactory || createAutoRefresh)({ ...options.autoRefreshOptions, document: doc, window: win, intervalMs: 300000,
    refresh: () => refresh(), canRefresh: () => !!account && !!application && !preparing && !signingOut && !fetching && !blocked,
    retryAt: () => retryUntil, lastAttemptAt: () => lastAttempt });
  const stamp = value => new Intl.DateTimeFormat('fr-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  function status(text, state) { get('#github-status').textContent = text; get('#github-overview').dataset.state = state; }
  function controls() { get('#github-refresh').hidden = !account; get('#github-refresh').disabled = !account || preparing || signingOut || fetching || blocked || nowMs() < retryUntil; get('#github-overview').setAttribute('aria-busy', String(fetching)); }
  function clear(message) {
    lastGood = null;
    for (const project of GITHUB_PROJECTS) {
      const prefix = `#github-${project.key}`;
      get(`${prefix}-deployment`).textContent = message; get(`${prefix}-deployment`).removeAttribute('href'); get(`${prefix}-deployment`).removeAttribute('title');
      get(`${prefix}-pulls`).textContent = 'Modifications : —'; get(`${prefix}-pulls`).removeAttribute('title');
      get(`${prefix}-checked`).textContent = ''; get(prefix).dataset.state = 'unavailable';
    }
  }
  function cancel() { generation++; controller?.abort(); controller = null; fetching = false; }
  function signedOut(pending = false) {
    auto.stop(); sdkGeneration++; cancel(); account = null; pendingAccount = null; preparing = false; signingOut = !!pending; blocked = false; retryUntil = 0;
    clear('Connecter Microsoft'); status('Connectez Microsoft pour consulter le suivi des projets.', 'unavailable'); controls();
  }
  function bind() {
    unsubscribe?.(); unsubscribeIn?.();
    const bound = config;
    unsubscribe = subscribeMicrosoftSignOut({ config, window: win }, pending => { if (!disposed && bound === config) signedOut(pending); });
    unsubscribeIn = subscribeMicrosoftSignIn({ config, window: win }, identity => { if (!disposed && bound === config) return resume(identity); });
  }
  function syncConfig() {
    if (disposed) return true;
    const next = readConfig();
    if (JSON.stringify(next) === JSON.stringify(config)) return false;
    signedOut(); application = null; config = next; bind(); prepare(); return true;
  }
  async function prepare() {
    if (disposed || preparing) return;
    const sequence = ++sdkGeneration, snapshot = config; preparing = true; controls();
    try {
      const client = await getMicrosoftClient({ config: snapshot, redirectUri, loadSdk, window: win });
      if (disposed || sequence !== sdkGeneration || config !== snapshot) return;
      application = client.application; preparing = false;
      const identity = pendingAccount || getRememberedMicrosoftAccount({ application, config, storage }); pendingAccount = null;
      if (identity) await resume(identity);
    } catch { if (!disposed && sequence === sdkGeneration) status('Connexion Microsoft indisponible pour le suivi GitHub.', 'unavailable'); }
    finally { if (!disposed && sequence === sdkGeneration) { preparing = false; controls(); } }
  }
  async function resume(identity) {
    if (disposed || signingOut || !isDashboardMicrosoftAccount(identity, config) || syncConfig()) return;
    if (!application || preparing) { pendingAccount = identity; if (!preparing) await prepare(); return; }
    auto.stop(); cancel(); account = identity; blocked = false; retryUntil = 0; lastAttempt = -Infinity;
    controls(); auto.start(); await refresh();
  }
  function render(projects) {
    for (const project of projects) {
      const prefix = `#github-${project.key}`, element = get(prefix), deployment = get(`${prefix}-deployment`), pulls = get(`${prefix}-pulls`);
      element.dataset.state = project.state;
      if (project.state === 'not_connected') {
        deployment.textContent = 'Accès GitHub à connecter'; deployment.removeAttribute('href'); deployment.removeAttribute('title');
        pulls.textContent = 'Modifications : —'; pulls.removeAttribute('title'); get(`${prefix}-checked`).textContent = ''; continue;
      }
      const details = project.deployment;
      deployment.textContent = `${details.stale ? 'Dernières données · ' : ''}${githubDeploymentLabel(details)}`;
      if (details.url) deployment.href = details.url; else deployment.removeAttribute('href');
      deployment.title = details.at ? `Déploiement du ${stamp(details.at)}` : details.status === 'untracked' ? 'Aucun déploiement de production remonté dans GitHub. Les tests ne sont pas un déploiement.' : '';
      const changes = project.pulls;
      pulls.textContent = changes.state === 'ready' ? `${changes.stale ? 'Dernières données · ' : ''}${changes.count}${changes.hasMore ? '+' : ''} modification${changes.count === 1 ? '' : 's'} en attente`
        : changes.state === 'access_denied' ? 'Modifications : accès refusé' : 'Modifications indisponibles';
      if (changes.items?.length) pulls.title = changes.items.map(item => `#${item.number}${item.draft ? ' · Brouillon' : ''} · ${item.title}`).join('\n'); else pulls.removeAttribute('title');
      const dates = [project.checkedAt, details.checkedAt, changes.checkedAt].filter(Boolean).sort();
      get(`${prefix}-checked`).textContent = dates.length ? `${details.stale || changes.stale ? 'Données du' : 'Vérifié le'} ${stamp(dates[0])}` : '';
    }
  }
  async function refresh() {
    if (disposed || syncConfig() || !account || !application || preparing || signingOut || fetching || blocked || nowMs() < retryUntil) return;
    lastAttempt = nowMs(); cancel(); const sequence = generation, client = application, identity = account, snapshot = config;
    controller = new AbortController(); const abort = controller; fetching = true; controls();
    let timeout;
    try {
      const response = await client.acquireTokenSilent({ account: identity, scopes: [intranetScope(snapshot)], redirectUri });
      if (disposed || sequence !== generation) return;
      if (!response.accessToken) throw Object.assign(new Error('Missing token'), { httpStatus: 401 });
      timeout = setTimeout(() => abort.abort(), 35000);
      const result = await fetcher(GITHUB_API_URL, { method: 'GET', headers: { Authorization: `Bearer ${response.accessToken}`, Accept: 'application/json' },
        signal: abort.signal, cache: 'no-store', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (disposed || sequence !== generation) return;
      if (!result.ok) throw Object.assign(new Error('GitHub overview failed'), { httpStatus: result.status, retry: result.status === 429 ? retryAfterMilliseconds(result.headers.get('Retry-After'), nowMs()) : null });
      let projects; try { projects = normalizeGithubOverview(await result.json()); } catch { throw Object.assign(new Error('Invalid overview'), { invalidResponse: true }); }
      if (disposed || sequence !== generation) return;
      lastGood = retainGithubOverview(projects, lastGood); render(lastGood);
      status(projects.some(project => project.state === 'not_connected') ? 'Dashboard chargé. La connexion GitHub privée de l’intranet reste à terminer.' : 'Suivi GitHub actualisé automatiquement toutes les cinq minutes.', 'ready'); auto.start();
    } catch (error) {
      if (disposed || sequence !== generation) return;
      const expired = error.httpStatus === 401 || ['interaction_required', 'login_required', 'consent_required'].includes(error.errorCode), denied = error.httpStatus === 403;
      if (expired || denied) { auto.stop(); blocked = true; clear(expired ? 'Reconnecter Microsoft' : 'Accès refusé'); }
      else if (error.invalidResponse) clear('Données GitHub indisponibles');
      else if (lastGood) {
        lastGood = lastGood.map(project => project.state !== 'ready' ? project : { ...project,
          deployment: project.deployment.state === 'ready' ? { ...project.deployment, stale: true, checkedAt: project.deployment.checkedAt || project.checkedAt } : project.deployment,
          pulls: project.pulls.state === 'ready' ? { ...project.pulls, stale: true, checkedAt: project.pulls.checkedAt || project.checkedAt } : project.pulls }); render(lastGood);
      } else clear(error.httpStatus === 404 ? 'Connexion GitHub à terminer' : 'GitHub indisponible');
      if (error.httpStatus === 429) retryUntil = nowMs() + error.retry;
      status(expired ? 'Reconnectez Microsoft avec le bouton habituel.' : denied ? 'Ce compte ne peut pas consulter le suivi GitHub.'
        : lastGood ? 'Actualisation GitHub impossible. Les dernières données restent datées.' : 'Le suivi GitHub est indisponible pour le moment.', 'unavailable');
    } finally { clearTimeout(timeout); if (!disposed && sequence === generation) { fetching = false; controller = null; controls(); } }
  }
  const storageChanged = event => { if (event.key === INTRANET_CONFIG_KEY || event.key === null) syncConfig(); };
  get('#github-refresh').addEventListener('click', refresh); get('#intranet-config-form')?.addEventListener('submit', syncConfig);
  win.addEventListener?.('storage', storageChanged); win.addEventListener?.('dashboard-intranet-config-changed', syncConfig);
  clear('Connecter Microsoft'); bind(); controls(); prepare();
  return { refresh, dispose() { disposed = true; auto.dispose(); sdkGeneration++; cancel(); unsubscribe?.(); unsubscribeIn?.();
    win.removeEventListener?.('storage', storageChanged); win.removeEventListener?.('dashboard-intranet-config-changed', syncConfig);
    get('#intranet-config-form')?.removeEventListener?.('submit', syncConfig); } };
}

if (typeof document !== 'undefined') initializeGithubOverview();
