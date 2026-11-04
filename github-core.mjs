import { INTRANET_ORIGIN } from './intranet-core.mjs';

export const GITHUB_API_URL = `${INTRANET_ORIGIN}/api/dashboard/v1/github`;
export const GITHUB_PROJECTS = Object.freeze([
  Object.freeze({ key: 'dashboard', name: 'Dashboard', repository: 'Soaresbm1/dashboard-personnel' }),
  Object.freeze({ key: 'intranet', name: 'Intranet', repository: 'ISP-SPI/intranet-laravel' })
]);
const states = ['ready', 'access_denied', 'rate_limited', 'unavailable'];
const deploymentStates = ['untracked', 'error', 'failure', 'inactive', 'in_progress', 'queued', 'pending', 'success'];
export function safeGithubUrl(value, repository) {
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password
      && url.pathname.startsWith(`/${repository}/`) ? url.href : null;
  } catch { return null; }
}
const date = value => {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? new Date(value) : null;
  return parsed && Number.isFinite(+parsed) ? parsed.toISOString() : null;
};
export function normalizeGithubOverview(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.projects) || value.projects.length !== 2) throw new Error('Invalid GitHub overview');
  return GITHUB_PROJECTS.map(project => {
    const matches = value.projects.filter(item => item?.key === project.key);
    if (matches.length !== 1) throw new Error('Invalid GitHub project');
    const raw = matches[0];
    if (raw.state === 'not_connected') return { key: project.key, state: 'not_connected' };
    if (raw.state !== 'ready' || !states.includes(raw.deployment?.state) || !states.includes(raw.pulls?.state) || !date(raw.checkedAt)) throw new Error('Invalid GitHub sections');
    const deployment = { state: raw.deployment.state };
    if (deployment.state === 'ready') {
      if (!deploymentStates.includes(raw.deployment.status)) throw new Error('Invalid deployment');
      Object.assign(deployment, { status: raw.deployment.status, at: date(raw.deployment.at), url: safeGithubUrl(raw.deployment.url, project.repository) });
    }
    const pulls = { state: raw.pulls.state };
    if (pulls.state === 'ready') {
      const { count, items, hasMore } = raw.pulls;
      if (!Number.isSafeInteger(count) || count < 0 || count > 100 || !Array.isArray(items) || items.length > 3 || items.length > count
        || typeof hasMore !== 'boolean' || (hasMore && count !== 100)) throw new Error('Invalid pull count');
      const seen = new Set();
      Object.assign(pulls, { count, hasMore, items: items.map(item => {
        if (!Number.isSafeInteger(item?.number) || item.number < 1 || seen.has(item.number) || typeof item.title !== 'string' || !item.title.trim()) throw new Error('Invalid pull');
        seen.add(item.number);
        return { number: item.number, title: item.title.trim().slice(0, 180), draft: item.draft === true,
          url: `https://github.com/${project.repository}/pull/${item.number}` };
      }) });
    }
    return { key: project.key, state: 'ready', checkedAt: date(raw.checkedAt), deployment, pulls };
  });
}
export function retainGithubOverview(next, previous) {
  return next.map(project => {
    const old = previous?.find(item => item.key === project.key);
    if (project.state !== 'ready' || old?.state !== 'ready') return project;
    const result = { ...project };
    for (const kind of ['deployment', 'pulls']) {
      if (['unavailable', 'rate_limited'].includes(project[kind].state) && old[kind].state === 'ready') {
        result[kind] = { ...old[kind], stale: true, checkedAt: old[kind].checkedAt || old.checkedAt };
      }
    }
    return result;
  });
}
export function githubDeploymentLabel(value) {
  if (value?.state !== 'ready') return value?.state === 'access_denied' ? 'Accès GitHub à renouveler'
    : value?.state === 'rate_limited' ? 'Limite GitHub atteinte' : 'Déploiement indisponible';
  return { success: 'Publication réussie', failure: 'Publication échouée', error: 'Erreur de publication',
    pending: 'Publication en attente', queued: 'Publication en attente', in_progress: 'Publication en cours',
    inactive: 'Ancienne publication', untracked: 'Publication non suivie dans GitHub' }[value.status];
}
