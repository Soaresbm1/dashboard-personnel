import { readFile } from 'node:fs/promises';

// Only a bounded public snapshot is written. The workflow token is used solely
// at api.github.com, never when fetching vendor status pages or news publishers.
if (process.env.GITHUB_REPOSITORY !== 'Soaresbm1/dashboard-personnel') throw new Error('Unexpected repository');
const root = 'https://api.github.com/repos/Soaresbm1/dashboard-personnel';
const branch = 'tech-news-data', path = 'tech-news.json';
const raw = await readFile(path, 'utf8');
if (Buffer.byteLength(raw) > 50_000) throw new Error('Oversized tech snapshot');
const result = JSON.parse(raw), now = Date.now();
const states = new Set(['operational', 'degraded', 'outage', 'maintenance', 'unknown']);
const services = { microsoft: 'https://status.cloud.microsoft/', openai: 'https://status.openai.com/', anthropic: 'https://status.claude.com/' };
const publishers = new Map([
  ['Le Monde Informatique', new Set(['www.lemondeinformatique.fr', 'lemondeinformatique.fr'])],
  ['Numerama', new Set(['www.numerama.com', 'numerama.com'])],
  ['Le Monde · Pixels', new Set(['www.lemonde.fr', 'lemonde.fr'])]
]);
const date = value => typeof value === 'string' && /Z$/.test(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 300_000;
const clean = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[<>\u0000-\u001f]/.test(value);
function safeUrl(value, hosts) {
  try {
    const url = new URL(value);
    return typeof value === 'string' && value.length <= 1500 && url.protocol === 'https:' && hosts.has(url.hostname) && !url.username && !url.password && !url.hash && !url.port;
  } catch { return false; }
}
if (result.schemaVersion !== 1 || !date(result.generatedAt) || !Array.isArray(result.services) || result.services.length !== 3
    || !Array.isArray(result.articles) || result.articles.length > 5 || typeof result.newsCheckFailed !== 'boolean'
    || result.newsCheckedAt !== null && !date(result.newsCheckedAt)) throw new Error('Invalid tech snapshot');
const seen = new Set();
for (const service of result.services) {
  if (!service || !Object.hasOwn(services, service.id) || seen.has(service.id) || service.url !== services[service.id]
      || !states.has(service.status) || !clean(service.name, 80) || !clean(service.label, 80) || typeof service.checkFailed !== 'boolean'
      || service.checkedAt !== null && !date(service.checkedAt)) throw new Error('Invalid service snapshot');
  if (service.incident !== null && (!service.incident || !clean(service.incident.title, 220) || !date(service.incident.updatedAt)
      || !safeUrl(service.incident.url, new Set([new URL(service.url).hostname])))) throw new Error('Invalid incident');
  seen.add(service.id);
}
for (const article of result.articles) {
  const hosts = publishers.get(article?.source);
  if (!hosts || !clean(article.title, 240) || !date(article.publishedAt) || now - Date.parse(article.publishedAt) > 7 * 86_400_000
      || !/^[a-f0-9]{20}$/.test(article.id) || !safeUrl(article.url, hosts)) throw new Error('Invalid public headline');
}
const content = JSON.stringify(result) + '\n';
if (process.argv.includes('--validate-only')) {
  console.log('Public technology snapshot validated without publication.');
  process.exit(0);
}
async function api(route, method = 'GET', body) {
  const response = await fetch(`${root}${route}`, { method, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`Public tech publication failed: HTTP ${response.status}`);
  return response.json();
}
const existing = await api(`/contents/${path}?ref=${branch}`);
if (existing) {
  await api(`/contents/${path}`, 'PUT', { message: 'Refresh public tech news and vendor status', branch, sha: existing.sha, content: Buffer.from(content).toString('base64') });
} else {
  const tree = await api('/git/trees', 'POST', { tree: [{ path, mode: '100644', type: 'blob', content }] });
  const commit = await api('/git/commits', 'POST', { message: 'Initialize public tech news snapshot', tree: tree.sha, parents: [] });
  await api('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
}
console.log('Public technology headlines and status snapshot published.');
