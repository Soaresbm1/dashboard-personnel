import { readFile } from 'node:fs/promises';

// Publish only the bounded, anonymous availability result on a separate branch.
// The workflow token never goes to the intranet or the dashboard browser.
if (process.env.GITHUB_REPOSITORY !== 'Soaresbm1/dashboard-personnel') throw new Error('Unexpected repository');
const root = 'https://api.github.com/repos/Soaresbm1/dashboard-personnel';
const branch = 'intranet-status', path = 'intranet-status.json';
const result = JSON.parse(await readFile(path, 'utf8'));
if (result.schemaVersion !== 1 || result.target !== 'https://intranet.isp-spi.ch/intranet') throw new Error('Invalid monitor result');
const content = JSON.stringify(result) + '\n';
if (content.length > 1024) throw new Error('Oversized result');
async function api(route, method = 'GET', body) {
  const response = await fetch(`${root}${route}`, { method, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok) throw new Error(`Result publication failed: HTTP ${response.status}`);
  return response.json();
}
const existing = await api(`/contents/${path}?ref=${branch}`);
if (existing) {
  await api(`/contents/${path}`, 'PUT', { message: 'Check intranet availability', branch, sha: existing.sha, content: Buffer.from(content).toString('base64') });
} else {
  const tree = await api('/git/trees', 'POST', { tree: [{ path, mode: '100644', type: 'blob', content }] });
  const commit = await api('/git/commits', 'POST', { message: 'Initialize intranet availability result', tree: tree.sha, parents: [] });
  await api('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
}
console.log('Anonymous availability result published.');
