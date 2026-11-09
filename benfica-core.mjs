export const BENFICA_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/1929/schedule?fixture=true';
export const BENFICA_INTERVAL_MS = 15 * 60_000;
export const BENFICA_CACHE_KEY = 'dashboard.benfica-fixtures.v1';
export const BENFICA_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const TEAM_ID = '1929';
const clean = value => typeof value === 'string' ? value.trim().slice(0, 160) : '';
const swissDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);

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

export function upcomingBenficaMatches(matches, now = Date.now(), limit = 3) {
  return matches.filter(match => match.timeConfirmed ? Date.parse(match.startsAt) > now : swissDay(new Date(match.startsAt)) >= swissDay(new Date(now)))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id)).slice(0, limit);
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

export function benficaMatchWhen(match) {
  const date = new Date(match.startsAt);
  const day = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'short' }).format(date);
  const time = match.timeConfirmed ? new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) : 'horaire à confirmer';
  return `${day} · ${time}`;
}

export function readBenficaCache(raw, now = Date.now()) {
  try {
    if (typeof raw !== 'string' || raw.length > 100_000) return null;
    const cached = JSON.parse(raw);
    if (cached?.version !== 1 || !Number.isFinite(cached.at) || cached.at > now + 60_000 || now - cached.at > BENFICA_CACHE_MAX_AGE_MS || !Array.isArray(cached.matches) || cached.matches.length > 100) return null;
    const matches = [], seen = new Set();
    for (const match of cached.matches) {
      if (!match || typeof match.id !== 'string' || !/^\d{1,30}$/.test(match.id) || seen.has(match.id) || !validDate(match.startsAt) || typeof match.timeConfirmed !== 'boolean' || !clean(match.home) || !clean(match.away) || !clean(match.league)) return null;
      matches.push({ id: match.id, startsAt: new Date(match.startsAt).toISOString(), timeConfirmed: match.timeConfirmed, home: clean(match.home), away: clean(match.away), league: clean(match.league), url: safeBenficaMatchUrl(match.url) });
      seen.add(match.id);
    }
    return { at: cached.at, matches };
  } catch { return null; }
}
