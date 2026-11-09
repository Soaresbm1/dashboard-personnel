import { readFootballCache } from './football-core.mjs';
export const BENFICA_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/1929/schedule?fixture=true';
export const BENFICA_INTERVAL_MS = 15 * 60_000;
export const BENFICA_CACHE_KEY = 'dashboard.benfica-fixtures.v1';
export const BENFICA_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const TEAM_ID = '1929';
const clean = value => typeof value === 'string' ? value.trim().slice(0, 160) : '';

export function safeBenficaMatchUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://www.espn.com' && !url.username && !url.password && !url.hash && !url.search && /^\/soccer\/match\/_\/gameId\/\d+(?:\/[a-z0-9-]+)?\/?$/i.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

function validDate(value) {
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
}

export function parseBenficaSchedule(body) {
  if (!body || body.status !== 'success' || String(body.team?.id) !== TEAM_ID || !Array.isArray(body.events) || body.events.length > 1000) throw new Error('Invalid Benfica schedule');
  const matches = [], seen = new Set();
  for (const event of body.events) {
    const competition = event?.competitions?.[0], status = competition?.status?.type;
    if (!status || status.name !== 'STATUS_SCHEDULED' || status.state !== 'pre' || status.completed !== false) continue;
    const teams = competition?.competitors;
    if (!Array.isArray(teams) || teams.length !== 2 || teams.filter(value => String(value?.team?.id) === TEAM_ID).length !== 1) continue;
    const home = teams.find(value => value?.homeAway === 'home'), away = teams.find(value => value?.homeAway === 'away');
    const id = clean(event.id), startsAt = competition.date || event.date;
    const homeName = clean(home?.team?.shortDisplayName || home?.team?.displayName), awayName = clean(away?.team?.shortDisplayName || away?.team?.displayName);
    if (!/^\d+$/.test(id) || seen.has(id) || !validDate(startsAt) || !homeName || !awayName || home === away) continue;
    const names = { 'por.1': 'Liga Portugal', 'por.taca.portugal': 'Coupe du Portugal', 'por.taca.liga': 'Coupe de la Ligue', 'uefa.europa': 'Ligue Europa', 'uefa.champions': 'Ligue des champions' };
    const league = names[event.league?.slug] || clean(event.league?.shortName || event.league?.name) || 'Compétition à confirmer';
    const summary = Array.isArray(event.links) ? event.links.find(link => Array.isArray(link.rel) && link.rel.includes('summary') && link.rel.includes('desktop')) : null;
    matches.push({ id, startsAt: new Date(startsAt).toISOString(), timeConfirmed: (competition.timeValid ?? event.timeValid) === true,
      home: homeName, away: awayName, league, url: safeBenficaMatchUrl(summary?.href) });
    seen.add(id);
  }
  return matches.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, 100);
}

export { upcomingFootballMatches as upcomingBenficaMatches, footballMatchWhen as benficaMatchWhen } from './football-core.mjs';
export function readBenficaCache(raw, now = Date.now()) {
  return readFootballCache(raw, now, safeBenficaMatchUrl, BENFICA_CACHE_MAX_AGE_MS);
}
