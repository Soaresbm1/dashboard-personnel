export const INTRANET_HEALTH_URL = 'https://intranet.isp-spi.ch/dashboard-intranet-status.php';
export const HEALTH_INTERVAL_MS = 5 * 60_000;
export const HEALTH_MAX_AGE_MS = 15 * 60_000;
export const INTRANET_HEALTH_CACHE_KEY = 'dashboard.intranet-health.last.v1';
const target = 'https://intranet.isp-spi.ch/intranet';
const outcomes = ['online', 'http_error', 'auth_required', 'redirect', 'network_error'];
export function parseIntranetHealth(raw, now = Date.now()) {
  const checkedAt = typeof raw?.checkedAt === 'string' ? Date.parse(raw.checkedAt) : NaN;
  if (raw?.schemaVersion !== 1 || raw.target !== target || !Number.isFinite(checkedAt) || checkedAt > now + 120_000
    || !outcomes.includes(raw.outcome) || !Number.isFinite(raw.latencyMs) || raw.latencyMs < 0 || raw.latencyMs > 120_000
    || (raw.checkFailed !== undefined && typeof raw.checkFailed !== 'boolean')) throw new Error('Invalid availability result');
  const status = raw.httpStatus;
  if (raw.outcome === 'network_error') {
    if (status !== null || !['timeout', 'dns', 'tls', 'network', 'redirect_loop'].includes(raw.error)) throw new Error('Invalid network result');
  } else {
    if (!Number.isInteger(status) || status < 100 || status > 599 || raw.error !== null
      || (raw.outcome === 'online' && (status < 200 || status >= 300))
      || (raw.outcome === 'auth_required' && ![401, 403].includes(status))
      || (raw.outcome === 'redirect' && ![301, 302, 303, 307, 308].includes(status))
      || (raw.outcome === 'http_error' && ((status >= 200 && status < 300) || [301, 302, 303, 307, 308, 401, 403].includes(status)))) throw new Error('Invalid HTTP result');
  }
  const hasApplicationCheck = raw.entryHttpStatus !== undefined || raw.applicationHttpStatus !== undefined;
  if (hasApplicationCheck && (! [301, 302, 303, 307, 308].includes(raw.entryHttpStatus) || raw.applicationHttpStatus !== status || status === null)) throw new Error('Invalid application check');
  return { outcome: raw.outcome, httpStatus: status, error: raw.error, checkedAt, latencyMs: Math.round(raw.latencyMs),
    ...(hasApplicationCheck ? { entryHttpStatus: raw.entryHttpStatus, applicationHttpStatus: raw.applicationHttpStatus } : {}) };
}
export function intranetHealthView(sample, now = Date.now(), { feedUnavailable = false, offline = false } = {}) {
  if (!sample) return { state: 'unknown', label: '—', description: 'Aucun statut connu', retained: false };
  const retained = offline || feedUnavailable || now - sample.checkedAt > HEALTH_MAX_AGE_MS;
  const result = (state, label, description) => ({ state, label, description, retained });
  const http = sample.httpStatus === null ? '' : ` · HTTP ${sample.httpStatus}`;
  if (sample.outcome === 'online') return result('online', 'En ligne', `En ligne${http}`);
  if (sample.outcome === 'auth_required') return result('error', `HTTP ${sample.httpStatus}`, `Accès protégé${http}`);
  if (sample.outcome === 'redirect') return result('error', `HTTP ${sample.httpStatus}`, `Redirection${http}`);
  if (sample.outcome === 'network_error') {
    const label = { timeout: 'Délai dépassé', dns: 'Erreur DNS', tls: 'Erreur TLS', network: 'Injoignable', redirect_loop: 'Redirection' }[sample.error];
    return result('error', label, sample.error === 'redirect_loop' ? 'Boucle de redirection' : label);
  }
  return result('error', `HTTP ${sample.httpStatus}`, `${sample.httpStatus === 404 ? 'Page introuvable' : sample.httpStatus === 503 ? 'Indisponible' : 'Erreur'}${http}`);
}
