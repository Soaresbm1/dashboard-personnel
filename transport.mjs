import { createAutoRefresh } from './auto-refresh.mjs';
import { TRANSPORT_URL, TRANSPORT_STOP, TRANSPORT_INTERVAL_MS, TRANSPORT_MAX_AGE_MS, parseStationboard, upcomingDepartures, departureCountdown, transportTime, transportRetryAt } from './transport-core.mjs';

const get = id => document.getElementById(id);
const dialog = get('transport-setup'), list = get('transport-items'), openButton = get('transport-open');
const inlineSummary = get('summary-transport'), inlineList = get('transport-inline-items');
let departures = null, checkedAt = 0, lastAttemptAt = -Infinity, retryAt = 0;
let failed = false, inFlight = false, disposed = false, controller = null, tick = null;
const make = (tag, className, content) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
};

function renderInline(current, { state, stale, usable, status, now }) {
  inlineSummary.dataset.state = state;
  const notice = get('transport-inline-status');
  notice.className = stale ? 'transport-inline-notice' : 'sr-only';
  if (notice.textContent !== status) notice.textContent = status;
  if (!usable || !current.length) {
    inlineList.replaceChildren(make('li', 'transport-inline-empty', !usable ? (state === 'loading' ? 'Chargement des prochains bus…' : 'Horaires indisponibles · nouvelle tentative automatique') : 'Aucun prochain départ dans les horaires reçus.'));
    return;
  }
  const rows = current.slice(0, 3).map(item => {
    const row = make('li', 'transport-inline-row');
    const destination = make('span', 'transport-inline-destination', item.destination);
    destination.title = item.destination;
    const timing = make('span', 'transport-inline-timing');
    const departure = make('time', '', transportTime(item.expectedAt));
    departure.dateTime = new Date(item.expectedAt).toISOString();
    const kind = item.hasPrediction ? 'Prévision' : item.delay !== null && item.delay !== 0 ? 'Horaire ajusté' : 'Horaire prévu';
    row.title = `${item.line} → ${item.destination} · ${kind} ${transportTime(item.expectedAt)} · départ prévu ${transportTime(item.plannedAt)}${item.delay > 0 ? ` · retard ${item.delay} min` : ''}`;
    if (item.delay > 0) destination.append(make('span', 'transport-inline-delay', `+${item.delay} min`));
    timing.append(departure, make('span', 'transport-inline-countdown', stale ? 'Reçu' : departureCountdown(item, now)));
    row.append(make('span', 'transport-inline-line', item.line), destination, timing);
    return row;
  });
  inlineList.replaceChildren(...rows);
}

function render() {
  const now = Date.now(), usable = departures !== null && now - checkedAt <= TRANSPORT_MAX_AGE_MS;
  if (!usable && departures !== null) departures = null;
  const stale = usable && (failed || navigator.onLine === false);
  const current = usable ? upcomingDepartures(departures, now) : [];
  dialog.dataset.state = usable ? (stale ? 'stale' : 'ready') : (inFlight && !failed ? 'loading' : 'unavailable');
  get('transport-status').dataset.state = dialog.dataset.state;
  openButton.title = current.length && !stale ? `${TRANSPORT_STOP.name} · ${current[0].line} → ${current[0].destination} · ${transportTime(current[0].expectedAt)}` : `Prochains départs de ${TRANSPORT_STOP.name}`;
  const status = !usable ? (inFlight && !failed ? 'Chargement des départs…' : 'Horaires indisponibles. Nouvelle tentative automatique.')
    : stale ? `Actualisation impossible. Derniers horaires reçus à ${transportTime(checkedAt)}.`
    : `${current.length} prochain${current.length === 1 ? '' : 's'} départ${current.length === 1 ? '' : 's'} · prévisions lorsqu’elles sont disponibles`;
  if (get('transport-status').textContent !== status) get('transport-status').textContent = status;
  get('transport-last-updated').textContent = usable ? `Actualisé à ${transportTime(checkedAt)}` : '';
  renderInline(current, { state: dialog.dataset.state, stale, usable, status, now });
  if (!usable || !current.length) {
    list.replaceChildren(make('p', 'workplace-empty', !usable ? (inFlight && !failed ? 'Chargement des prochains bus…' : 'Les départs seront affichés dès que les horaires seront disponibles.') : 'Aucun prochain départ dans les horaires reçus.'));
    return;
  }
  const rows = current.map(item => {
    const row = make('article', 'transport-departure');
    const body = make('div', 'transport-destination');
    body.append(make('h3', '', item.destination));
    const timing = item.hasPrediction ? 'Prévision' : item.delay !== null && item.delay !== 0 ? 'Horaire ajusté' : 'Horaire prévu';
    const delay = item.delay > 0 ? ` · +${item.delay} min` : '';
    body.append(make('p', '', `${timing} · ${transportTime(item.expectedAt)}${delay}${item.platform ? ` · Quai ${item.platform}` : ''}`));
    const right = make('div', 'transport-time', stale ? 'Dernier horaire' : departureCountdown(item, now));
    const planned = make('time', '', `${transportTime(item.plannedAt)} prévu`);
    planned.dateTime = new Date(item.plannedAt).toISOString();
    right.append(planned);
    row.append(make('span', 'transport-line', item.line), body, right);
    return row;
  });
  list.replaceChildren(...rows);
}

