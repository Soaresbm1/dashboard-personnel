// Read-only workplace helpers. No personal data, tokens or storage side effects.
export const DIRECTORY_API_URL = 'https://intranet.isp-spi.ch/api/dashboard/v1/directory';
export const DIRECTORY_URL = 'https://intranet.isp-spi.ch/intranet/annuaire';
export const ROOM_SCOPES = Object.freeze(['Place.Read.All', 'Calendars.ReadBasic']);
export const ROOM_SELECT = 'id,displayName,emailAddress,capacity,building,floorLabel';
export const ROOM_SCHEDULE_URL = 'https://graph.microsoft.com/v1.0/me/calendar/getSchedule';
export const ROOM_LIMIT = 1000;
const trim = (value, length = 200) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const order = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const folded = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');

export function safeWorkplaceEmail(value) {
  const email = trim(value, 254);
  return /^[^\s<>"'(),:;\\/?#%]+@[^\s<>"'(),:;\\/?#%]+\.[^\s<>"'(),:;\\/?#%]+$/.test(email) ? email : '';
}

export function safeDirectoryUrl(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, DIRECTORY_URL);
    return url.origin === 'https://intranet.isp-spi.ch' && !url.username && !url.password
      && url.pathname === '/intranet/annuaire' && !url.search ? url.href : null;
  } catch { return null; }
}

export function normalizeDirectoryResponse(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.people)) throw new Error('Invalid directory response');
  const seen = new Set(), people = [];
  for (const person of value.people.slice(0, 1000)) {
    const id = typeof person?.id === 'string' ? trim(person.id, 120)
      : Number.isSafeInteger(person?.id) && person.id > 0 ? String(person.id) : '';
    const displayName = trim(person?.displayName, 200);
    if (!id || !displayName || seen.has(id)) continue;
    seen.add(id);
    people.push({ id, displayName, email: safeWorkplaceEmail(person.email), jobTitle: trim(person.jobTitle),
      department: trim(person.department), location: trim(person.location), url: safeDirectoryUrl(person.url) });
  }
  people.sort((a, b) => order.compare(a.displayName, b.displayName) || order.compare(a.id, b.id));
  return { people, hasMore: value.meta?.hasMore === true || value.people.length > 1000 };
}

export function filterDirectoryPeople(people, query = '') {
  const words = folded(trim(query, 200)).split(/\s+/).filter(Boolean);
  return people.filter(person => {
    const content = folded([person.displayName, person.email, person.jobTitle, person.department, person.location].join(' '));
    return words.every(word => content.includes(word));
  });
}

export function roomListUrl() {
  const url = new URL('https://graph.microsoft.com/v1.0/places/microsoft.graph.room');
  url.searchParams.set('$select', ROOM_SELECT); url.searchParams.set('$top', '100');
  return url.href;
}

// Graph pagination URLs carry opaque cursors, but may never change host, collection or projection.
export function safeRoomGraphUrl(value) {
  if (typeof value !== 'string' || value.length > 12000 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash
      || url.pathname !== '/v1.0/places/microsoft.graph.room') return null;
    for (const [key] of url.searchParams) if (!['$select', '$top', '$skip', '$skiptoken'].includes(key)) return null;
    if (url.searchParams.has('$select') && url.searchParams.get('$select') !== ROOM_SELECT) return null;
    if (url.searchParams.has('$top') && !/^(?:[1-9]\d?|100)$/.test(url.searchParams.get('$top'))) return null;
    if (url.searchParams.has('$skip') && !/^\d{1,8}$/.test(url.searchParams.get('$skip'))) return null;
    for (const key of ['$select', '$top', '$skip', '$skiptoken']) if (url.searchParams.getAll(key).length > 1) return null;
    return url.href;
  } catch { return null; }
}

export function normalizeRoomsPage(value) {
  if (!value || !Array.isArray(value.value)) throw new Error('Invalid rooms response');
  const rooms = [];
  for (const entry of value.value.slice(0, ROOM_LIMIT)) {
    const id = trim(entry?.id, 200), displayName = trim(entry?.displayName);
    if (!id || !displayName) continue;
    rooms.push({ id, displayName, email: safeWorkplaceEmail(entry.emailAddress).toLowerCase(),
      capacity: Number.isSafeInteger(entry.capacity) && entry.capacity > 0 && entry.capacity < 100000 ? entry.capacity : null,
      building: trim(entry.building), floorLabel: trim(entry.floorLabel, 100) });
  }
  const next = value['@odata.nextLink'];
  if (next !== undefined && next !== null && !safeRoomGraphUrl(next)) throw new Error('Untrusted rooms continuation');
  return { rooms, next: next ? safeRoomGraphUrl(next) : null, hasMore: value.value.length > ROOM_LIMIT };
}

export function roomScheduleRequests(rooms, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(+now)) throw new Error('Invalid schedule date');
  const start = new Date(+now), end = new Date(+start + 30 * 60000);
  const emails = [...new Set(rooms.map(room => safeWorkplaceEmail(room.email).toLowerCase()).filter(Boolean))];
  const requests = [];
  for (let index = 0; index < emails.length; index += 20) {
    requests.push({ schedules: emails.slice(index, index + 20), startTime: { dateTime: start.toISOString().slice(0, -1), timeZone: 'UTC' },
      endTime: { dateTime: end.toISOString().slice(0, -1), timeZone: 'UTC' }, availabilityViewInterval: 5 });
  }
  return requests;
}

export function normalizeRoomAvailability(rooms, responses) {
  const byEmail = new Map();
  for (const response of responses) {
    if (!response || !Array.isArray(response.value)) throw new Error('Invalid free/busy response');
    for (const schedule of response.value) {
      const email = safeWorkplaceEmail(schedule?.scheduleId).toLowerCase();
      if (!email) continue;
      // Any per-room error, duplicate result, missing slot or unfamiliar code is unknown.
      const view = !schedule.error && typeof schedule.availabilityView === 'string' && /^[0-3]{6}$/.test(schedule.availabilityView)
        ? schedule.availabilityView : '';
      byEmail.set(email, byEmail.has(email) ? '' : view);
    }
  }
  const items = rooms.map(room => {
    const view = byEmail.get(room.email) || '';
    const availability = view === '000000' ? 'free' : !view ? 'unknown' : /[23]/.test(view) ? 'busy' : 'tentative';
    return { ...room, availability };
  });
  const rank = { free: 0, busy: 1, tentative: 2, unknown: 3 };
  return items.sort((a, b) => rank[a.availability] - rank[b.availability] || order.compare(a.displayName, b.displayName) || order.compare(a.id, b.id));
}

export function roomAvailabilityLabel(status) {
  return { free: 'Libre sur ce créneau', busy: 'Occupée sur ce créneau', tentative: 'Réservation provisoire', unknown: 'Disponibilité inconnue' }[status] || 'Disponibilité inconnue';
}
