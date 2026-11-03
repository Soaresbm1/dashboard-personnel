// Public configuration and pure display helpers. Never stores credentials or work items.
export const INTRANET_CONFIG_KEY = 'mon-espace-intranet-config-v1';
export const INTRANET_ORIGIN = 'https://intranet.isp-spi.ch';
export const INTRANET_API_URL = `${INTRANET_ORIGIN}/api/dashboard/v1/work`;
// Public registration IDs for this personal deployment and its setup form.
export const INTRANET_DEPLOYMENT_IDS = Object.freeze({
  clientId: 'bd2a054b-f9ea-4740-b90c-16a132f90bc4',
  tenantId: '0b394bfa-2e05-46ef-9a28-487a32ca0014',
  apiClientId: '53356502-39a9-405a-8149-2670544757ee'
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const text = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';

export function normalizeIntranetConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const config = Object.fromEntries(['clientId', 'tenantId', 'apiClientId'].map(key => [key, text(value[key], 100).toLowerCase()]));
  return Object.values(config).every(id => UUID.test(id) && id !== ZERO_UUID) ? config : null;
}

export function intranetScope(config) { return `api://${config.apiClientId}/Dashboard.Read`; }

export function safeIntranetItemUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value, INTRANET_ORIGIN);
    return url.origin === INTRANET_ORIGIN && !url.username && !url.password
      && ['/intranet/mes-taches', '/intranet/taches-equipe', '/intranet/demandes-equipe', '/intranet/mes-tickets'].includes(url.pathname)
      ? url.href : null;
  } catch { return null; }
}

export function normalizeIntranetWork(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.tasks) || !Array.isArray(value.tickets)) throw new Error('Invalid intranet response');
  const normalizeItems = values => {
    const seen = new Set(), items = [];
    for (const entry of values.slice(0, 1000)) {
      if (!entry || typeof entry !== 'object') continue;
      const id = Number.isSafeInteger(entry.id) && entry.id > 0 ? String(entry.id) : text(entry.id, 120);
      const title = text(entry.title, 300);
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      const rawDue = typeof entry.dueAt === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(entry.dueAt) ? new Date(entry.dueAt) : null;
      items.push({ id, title, key: text(entry.key, 40), status: text(entry.status, 40), priority: text(entry.priority, 40),
        dueAt: rawDue && Number.isFinite(rawDue.getTime()) ? rawDue : null, url: safeIntranetItemUrl(entry.url) });
    }
    return items;
  };
  return {
    displayName: text(value.account?.displayName, 150), tasks: normalizeItems(value.tasks), tickets: normalizeItems(value.tickets),
    tasksHasMore: value.meta?.tasksHasMore === true || value.tasks.length > 1000,
    ticketsHasMore: value.meta?.ticketsHasMore === true || value.tickets.length > 1000
  };
}

export function intranetStatusLabel(status) {
  const labels = { inbox: 'À organiser', to_do: 'À faire', in_progress: 'En cours', done: 'Terminée', waiting: 'En attente',
    cancelled: 'Annulée', refused: 'Refusée', open: 'Ouvert', resolved: 'Résolu' };
  return Object.hasOwn(labels, status) ? labels[status] : 'Statut à consulter';
}

export function intranetPriority(priority) {
  if (['blocked', 'urgent', 'critical'].includes(priority)) return { label: 'Bloquant', level: 'urgent' };
  if (['degraded', 'high'].includes(priority)) return { label: 'Prioritaire', level: 'high' };
  if (['normal', 'medium', 'low'].includes(priority)) return { label: priority === 'low' ? 'Faible' : 'Normal', level: 'normal' };
  return { label: '', level: 'normal' };
}

export function intranetDueLabel(date, now = new Date()) {
  if (!date) return 'Sans échéance';
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (+day === +today) return 'Aujourd’hui';
  const formatted = new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'short', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(date);
  return day < today ? `En retard · ${formatted}` : `Pour le ${formatted}`;
}
