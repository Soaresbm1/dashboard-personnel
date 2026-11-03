import { MICROSOFT_DEPLOYMENT, getMicrosoftClient, connectMicrosoftServices } from './microsoft-session.mjs';
import { OUTLOOK_CONFIG_KEY, normalizeOutlookConfig } from './outlook-core.mjs';
import { INTRANET_CONFIG_KEY, INTRANET_DEPLOYMENT_IDS, normalizeIntranetConfig } from './intranet-core.mjs';

export function initializeMicrosoftConnection(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const get = selector => doc.querySelector(selector);
  const banner = get('#microsoft-connection'), button = get('#microsoft-connect'), menuButton = get('#microsoft-connect-menu');
  if (!banner || !button) return null;
  const status = get('#microsoft-connection-status');
  const serviceButtons = ['outlook', 'mail', 'intranet', 'news', 'directory', 'rooms'].map(name => get(`#${name}-connect`)).filter(Boolean);
  const redirectUri = new URL('auth-redirect.html', doc.baseURI).href;
  const loadSdk = options.loadSdk || (() => import('./vendor/msal.js'));
  let storage = null;
  try { storage = options.storage || win.localStorage; } catch { /* A connection remains possible for this page. */ }
  function configuration() {
    const read = (key, normalize, fallback) => {
      try { return normalize(JSON.parse(storage?.getItem(key) || 'null')) || normalize(fallback); }
      catch { return normalize(fallback); }
    };
    return { outlook: read(OUTLOOK_CONFIG_KEY, normalizeOutlookConfig, MICROSOFT_DEPLOYMENT),
      intranet: read(INTRANET_CONFIG_KEY, normalizeIntranetConfig, INTRANET_DEPLOYMENT_IDS) };
  }
  let configs = configuration(), application = null, preparing = false, connecting = false, disposed = false, generation = 0;
  const compatible = () => configs.outlook?.clientId === configs.intranet?.clientId
    && configs.outlook?.tenantId === configs.intranet?.tenantId && configs.outlook?.tenantId === MICROSOFT_DEPLOYMENT.tenantId;
  const allConnected = () => serviceButtons.every(node => node?.hidden);
  function render() {
    banner.hidden = !preparing && !connecting && allConnected() && status.dataset.state !== 'error';
    button.disabled = preparing || connecting;
    button.textContent = preparing ? 'Préparation…' : connecting ? 'Connexion…' : 'Tout reconnecter';
    if (menuButton) menuButton.disabled = preparing || connecting;
    banner.setAttribute('aria-busy', String(preparing || connecting));
  }
  function message(text, state = '') { status.textContent = text; status.dataset.state = state; }
  async function prepare() {
    const current = ++generation; application = null; preparing = true; connecting = false;
    message('Une seule connexion pour l’agenda, les mails et l’intranet.'); render();
    if (!compatible()) {
      preparing = false;
      message('Pour tout reconnecter, Outlook et l’intranet doivent utiliser la même application Microsoft. Vérifiez leurs paramètres dans Connexions.', 'error'); render(); return;
    }
    try {
      const result = await getMicrosoftClient({ config: configs.outlook, redirectUri, loadSdk, window: win });
      if (disposed || current !== generation) return;
      application = result.application;
    } catch {
      if (disposed || current !== generation) return;
      message('La connexion Microsoft n’a pas pu être préparée. Vérifiez le réseau puis réessayez.', 'error');
    } finally { if (!disposed && current === generation) { preparing = false; render(); } }
  }
  function syncConfig() {
    if (disposed) return false;
    const next = configuration();
    if (JSON.stringify(next) === JSON.stringify(configs)) return false;
    configs = next; prepare(); return true;
  }
  async function connect() {
    if (disposed || syncConfig() || preparing || connecting) return;
    if (!application) { prepare(); return; }
    const current = ++generation, client = application, config = { ...configs.outlook };
    connecting = true; message('Terminez la connexion dans la fenêtre Microsoft. Tous les services se reconnecteront ensuite.', 'loading'); render();
    const menu = get('.connection-menu'); if (menu) menu.open = false;
    try {
      // The shared function opens the popup synchronously from this explicit click.
      await connectMicrosoftServices({ application: client, config, storage, window: win, redirectUri });
      if (disposed || current !== generation) return;
      message(allConnected() ? 'Tous les services sont reconnectés.' : 'Microsoft est connecté. Les éventuels services indisponibles sont indiqués ci-dessous.');
    } catch (error) {
      if (disposed || current !== generation) return;
      const code = error?.errorCode;
      message(['user_cancelled', 'user_canceled', 'dashboard_sign_in_cancelled'].includes(code) ? 'Connexion annulée. Vous pouvez réessayer.'
        : code === 'dashboard_account_not_allowed' ? 'Choisissez bernardo.soares@isp-spi.ch, le seul compte autorisé pour ce dashboard.'
          : code === 'interaction_in_progress' ? 'Une connexion Microsoft est déjà ouverte. Terminez sa fenêtre puis réessayez.'
            : 'La connexion n’a pas abouti. Vérifiez le réseau et les fenêtres Microsoft, puis réessayez.', 'error');
    } finally { if (!disposed && current === generation) { connecting = false; render(); } }
  }
  const Observer = options.MutationObserver || win.MutationObserver;
  const observer = Observer ? new Observer(render) : null;
  for (const node of serviceButtons) if (node) observer?.observe(node, { attributes: true, attributeFilter: ['hidden'] });
  const storageChanged = event => { if ([OUTLOOK_CONFIG_KEY, INTRANET_CONFIG_KEY, null].includes(event.key)) syncConfig(); };
  const formChanged = () => queueMicrotask(syncConfig);
  const forms = [get('#outlook-config-form'), get('#intranet-config-form')].filter(Boolean);
  const dialogs = [get('#outlook-setup'), get('#intranet-setup')].filter(Boolean);
  button.addEventListener('click', connect); menuButton?.addEventListener('click', connect);
  win.addEventListener?.('storage', storageChanged);
  win.addEventListener?.('dashboard-intranet-config-changed', syncConfig);
  for (const form of forms) form.addEventListener('submit', formChanged);
  for (const dialog of dialogs) dialog.addEventListener('close', formChanged);
  prepare();
  return { connect, dispose() {
    disposed = true; generation++; observer?.disconnect();
    button.removeEventListener('click', connect); menuButton?.removeEventListener('click', connect);
    win.removeEventListener?.('storage', storageChanged);
    win.removeEventListener?.('dashboard-intranet-config-changed', syncConfig);
    for (const form of forms) form.removeEventListener('submit', formChanged);
    for (const dialog of dialogs) dialog.removeEventListener('close', formChanged);
  } };
}

if (typeof document !== 'undefined') initializeMicrosoftConnection();
