export const INTRANET_HEALTH_URL = 'https://raw.githubusercontent.com/Soaresbm1/dashboard-personnel/intranet-status/intranet-status.json';
export const HEALTH_MAX_AGE_MS = 15 * 60_000;
const target = 'https://intranet.isp-spi.ch/intranet';
const outcomes = ['online', 'http_error', 'auth_required', 'redirect', 'network_error'];
export function parseIntranetHealth(raw, now = Date.now()) {
  const checkedAt = typeof raw?.checkedAt === 'string' ? Date.parse(raw.checkedAt) : NaN;
  if (raw?.schemaVersion !== 1 || raw.target !== target || !Number.isFinite(checkedAt) || checkedAt > now + 120_000
    || !outcomes.includes(raw.outcome) || !Number.isFinite(raw.latencyMs) || raw.latencyMs < 0 || raw.latencyMs > 120_000) throw new Error('Invalid availability result');
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
  return { outcome: raw.outcome, httpStatus: status, error: raw.error, checkedAt, latencyMs: Math.round(raw.latencyMs) };
}
export function intranetHealthView(sample, now = Date.now(), { feedUnavailable = false, offline = false } = {}) {
  if (offline) return { state: 'unknown', label: 'Vérification hors ligne' };
  if (!sample) return { state: 'unknown', label: 'État non vérifiable' };
  if (now - sample.checkedAt > HEALTH_MAX_AGE_MS) return { state: 'unknown', label: 'Vérification ancienne' };
  if (feedUnavailable) return { state: 'unknown', label: 'Contrôle indisponible' };
  const http = sample.httpStatus === null ? '' : ` · HTTP ${sample.httpStatus}`;
  if (sample.outcome === 'online') return { state: 'online', label: `En ligne${http}` };
  if (sample.outcome === 'auth_required') return { state: 'warning', label: `Accès protégé${http}` };
  if (sample.outcome === 'redirect') return { state: 'warning', label: `Redirection${http}` };
  if (sample.outcome === 'network_error') return { state: 'error', label: { timeout: 'Délai dépassé', dns: 'Erreur DNS', tls: 'Erreur TLS', network: 'Injoignable', redirect_loop: 'Boucle de redirection' }[sample.error] };
  return { state: sample.httpStatus === 429 ? 'warning' : 'error', label: `${sample.httpStatus === 404 ? 'Page introuvable' : sample.httpStatus === 503 ? 'Indisponible' : 'Erreur'}${http}` };
}
