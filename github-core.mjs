import { INTRANET_ORIGIN } from './intranet-core.mjs';

export const GITHUB_API_URL = `${INTRANET_ORIGIN}/api/dashboard/v1/github`;
export const GITHUB_OWNER = 'Soaresbm1';
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
  if (!value || value.schemaVersion !== 2 || value.owner !== GITHUB_OWNER || ![...states, 'not_connected'].includes(value.state)
    || !Array.isArray(value.projects) || value.projects.length > 30 || typeof value.hasMore !== 'boolean' || !date(value.checkedAt)) throw new Error('Invalid GitHub overview');
  const result = { owner: GITHUB_OWNER, state: value.state, projects: [], hasMore: value.hasMore, checkedAt: date(value.checkedAt) };
  if (value.state !== 'ready') {
    if (value.projects.length) throw new Error('Unexpected private data');
    return result;
  }
  const seen = new Set();
  result.projects = value.projects.map(raw => {
    if (!raw || typeof raw.name !== 'string' || !/^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(raw.name)
      || raw.repository !== `${GITHUB_OWNER}/${raw.name}` || seen.has(raw.name.toLowerCase())
      || typeof raw.private !== 'boolean' || typeof raw.archived !== 'boolean' || !date(raw.checkedAt)
      || !states.includes(raw.deployment?.state) || !states.includes(raw.pulls?.state)) throw new Error('Invalid GitHub repository');
    seen.add(raw.name.toLowerCase());
    const deployment = { state: raw.deployment.state };
    if (deployment.state === 'ready') {
      if (!deploymentStates.includes(raw.deployment.status)) throw new Error('Invalid deployment');
      Object.assign(deployment, { status: raw.deployment.status, at: date(raw.deployment.at),
        url: safeGithubUrl(raw.deployment.url, raw.repository), environment: typeof raw.deployment.environment === 'string' ? raw.deployment.environment.slice(0, 80) : '' });
    }
    const pulls = { state: raw.pulls.state };
    if (pulls.state === 'ready') {
      const { count, items, hasMore } = raw.pulls;
      if (!Number.isSafeInteger(count) || count < 0 || count > 100 || !Array.isArray(items) || items.length > 3 || items.length > count
        || typeof hasMore !== 'boolean' || (hasMore && count !== 100)) throw new Error('Invalid pull count');
      const numbers = new Set();
      Object.assign(pulls, { count, hasMore, items: items.map(item => {
        if (!Number.isSafeInteger(item?.number) || item.number < 1 || numbers.has(item.number) || typeof item.title !== 'string' || !item.title.trim()) throw new Error('Invalid pull');
        numbers.add(item.number);
        return { number: item.number, title: item.title.trim().slice(0, 180), draft: item.draft === true,
          url: `https://github.com/${raw.repository}/pull/${item.number}` };
      }) });
    }
    return { name: raw.name, repository: raw.repository, private: raw.private, archived: raw.archived,
      checkedAt: date(raw.checkedAt), deployment, pulls };
  });
  return result;
}
export function retainGithubOverview(next, previous) {
  if (['unavailable', 'rate_limited'].includes(next.state) && previous?.state === 'ready') {
    return { ...previous, stale: true, projects: previous.projects.map(project => ({ ...project,
      deployment: { ...project.deployment, stale: true, checkedAt: project.deployment.checkedAt || project.checkedAt },
      pulls: { ...project.pulls, stale: true, checkedAt: project.pulls.checkedAt || project.checkedAt } })) };
  }
  if (next.state !== 'ready') return next;
  return { ...next, projects: next.projects.map(project => {
    const old = previous?.projects?.find(item => item.repository === project.repository);
    const result = { ...project };
    for (const kind of ['deployment', 'pulls']) {
      if (['unavailable', 'rate_limited'].includes(project[kind].state) && old?.[kind].state === 'ready') {
        result[kind] = { ...old[kind], stale: true, checkedAt: old[kind].checkedAt || old.checkedAt };
      }
    }
    return result;
  }) };
}
export function githubSummary(value) {
  if (value?.state !== 'ready') return { repositories: 'Dépôts : —', detail: 'Modifications : —' };
  const projects = value.projects, pulls = projects.filter(p => p.pulls.state === 'ready');
  const total = pulls.reduce((sum, p) => sum + p.pulls.count, 0);
  const partial = pulls.length !== projects.length || value.hasMore || pulls.some(p => p.pulls.hasMore);
  const failed = projects.filter(p => p.deployment.state === 'ready' && ['failure', 'error'].includes(p.deployment.status)).length;
  const stale = value.stale || projects.some(p => p.pulls.stale || p.deployment.stale);
  return { repositories: `${projects.length}${value.hasMore ? '+' : ''} dépôt${projects.length === 1 ? '' : 's'}${stale ? ' · anciennes données' : ''}`,
    detail: `${total}${partial ? '+' : ''} PR ouverte${total === 1 ? '' : 's'}${failed ? ` · ${failed} publication${failed === 1 ? '' : 's'} en échec` : ''}${partial ? ' · lecture partielle' : ''}` };
}
export function githubPullDistribution(value) {
  if (value?.state !== 'ready') return null;
  const total = value.projects.length;
  const withPulls = value.projects.filter(p => p.pulls.state === 'ready' && p.pulls.count > 0).length;
  const withoutPulls = value.projects.filter(p => p.pulls.state === 'ready' && p.pulls.count === 0).length;
  const unknown = total - withPulls - withoutPulls;
  const stale = !!(value.stale || value.projects.some(p => p.pulls.stale));
  const caption = `${withPulls} avec PR · ${withoutPulls} sans PR${unknown ? ` · ${unknown} inconnu${unknown === 1 ? '' : 's'}` : ''}`;
  return { total, withPulls, withoutPulls, unknown,
    activePercent: total ? 100 * withPulls / total : 0,
    knownPercent: total ? 100 * (withPulls + withoutPulls) / total : 0,
    caption,
    label: `Répartition des ${total} dépôts suivis : ${caption}.${value.hasMore ? ' Liste de dépôts partielle.' : ''}${stale ? ' Dernières données conservées.' : ''}` };
}
export function githubDeploymentLabel(value) {
  if (value?.state !== 'ready') return value?.state === 'access_denied' ? 'Accès GitHub refusé'
    : value?.state === 'rate_limited' ? 'Limite GitHub atteinte' : 'Déploiement indisponible';
  return { success: 'Publication réussie', failure: 'Publication échouée', error: 'Erreur de publication',
    pending: 'Publication en attente', queued: 'Publication en attente', in_progress: 'Publication en cours',
    inactive: 'Ancienne publication', untracked: 'Production non renseignée' }[value.status];
}
