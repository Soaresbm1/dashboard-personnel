export const TRANSPORT_STOP = Object.freeze({ id: '8593564', name: 'Neuchâtel, Pont des Parcs', timezone: 'Europe/Zurich' });
export const TRANSPORT_DESTINATION = Object.freeze({ id: '8579625', name: 'Neuchâtel, gare nord' });
export const TRANSPORT_INTERVAL_MS = 60_000;
export const TRANSPORT_MAX_AGE_MS = 3 * 60_000;
export const TRANSPORT_URL = 'https://transport.opendata.ch/v1/stationboard?id=8593564&limit=30&fields[]=station&fields[]=stationboard/stop&fields[]=stationboard/name&fields[]=stationboard/category&fields[]=stationboard/number&fields[]=stationboard/to&fields[]=stationboard/passList/station/id&fields[]=stationboard/passList/arrival&fields[]=stationboard/passList/arrivalTimestamp&fields[]=stationboard/passList/prognosis/arrival';

const timeFormat = new Intl.DateTimeFormat('fr-CH', { timeZone: TRANSPORT_STOP.timezone, hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TRANSPORT_STOP.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('fr-CH', { timeZone: TRANSPORT_STOP.timezone, day: 'numeric', month: 'short' });
export const transportTime = milliseconds => timeFormat.format(new Date(milliseconds));
export function transportRetryAt(value, now = Date.now()) {
  const requested = typeof value === 'string' && /^\d+$/.test(value) ? now + Number(value) * 1_000 : typeof value === 'string' ? Date.parse(value) : NaN;
  // Bounded below the browser timer limit; support both forms of Retry-After.
  return Math.min(now + 24 * 60 * 60_000, Math.max(now + 60_000, Number.isFinite(requested) ? requested : now + 120_000));
}
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const directionKey = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr').replace(/[,\s]+/g, '');
export const matchesTransportDirection = destination => typeof destination === 'string' && directionKey(destination) === directionKey(TRANSPORT_DESTINATION.name);
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return NaN;
  return Date.parse(value);
};

function destinationArrival(passList, plannedDepartureAt, expectedDepartureAt) {
  let result = { plannedArrivalAt: null, arrivalAt: null, hasArrivalPrediction: false };
  if (!Array.isArray(passList)) return result;
  for (const checkpoint of passList.slice(0, 100)) {
    if (String(checkpoint?.station?.id) !== TRANSPORT_DESTINATION.id) continue;
    const plannedArrivalAt = Number.isFinite(checkpoint.arrivalTimestamp) && checkpoint.arrivalTimestamp > 0
      ? checkpoint.arrivalTimestamp * 1_000 : timestamp(checkpoint.arrival);
    // The API can include a pseudo-stop carrying the destination ID but no actual arrival.
    // Require a real scheduled arrival, then retain the last valid destination checkpoint.
    if (!Number.isFinite(plannedArrivalAt) || plannedArrivalAt <= plannedDepartureAt || plannedArrivalAt - plannedDepartureAt > 6 * 60 * 60_000) continue;
    const predicted = timestamp(checkpoint.prognosis?.arrival);
    const hasArrivalPrediction = Number.isFinite(predicted) && predicted > expectedDepartureAt
      && predicted - expectedDepartureAt <= 6 * 60 * 60_000 && Math.abs(predicted - plannedArrivalAt) <= 12 * 60 * 60_000;
    const arrivalAt = hasArrivalPrediction ? predicted : plannedArrivalAt > expectedDepartureAt ? plannedArrivalAt : null;
    result = { plannedArrivalAt, arrivalAt, hasArrivalPrediction };
  }
  return result;
}

export function parseStationboard(payload) {
  if (String(payload?.station?.id) !== TRANSPORT_STOP.id || !Array.isArray(payload?.stationboard) || payload?.errors?.length) throw new Error('invalid_stationboard');
  const seen = new Set(), departures = [];
  for (const item of payload.stationboard.slice(0, 100)) {
    const stop = item?.stop;
    if (!stop || (stop.station?.id != null && String(stop.station.id) !== TRANSPORT_STOP.id)) continue;
    const plannedAt = Number.isFinite(stop.departureTimestamp) && stop.departureTimestamp > 0 ? stop.departureTimestamp * 1_000 : timestamp(stop.departure);
    const destination = text(item.to, 180), line = text(item.number, 16) || text(item.category, 16);
    if (!Number.isFinite(plannedAt) || !destination || !line) continue;
    const predicted = timestamp(stop.prognosis?.departure);
    const delay = typeof stop.delay === 'number' && Number.isFinite(stop.delay) && stop.delay >= -60 && stop.delay <= 720 ? stop.delay : null;
    const hasPrediction = Number.isFinite(predicted) && Math.abs(predicted - plannedAt) <= 12 * 60 * 60_000;
    const expectedAt = hasPrediction ? predicted : plannedAt + (delay === null ? 0 : delay * 60_000);
    const key = `${text(item.name, 80)}|${line}|${destination}|${plannedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    departures.push({ key, line, destination, plannedAt, expectedAt, hasPrediction,
      ...destinationArrival(item.passList, plannedAt, expectedAt),
      delay: hasPrediction ? Math.round((expectedAt - plannedAt) / 60_000) : delay,
      platform: text(stop.prognosis?.platform, 32) || text(stop.platform, 32) });
  }
  // A nonempty response with no usable rows is malformed, not an empty service.
  if (payload.stationboard.length && !departures.length) throw new Error('invalid_departures');
  // Validate the response before filtering: opposite-direction services form a valid empty result.
  return departures.filter(item => matchesTransportDirection(item.destination))
    .sort((a, b) => a.expectedAt - b.expectedAt || a.plannedAt - b.plannedAt);
}

export function upcomingDepartures(departures, now = Date.now(), limit = 6) {
  return departures.filter(item => item.expectedAt >= now && item.expectedAt <= now + 48 * 60 * 60_000).slice(0, limit);
}

export function departureCountdown(departure, now = Date.now()) {
  const remaining = departure.expectedAt - now;
  if (remaining < 0) return 'Parti';
  if (remaining <= 30_000) return 'Imminent';
  if (remaining < 60 * 60_000) return `${Math.ceil(remaining / 60_000)} min`;
  const day = dateFormat.format(new Date(departure.expectedAt));
  return day === dateFormat.format(new Date(now)) ? transportTime(departure.expectedAt) : `${dayFormat.format(new Date(departure.expectedAt))} · ${transportTime(departure.expectedAt)}`;
}
