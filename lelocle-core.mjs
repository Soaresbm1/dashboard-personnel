import { readFootballCache, upcomingFootballMatches } from './football-core.mjs';
export { upcomingFootballMatches as upcomingLeLocleMatches, footballMatchWhen as leLocleMatchWhen } from './football-core.mjs';
export const LELOCLE_URL = 'https://intranet.isp-spi.ch/dashboard-lelocle-fixtures.php';
export const LELOCLE_SOURCE_URL = 'https://matchcenter-anf.football.ch/default.aspx?a=pt&lng=2&oid=15&t=34107&v=919';
export const LELOCLE_INTERVAL_MS = 15 * 60_000;
export const LELOCLE_CACHE_KEY = 'dashboard.lelocle-juniors-a.v1';
export const LELOCLE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const LELOCLE_RESULTS_MAX_AGE_MS = 366 * 24 * 60 * 60_000;
const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
const key = value => clean(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const isLeLocleTeam = value => key(value).replace(/\s*\(jun\.?\s*a\)$/, '').trim() === 'fc le locle';
const unescapeIcs = value => value.replace(/\\([nN,;\\])/g, (_, char) => /n/i.test(char) ? '\n' : char);
const localParts = value => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));

export function safeLeLocleUrl(value) { return value === LELOCLE_SOURCE_URL ? value : null; }

// TZsfv is the official feed's CET/CEST timezone, equivalent to Europe/Zurich.
export function parseLeLocleDate(value, parameters = '') {
  const parts = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!parts) throw new Error('Invalid fixture date');
  const [, year, month, day, hour = '00', minute = '00', second = '00', utc] = parts;
  const date = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second), check = new Date(date);
  if (+year < 2000 || +year > 2100 || check.getUTCFullYear() !== +year || check.getUTCMonth() !== +month - 1 || check.getUTCDate() !== +day || check.getUTCHours() !== +hour || check.getUTCMinutes() !== +minute || check.getUTCSeconds() !== +second) throw new Error('Invalid fixture date');
  const provisional = !parts[4] || hour + minute + second === '000000';
  if (provisional) return { startsAt: new Date(Date.UTC(+year, +month - 1, +day, 12)).toISOString(), timeConfirmed: false };
  if (utc) return { startsAt: check.toISOString(), timeConfirmed: true };
  const zone = /(?:^|;)TZID=(?:"([^"]+)"|([^;]+))/i.exec(parameters);
  if (zone && !['TZsfv', 'Europe/Zurich', 'Europe/Amsterdam'].includes(zone[1] || zone[2])) throw new Error('Unsupported fixture timezone');
  const candidates = [60, 120].map(offset => date - offset * 60_000).filter(candidate => {
    const result = localParts(candidate);
    return result.year === year && result.month === month && result.day === day && result.hour === hour && result.minute === minute && result.second === second;
  });
  // Never assert an invented instant for a nonexistent or ambiguous DST time.
  return candidates.length === 1 ? { startsAt: new Date(candidates[0]).toISOString(), timeConfirmed: true }
    : { startsAt: new Date(Date.UTC(+year, +month - 1, +day, 12)).toISOString(), timeConfirmed: false };
}

export function parseLeLocleCalendar(raw) {
  if (typeof raw !== 'string' || raw.length > 524_288) throw new Error('Invalid fixture calendar');
  const text = raw.replace(/^\uFEFF/, '').replace(/\r+\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  if (!/^BEGIN:VCALENDAR\n/.test(text) || !/\nEND:VCALENDAR\s*$/.test(text) || !/^X-WR-CALNAME:FC Le Locle - Juniors A$/m.test(text)) throw new Error('Unexpected fixture calendar');
  const events = new Map(); let current = null, count = 0;
  for (const line of text.split('\n')) {
    if (line === 'BEGIN:VEVENT') {
      if (current || ++count > 1000) throw new Error('Invalid fixture events');
      current = {}; continue;
    }
    if (line === 'END:VEVENT') {
      if (!current) throw new Error('Invalid fixture events');
      const uid = /^(\d{1,30})@football\.ch$/i.exec(current.UID?.value || '');
      if (!uid || !current.SUMMARY || !current.DTSTART) throw new Error('Incomplete fixture');
      const id = uid[1], sequence = /^\d+$/.test(current.SEQUENCE?.value || '') ? Number(current.SEQUENCE.value) : 0;
      if (!events.has(id) || sequence >= events.get(id).sequence) events.set(id, { ...current, id, sequence });
      current = null; continue;
    }
    if (!current) continue;
    const property = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/i.exec(line);
    if (property) current[property[1].toUpperCase()] = { parameters: property[2], value: property[3] };
  }
  if (current) throw new Error('Incomplete fixture events');
  const matches = [];
  for (const event of events.values()) {
    const teams = unescapeIcs(event.SUMMARY.value).split(/\s+[-–—]\s+/).map(clean);
    if (teams.length !== 2 || !teams.every(Boolean) || teams.filter(isLeLocleTeam).length !== 1) throw new Error('Unexpected fixture team');
    const description = unescapeIcs(event.DESCRIPTION?.value || '');
    if (event.STATUS?.value.toUpperCase() === 'CANCELLED' || /\b(?:annule|annulee|renvoye|renvoyee|reporte|reportee)\b/.test(key(description))) continue;
    const when = parseLeLocleDate(event.DTSTART.value, event.DTSTART.parameters);
    const league = clean(description.split('\n')[0]) || 'Juniors A';
    matches.push({ id: event.id, ...when, home: teams[0], away: teams[1], league, url: LELOCLE_SOURCE_URL });
  }
  return matches.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, 100);
}

