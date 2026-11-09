const clean = value => typeof value === 'string' ? value.trim().slice(0, 160) : '';
const swissDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
function validDate(value) { return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)); }

export function upcomingFootballMatches(matches, now = Date.now(), limit = 3) {
  return matches.filter(match => match.timeConfirmed ? Date.parse(match.startsAt) > now : swissDay(new Date(match.startsAt)) >= swissDay(new Date(now)))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id)).slice(0, limit);
}

export function footballMatchWhen(match) {
  const date = new Date(match.startsAt);
  const day = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'short' }).format(date);
  const time = match.timeConfirmed ? new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) : 'horaire à confirmer';
  return `${day} · ${time}`;
}

export function readFootballCache(raw, now, safeLink, maxAgeMs) {
  try {
    if (typeof raw !== 'string' || raw.length > 100_000) return null;
    const cached = JSON.parse(raw);
    if (cached?.version !== 1 || !Number.isFinite(cached.at) || cached.at > now + 60_000 || now - cached.at > maxAgeMs || !Array.isArray(cached.matches) || cached.matches.length > 100) return null;
    const matches = [], seen = new Set();
    for (const match of cached.matches) {
      if (!match || typeof match.id !== 'string' || !/^\d{1,30}$/.test(match.id) || seen.has(match.id) || !validDate(match.startsAt) || typeof match.timeConfirmed !== 'boolean' || !clean(match.home) || !clean(match.away) || !clean(match.league)) return null;
      matches.push({ id: match.id, startsAt: new Date(match.startsAt).toISOString(), timeConfirmed: match.timeConfirmed, home: clean(match.home), away: clean(match.away), league: clean(match.league), url: safeLink(match.url) });
      seen.add(match.id);
    }
    return { at: cached.at, matches };
  } catch { return null; }
}
