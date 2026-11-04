// Pure calendar helpers. No credentials, storage or browser side effects.
export const OUTLOOK_CONFIG_KEY = 'mon-espace-outlook-config-v1';
export const OUTLOOK_SCOPES = Object.freeze(['Calendars.ReadBasic']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export function normalizeOutlookConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const clientId = typeof value.clientId === 'string' ? value.clientId.trim().toLowerCase() : '';
  const tenantId = typeof value.tenantId === 'string' ? value.tenantId.trim().toLowerCase() : '';
  return UUID.test(clientId) && UUID.test(tenantId) && clientId !== ZERO_UUID && tenantId !== ZERO_UUID ? { clientId, tenantId } : null;
}

export function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function calendarWindow(range = 'today', anchor = new Date()) {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  if (range === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const end = new Date(start);
  end.setDate(end.getDate() + (range === 'week' ? 7 : 1));
  return { start, end, range: range === 'week' ? 'week' : 'today' };
}

export function calendarRequestUrl(window) {
  const url = new URL('https://graph.microsoft.com/v1.0/me/calendarView');
  url.searchParams.set('startDateTime', window.start.toISOString());
  url.searchParams.set('endDateTime', window.end.toISOString());
  url.searchParams.set('$select', 'id,subject,start,end,isAllDay,isCancelled,location,webLink,sensitivity,onlineMeeting');
  url.searchParams.set('$orderby', 'start/dateTime');
  url.searchParams.set('$top', '100');
  return url.href;
}

export function safeGraphPage(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://graph.microsoft.com' && !url.username && !url.password && !url.hash && /^\/v1\.0\/me\/calendarView$/i.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export function safeOutlookEventUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const hosts = ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com'];
    return url.protocol === 'https:' && (!url.port || url.port === '443') && hosts.includes(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function safeTeamsJoinUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const hosts = ['teams.microsoft.com', 'teams.cloud.microsoft', 'teams.live.com'];
    return url.protocol === 'https:' && !url.port && hosts.includes(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function teamsJoinUrlForEvent(event, now = new Date()) {
  if (!event || event.isPrivate || !(event.start instanceof Date) || !(event.end instanceof Date)
    || !(event.end > now || (+event.start === +event.end && event.start >= now))) return null;
  return safeTeamsJoinUrl(event.joinUrl);
}

export function graphDateTime(value) {
  if (!value || typeof value.dateTime !== 'string') return null;
  let text = value.dateTime.trim().replace(/(\.\d{3})\d+/, '$1');
  if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(text)) {
    // calendarView is explicitly requested in UTC. Never guess a Windows timezone.
    if (typeof value.timeZone !== 'string' || !['utc', 'etc/utc'].includes(value.timeZone.toLowerCase())) return null;
    text += 'Z';
  }
  const result = new Date(text);
  return Number.isFinite(result.getTime()) ? result : null;
}

export function normalizeCalendarEvents(values) {
  if (!Array.isArray(values)) return [];
  const events = [], seen = new Set();
  for (const value of values) {
    if (!value || value.isCancelled) continue;
    const start = graphDateTime(value.start), end = graphDateTime(value.end);
    if (!start || !end || end < start) continue;
    const id = typeof value.id === 'string' ? value.id.slice(0, 1000) : '';
    const dedupeKey = `${id || String(value.subject)}|${start.toISOString()}|${end.toISOString()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const isPrivate = ['private', 'confidential'].includes(value.sensitivity);
    const title = isPrivate ? 'Événement privé' : (typeof value.subject === 'string' ? value.subject.trim().slice(0, 300) : '') || 'Sans titre';
    const location = !isPrivate && typeof value.location?.displayName === 'string' ? value.location.displayName.trim().slice(0, 250) : '';
    events.push({ id, title, location, start, end, isAllDay: !!value.isAllDay, isPrivate, url: safeOutlookEventUrl(value.webLink),
      joinUrl: isPrivate ? null : safeTeamsJoinUrl(value.onlineMeeting?.joinUrl) });
  }
  return events.sort((a, b) => a.start - b.start || Number(b.isAllDay) - Number(a.isAllDay) || a.title.localeCompare(b.title, 'fr'));
}

export function eventOverlapsDay(event, start, end) {
  return event.start.getTime() === event.end.getTime() ? event.start >= start && event.start < end : event.start < end && event.end > start;
}

export function groupCalendarEvents(events, window, now = new Date()) {
  const groups = [];
  for (let date = new Date(window.start); date < window.end; date.setDate(date.getDate() + 1)) {
    const day = new Date(date), nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const matches = events.filter(event => eventOverlapsDay(event, day, nextDay));
    if (matches.length) groups.push({ key: localDateKey(day), date: day, end: nextDay, isToday: localDateKey(day) === localDateKey(now), events: matches.sort((a, b) => Number(b.isAllDay) - Number(a.isAllDay) || a.start - b.start) });
  }
  return groups;
}

export function eventTimeLabel(event, group, locale = 'fr-CH') {
  if (event.isAllDay) return 'Toute la journée';
  const format = date => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
  if (event.start.getTime() === event.end.getTime()) return format(event.start);
  const earlier = event.start < group.date, later = event.end > group.end;
  if (earlier && later) return 'En cours';
  if (earlier) return `Jusqu’à ${format(event.end)}`;
  if (later) return `Dès ${format(event.start)}`;
  return `${format(event.start)}–${format(event.end)}`;
}

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return 60000;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.min(86400000, Math.max(1000, milliseconds)) : 60000;
}
