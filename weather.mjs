import { createAutoRefresh } from './auto-refresh.mjs';
import { WEATHER_URL, WEATHER_INTERVAL_MS, WEATHER_MAX_AGE_MS, parseWeather, canShowWeather, formatTemperature, weatherTime } from './weather-core.mjs';

const get = id => document.getElementById(id);
const summary = get('summary-weather');
let lastGood = null, lastAttemptAt = -Infinity, inFlight = false, controller = null;
let disposed = false;
let expiryTimer = null;

// Expire displayed conditions even if an offline browser cannot make another request.
function watchExpiry() {
  clearTimeout(expiryTimer);
  if (disposed || document.hidden || !lastGood) return;
  expiryTimer = setTimeout(() => {
    if (!canShowWeather(lastGood)) { lastGood = null; unavailable(); }
    else watchExpiry();
  }, Math.max(1, Math.min(60_000, lastGood.validAt + WEATHER_MAX_AGE_MS - Date.now() + 1)));
}

function render(weather, stale = false) {
  summary.dataset.state = stale ? 'stale' : 'ready';
  get('weather-temperature').textContent = `${formatTemperature(weather.temperature)}C`;
  get('weather-condition').textContent = weather.condition;
  const range = weather.minimum === null ? 'Min. / max. indisponibles' : `Min. ${formatTemperature(weather.minimum)} · Max. ${formatTemperature(weather.maximum)}`;
  get('weather-detail').textContent = stale ? `Dernier relevé à ${weatherTime(weather.validAt)}` : range;
  get('weather-detail').title = stale ? range : `Conditions à ${weatherTime(weather.validAt)} · Neuchâtel, Suisse`;
  get('weather-status').textContent = `${weather.condition}, ${formatTemperature(weather.temperature)}C. ${stale ? 'Actualisation impossible ; dernier relevé' : 'Conditions'} à ${weatherTime(weather.validAt)}. ${range}.`;
}

function unavailable() {
  summary.dataset.state = 'unavailable';
  get('weather-temperature').textContent = '—';
  get('weather-condition').textContent = '';
  get('weather-detail').textContent = 'Météo indisponible';
  get('weather-detail').removeAttribute('title');
  get('weather-status').textContent = 'Météo de Neuchâtel indisponible. Nouvelle tentative automatique.';
}

async function refreshWeather() {
  if (disposed || inFlight || document.hidden || navigator.onLine === false) return;
  inFlight = true;
  lastAttemptAt = Date.now();
  controller = new AbortController();
  const timeout = setTimeout(() => controller?.abort(), 12_000);
  try {
    const response = await fetch(WEATHER_URL, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('weather_request_failed');
    const weather = parseWeather(await response.json());
    if (disposed) return;
    lastGood = weather;
    render(weather);
    watchExpiry();
  } catch {
    if (disposed) return;
    if (canShowWeather(lastGood)) render(lastGood, true); else { lastGood = null; unavailable(); }
  } finally {
    clearTimeout(timeout);
    controller = null;
    inFlight = false;
  }
}

const autoRefresh = createAutoRefresh({ document, window, refresh: refreshWeather,
  intervalMs: WEATHER_INTERVAL_MS, minResumeDelayMs: 30_000, lastAttemptAt: () => lastAttemptAt,
  canRefresh: () => !inFlight && Date.now() - lastAttemptAt >= WEATHER_INTERVAL_MS });

function environmentChanged() {
  clearTimeout(expiryTimer);
  if (document.hidden) return;
  if (!canShowWeather(lastGood) && lastGood) { lastGood = null; unavailable(); }
  if (navigator.onLine === false && lastGood) render(lastGood, true);
  watchExpiry();
  if (navigator.onLine !== false && Date.now() - lastAttemptAt >= WEATHER_INTERVAL_MS) void refreshWeather();
}
document.addEventListener('visibilitychange', environmentChanged);
window.addEventListener('online', environmentChanged);
window.addEventListener('offline', environmentChanged);
window.addEventListener('pageshow', environmentChanged);
window.addEventListener('pagehide', event => {
  // A bfcache page resumes its scheduler on pageshow; permanent teardown aborts the request.
  if (event.persisted) return;
  disposed = true;
  controller?.abort();
  clearTimeout(expiryTimer);
  autoRefresh.dispose();
  document.removeEventListener('visibilitychange', environmentChanged);
  window.removeEventListener('online', environmentChanged);
  window.removeEventListener('offline', environmentChanged);
  window.removeEventListener('pageshow', environmentChanged);
});
if (navigator.onLine === false) unavailable();
void refreshWeather();
autoRefresh.start();
