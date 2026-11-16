export const TECH_NEWS_URL = 'https://raw.githubusercontent.com/Soaresbm1/dashboard-personnel/tech-news-data/tech-news.json';
export const TECH_NEWS_INTERVAL_MS = 5 * 60_000;
export const TECH_NEWS_CACHE_KEY = 'dashboard.tech-news.v1';
export const TECH_NEWS_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
export const SERVICES = Object.freeze([
  { id: 'microsoft', name: 'Microsoft', url: 'https://status.cloud.microsoft/', scope: 'Signal public Microsoft : ne couvre pas tous les incidents de votre locataire Microsoft 365.' },
  { id: 'openai', name: 'OpenAI', url: 'https://status.openai.com/', api: 'https://status.openai.com/api/v2/' },
  { id: 'anthropic', name: 'Anthropic', url: 'https://status.claude.com/', api: 'https://status.claude.com/api/v2/' }
]);
const SOURCES = new Map([['www.lemondeinformatique.fr', 'Le Monde Informatique'], ['lemondeinformatique.fr', 'Le Monde Informatique'], ['www.numerama.com', 'Numerama'], ['numerama.com', 'Numerama'], ['www.lemonde.fr', 'Le Monde'], ['lemonde.fr', 'Le Monde']]);
const STATES = new Set(['operational', 'degraded', 'outage', 'maintenance', 'unknown']);
const clean = (value, max = 240) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const timestamp = (value, now) => {
  const at = typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now + 5 * 60_000 && at >= Date.UTC(2020, 0, 1) ? new Date(at).toISOString() : null;
};
function safeUrl(value, origins) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !origins.has(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
export function emptyService(config) {
  return { id: config.id, name: config.name, status: 'unknown', url: config.url, checkedAt: null, incident: null, checkFailed: true };
}
export function serviceLabel(service) {
  return ({ operational: service.id === 'microsoft' ? 'Aucun avis public' : 'Opérationnel', degraded: 'Perturbations', outage: 'Incident', maintenance: 'Maintenance', unknown: 'Non vérifié' })[service.status] || 'Non vérifié';
}
function normalizeService(raw, now) {
  const config = SERVICES.find(service => service.id === raw?.id);
  if (!config || !STATES.has(raw.status)) return null;
  const checkedAt = timestamp(raw.checkedAt, now);
  if (!checkedAt) return emptyService(config);
  let incident = null;
  if (raw.incident) {
    const title = clean(raw.incident.title), url = safeUrl(raw.incident.url, new Set([new URL(config.url).hostname]));
    if (title && url) incident = { title, url, updatedAt: timestamp(raw.incident.updatedAt, now) };
  }
  return { id: config.id, name: config.name, status: raw.status, url: config.url, checkedAt, incident, checkFailed: raw.checkFailed === true || raw.status === 'unknown' };
}
export function normalizeArticles(raw, now = Date.now()) {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error('Invalid tech articles');
  const seen = new Set(), articles = [];
  for (const item of raw) {
    const url = safeUrl(item?.url, new Set(SOURCES.keys())), title = clean(item?.title), publishedAt = timestamp(item?.publishedAt, now);
    if (!url || !title || !publishedAt || now - Date.parse(publishedAt) > 7 * 24 * 60 * 60_000) continue;
    const canonical = new URL(url); canonical.hash = '';
    for (const key of [...canonical.searchParams.keys()]) if (/^utm_|^(?:fbclid|gclid)$/i.test(key)) canonical.searchParams.delete(key);
    if (seen.has(canonical.href)) continue;
    seen.add(canonical.href);
    articles.push({ id: canonical.href, title, url: canonical.href, source: SOURCES.get(canonical.hostname), publishedAt });
  }
  return articles.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 5);
}
export function parseTechSnapshot(raw, now = Date.now()) {
  if (raw?.schemaVersion !== 1 || !timestamp(raw.generatedAt, now) || !Array.isArray(raw.services) || raw.services.length > 3) throw new Error('Invalid tech snapshot');
  const services = raw.services.map(service => normalizeService(service, now)).filter(Boolean);
  if (new Set(services.map(service => service.id)).size !== services.length) throw new Error('Duplicate tech service');
  return { schemaVersion: 1, generatedAt: timestamp(raw.generatedAt, now), services,
    articles: normalizeArticles(raw.articles, now), newsCheckedAt: timestamp(raw.newsCheckedAt, now), newsCheckFailed: raw.newsCheckFailed === true };
}
export function parseStatuspage(config, summary, incidents, now = Date.now()) {
  if (!config?.api || !summary?.status || !Array.isArray(summary.components) || !summary.components.length || !Array.isArray(incidents?.incidents)) throw new Error('Incomplete public status');
  const indicators = { none: 'operational', minor: 'degraded', major: 'outage', critical: 'outage', maintenance: 'maintenance' };
  let status = indicators[summary.status.indicator];
  if (!status) throw new Error('Unrecognized public status');
  const componentStates = new Set(['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']);
  if (summary.components.some(item => !componentStates.has(item?.status))) throw new Error('Unrecognized component state');
  if (summary.components.some(item => item.status === 'major_outage')) status = 'outage';
  else if (status === 'operational' && summary.components.some(item => ['degraded_performance', 'partial_outage'].includes(item.status))) status = 'degraded';
  else if (status === 'operational' && summary.components.some(item => item.status === 'under_maintenance')) status = 'maintenance';
  const active = [];
  for (const item of incidents.incidents) {
    if (['resolved', 'postmortem', 'completed'].includes(item?.status)) continue;
    if (!['investigating', 'identified', 'monitoring'].includes(item?.status) || !['none', 'minor', 'major', 'critical'].includes(item.impact)
        || !clean(item.name) || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id || '') || !timestamp(item.updated_at || item.created_at, now)) throw new Error('Unrecognized active incident');
    active.push(item);
  }
  if (active.some(item => ['major', 'critical'].includes(item.impact))) status = 'outage';
  else if (active.length && status === 'operational') status = 'degraded';
  const incident = active.sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at))[0];
  const incidentId = typeof incident?.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(incident.id) ? incident.id : null;
  return normalizeService({ id: config.id, status, checkedAt: new Date(now).toISOString(), checkFailed: false,
    incident: incident && incidentId ? { title: incident.name, url: `${config.url}incidents/${incidentId}`, updatedAt: incident.updated_at || incident.created_at } : null }, now);
}
export function mergeTechSnapshot(previous, incoming, now = Date.now()) {
  const next = incoming || { services: [], articles: [], newsCheckedAt: null, newsCheckFailed: true };
  const services = SERVICES.map(config => {
    const old = previous?.services.find(service => service.id === config.id), candidate = next.services.find(service => service.id === config.id);
    if (!candidate?.checkedAt || old?.checkedAt && Date.parse(candidate.checkedAt) < Date.parse(old.checkedAt)) return old || candidate || emptyService(config);
    if (candidate.status === 'unknown' && old?.checkedAt) return { ...old, checkFailed: true };
    return candidate;
  });
  const oldDate = Date.parse(previous?.newsCheckedAt || ''), newDate = Date.parse(next.newsCheckedAt || '');
  const retain = previous && (!Number.isFinite(newDate) || Number.isFinite(oldDate) && newDate < oldDate);
  return { schemaVersion: 1, generatedAt: next.generatedAt || previous?.generatedAt || new Date(now).toISOString(), services,
    articles: normalizeArticles(retain ? previous.articles : next.articles, now), newsCheckedAt: retain ? previous.newsCheckedAt : next.newsCheckedAt,
    newsCheckFailed: retain ? previous.newsCheckFailed || next.newsCheckFailed : next.newsCheckFailed };
}
export function readTechCache(value, now = Date.now()) {
  try {
    const snapshot = parseTechSnapshot(JSON.parse(value), now);
    if (now - Date.parse(snapshot.generatedAt) > TECH_NEWS_MAX_AGE_MS) return null;
    return snapshot;
  } catch { return null; }
}
export function techDate(value) {
  return value ? new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'non vérifié';
}