export function parseLeLocleFeed(body, now = Date.now()) {
  const at = typeof body?.checkedAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(body.checkedAt) ? Date.parse(body.checkedAt) : NaN;
  if (body?.schemaVersion !== 1 || body.teamId !== '34107' || typeof body.checkFailed !== 'boolean' || !Number.isFinite(at) || at > now + 60_000 || now - at > LELOCLE_CACHE_MAX_AGE_MS) throw new Error('Invalid fixture feed');
  const resultsAt = typeof body.resultsCheckedAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(body.resultsCheckedAt) ? Date.parse(body.resultsCheckedAt) : null;
  return { at, stale: body.checkFailed, matches: parseLeLocleCalendar(body.calendar),
    ...normalizeLeLocleResults({ resultsState: body.resultsState, resultsAt, resultsFailed: body.resultsCheckFailed, results: body.results }, now) };
}

export function readLeLocleCache(raw, now = Date.now()) {
  const base = readFootballCache(raw, now, safeLeLocleUrl, LELOCLE_CACHE_MAX_AGE_MS);
  if (!base) return null;
  return { ...base, ...normalizeLeLocleResults(JSON.parse(raw), now) };
}

function normalizeLeLocleResults(source, now) {
  const unavailable = { resultsState: 'unavailable', resultsAt: null, resultsFailed: true, results: [] };
  if (source.resultsState !== 'ready' || !Number.isFinite(source.resultsAt) || source.resultsAt > now + 60_000 || now - source.resultsAt > LELOCLE_RESULTS_MAX_AGE_MS || typeof source.resultsFailed !== 'boolean' || !Array.isArray(source.results) || source.results.length > 100) return unavailable;
  const results = [], seen = new Set();
  for (const row of source.results) {
    if (!row || typeof row.id !== 'string' || !/^\d{1,30}$/.test(row.id) || seen.has(row.id) || typeof row.startsAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.startsAt)
        || !Number.isFinite(Date.parse(row.startsAt)) || Date.parse(row.startsAt) > now || typeof row.timeConfirmed !== 'boolean'
        || !Number.isInteger(row.scoreHome) || row.scoreHome < 0 || row.scoreHome > 99 || !Number.isInteger(row.scoreAway) || row.scoreAway < 0 || row.scoreAway > 99
        || !clean(row.home) || !clean(row.away) || [row.home, row.away].filter(isLeLocleTeam).length !== 1 || !clean(row.league)) return unavailable;
    results.push({ id: row.id, startsAt: new Date(row.startsAt).toISOString(), timeConfirmed: row.timeConfirmed,
      home: clean(row.home), away: clean(row.away), scoreHome: row.scoreHome, scoreAway: row.scoreAway, league: clean(row.league), url: safeLeLocleUrl(row.url) });
    seen.add(row.id);
  }
  return { resultsState: 'ready', resultsAt: source.resultsAt, resultsFailed: source.resultsFailed,
    results: results.sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt) || a.id.localeCompare(b.id)).slice(0, 3) };
}

export function selectLeLocleView(snapshot, now = Date.now()) {
  const upcoming = upcomingFootballMatches(snapshot.matches, now);
  if (upcoming.length) return { mode: 'upcoming', matches: upcoming, at: snapshot.at, stale: snapshot.stale };
  const ready = snapshot.resultsState === 'ready' && Number.isFinite(snapshot.resultsAt) && now - snapshot.resultsAt <= LELOCLE_RESULTS_MAX_AGE_MS;
  return { mode: 'results', matches: ready ? snapshot.results.filter(row => Date.parse(row.startsAt) <= now).slice(0, 3) : [],
    at: snapshot.resultsAt, available: ready, stale: snapshot.stale || snapshot.resultsFailed };
}

export function mergeLeLocleSnapshot(previous, next, now = Date.now()) {
  if (!previous) return next;
  const merged = { ...next };
  if (previous.at > next.at) { merged.at = previous.at; merged.matches = previous.matches; merged.stale = true; }
  if (previous.resultsState === 'ready' && Number.isFinite(previous.resultsAt) && now - previous.resultsAt <= LELOCLE_RESULTS_MAX_AGE_MS
      && (next.resultsState !== 'ready' || previous.resultsAt > next.resultsAt)) {
    Object.assign(merged, { resultsState: 'ready', resultsAt: previous.resultsAt, results: previous.results, resultsFailed: true });
  }
  return merged;
}

export function mergeLeLocleExtension(snapshot, packet, now = Date.now()) {
  if (!snapshot || packet?.installed !== true || packet.resultsState !== 'ready') return snapshot;
  const at = typeof packet.resultsCheckedAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(packet.resultsCheckedAt) ? Date.parse(packet.resultsCheckedAt) : null;
  const results = normalizeLeLocleResults({ resultsState: packet.resultsState, resultsAt: at, resultsFailed: packet.resultsCheckFailed, results: packet.results }, now);
  if (results.resultsState !== 'ready') return snapshot;
  return mergeLeLocleSnapshot(snapshot, { ...snapshot, ...results }, now);
}