function armTick() {
  clearTimeout(tick);
  if (disposed || document.hidden || departures === null) return;
  tick = setTimeout(() => { render(); armTick(); }, 15_000);
}

async function refreshTransport() {
  if (disposed || inFlight || document.hidden || navigator.onLine === false || Date.now() < retryAt) return;
  inFlight = true; lastAttemptAt = Date.now();
  const activeController = new AbortController(); controller = activeController;
  const timeout = setTimeout(() => activeController.abort(), 12_000);
  list.setAttribute('aria-busy', 'true');
  inlineList.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(TRANSPORT_URL, { signal: activeController.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) {
      if (response.status === 429 || response.status === 503) {
        retryAt = transportRetryAt(response.headers?.get('Retry-After'));
      }
      throw new Error('transport_request_failed');
    }
    const parsed = parseStationboard(await response.json());
    if (disposed) return;
    departures = parsed; checkedAt = Date.now(); failed = false; retryAt = 0;
  } catch {
    if (!disposed) failed = true;
  } finally {
    clearTimeout(timeout); controller = null; inFlight = false;
    if (!disposed) { list.setAttribute('aria-busy', 'false'); inlineList.setAttribute('aria-busy', 'false'); render(); armTick(); }
  }
}

const autoRefresh = createAutoRefresh({ document, window, refresh: refreshTransport, intervalMs: TRANSPORT_INTERVAL_MS,
  minResumeDelayMs: 10_000, lastAttemptAt: () => lastAttemptAt, retryAt: () => retryAt,
  canRefresh: () => !inFlight && Date.now() - lastAttemptAt >= TRANSPORT_INTERVAL_MS });

function environmentChanged() {
  clearTimeout(tick);
  if (document.hidden) return;
  render(); armTick();
  if (navigator.onLine !== false && Date.now() - lastAttemptAt >= TRANSPORT_INTERVAL_MS) void refreshTransport();
}
openButton.addEventListener('click', () => {
  render(); dialog.showModal(); get('transport-close').focus();
  if (Date.now() - lastAttemptAt >= TRANSPORT_INTERVAL_MS) void refreshTransport();
});
get('transport-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => openButton.focus());
document.addEventListener('visibilitychange', environmentChanged);
for (const event of ['online', 'offline', 'pageshow']) window.addEventListener(event, environmentChanged);
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  disposed = true; controller?.abort(); clearTimeout(tick); autoRefresh.dispose();
  document.removeEventListener('visibilitychange', environmentChanged);
  for (const name of ['online', 'offline', 'pageshow']) window.removeEventListener(name, environmentChanged);
});
if (navigator.onLine === false) { failed = true; render(); }
void refreshTransport();
autoRefresh.start();
