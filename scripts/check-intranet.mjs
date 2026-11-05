import https from 'node:https';
import { pathToFileURL } from 'node:url';

export const TARGET = 'https://intranet.isp-spi.ch/intranet';
export const APPLICATION_TARGET = 'https://intranet.isp-spi.ch/up';
const REDIRECTS = [301, 302, 303, 307, 308];
const classify = status => status >= 200 && status < 300 ? 'online' : [401, 403].includes(status) ? 'auth_required' : REDIRECTS.includes(status) ? 'redirect' : 'http_error';

// An anonymous GET checks the real web entry point. No cookies, Microsoft token,
// response body, redirect query or internal error message is retained.
export function requestHeaders(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { Accept: 'text/html', 'User-Agent': 'Dashboard-availability/1.0' } }, response => {
      resolve({ status: response.statusCode, location: response.headers.location });
      response.destroy();
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), timeoutMs);
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
  });
}

export async function checkIntranet({ request = requestHeaders, now = Date.now, timeoutMs = 15_000 } = {}) {
  const started = now();
  const finish = (outcome, httpStatus = null, error = null, extra = {}) => ({ schemaVersion: 1, target: TARGET,
    checkedAt: new Date(now()).toISOString(), outcome, httpStatus, error, latencyMs: Math.max(0, now() - started), ...extra });
  let url = TARGET;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const remaining = timeoutMs - (now() - started);
      if (remaining <= 0) return finish('network_error', null, 'timeout');
      const response = await request(url, remaining);
      const status = response.status;
      if (!Number.isInteger(status) || status < 100 || status > 599) return finish('network_error', null, 'network');
      if (REDIRECTS.includes(status)) {
        if (typeof response.location !== 'string' || !response.location.trim()) return finish('redirect', status);
        let next; try { next = new URL(response.location, url); } catch { return finish('redirect', status); }
        if (next.protocol === 'https:' && next.hostname === 'login.microsoftonline.com' && !next.port && !next.username && !next.password
          && /\/oauth2(?:\/v2\.0)?\/authorize$/.test(next.pathname)) {
          // A normal SSO redirect is not a site outage. Check Laravel's public
          // health route without following or submitting the Microsoft URL.
          const remaining = timeoutMs - (now() - started);
          if (remaining <= 0) return finish('network_error', null, 'timeout');
          const health = await request(APPLICATION_TARGET, remaining);
          if (!Number.isInteger(health.status) || health.status < 100 || health.status > 599) return finish('network_error', null, 'network');
          return finish(classify(health.status), health.status, null, { entryHttpStatus: status, applicationHttpStatus: health.status });
        }
        if (next.origin !== new URL(TARGET).origin || next.username || next.password) return finish('redirect', status);
        if (hop === 5) return finish('network_error', null, 'redirect_loop');
        url = next.href; continue;
      }
      return finish(classify(status), status);
    }
  } catch (error) {
    const kind = error.code === 'ETIMEDOUT' ? 'timeout' : ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code) ? 'dns'
      : /CERT|TLS|SSL/.test(error.code || '') ? 'tls' : 'network';
    return finish('network_error', null, kind);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkIntranet();
  const { writeFile } = await import('node:fs/promises');
  await writeFile('intranet-status.json', JSON.stringify(result) + '\n');
  console.log(`Intranet: ${result.outcome}; HTTP ${result.httpStatus ?? 'unavailable'}`);
}
