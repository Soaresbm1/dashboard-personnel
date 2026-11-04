export const MYABACUS_CHANNEL = 'myabacus-local-v1';
export const MYABACUS_HEARTBEAT_TTL_MS = 90_000;
export const MYABACUS_READ_STALE_MS = 15 * 60_000;
// Compatibility export: captures become old after this interval; they do not expire.
export const MYABACUS_CAPTURE_TTL_MS = 15 * 60_000;
export const MYABACUS_CAPTURE_VERSION = '1.1.1';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit'
});
const numberFormatter = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 2 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const decimal = (value, maximum) => typeof value === 'number' && Number.isFinite(value)
  && Math.abs(value) <= maximum && Math.round(value * 100) / 100 === value;
const validDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
};

export function myAbacusZurichDate(now = Date.now()) {
  if (!timestamp(now)) return '';
  const parts = Object.fromEntries(dayFormatter.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// The bridge is a source of untrusted data. Copy only the small, typed contract;
// no HTML, identifiers, URLs or credentials are accepted from it.
export function normalizeMyAbacusResult(result, now = Date.now()) {
  if (!timestamp(now) || !record(result) || result.ok !== true) return null;
  let metadata = {};
  if (result.mode === 'capture') {
    if (!['1.1.0', MYABACUS_CAPTURE_VERSION].includes(result.version) || !['idle', 'reading', 'attention'].includes(result.captureState)
      || !['', 'account', 'unavailable', 'timeout', 'user_interaction'].includes(result.reason)
      || !timestamp(result.nextAttemptAt)) return null;
    metadata = { mode: 'capture', version: result.version, captureState: result.captureState,
      reason: result.reason, nextAttemptAt: result.nextAttemptAt };
  } else if (result.mode !== undefined || result.version !== undefined && result.version !== '1.0.1') return null;
  if (result.state === 'empty') return result.snapshot === null ? Object.freeze({ ...metadata, state: 'empty', snapshot: null }) : null;
  if (result.state !== 'ready' || !record(result.snapshot)) return null;
  const input = result.snapshot;
  const today = myAbacusZurichDate(now), capture = metadata.mode === 'capture';
  if (input.schemaVersion !== 1 || !validDate(input.sourceDate)
    || (capture ? input.sourceDate > today : input.sourceDate !== today)
    || !decimal(input.timeBalanceHours, 10_000) || !decimal(input.vacationRemainingDays, 3660)
    || !(input.vacationAvailableDays === null || decimal(input.vacationAvailableDays, 3660))
    || !timestamp(input.readAt) || !timestamp(input.seenAt) || input.readAt > input.seenAt
    || input.readAt > now + 5000 || input.seenAt > now + 5000
    || !capture && now - input.seenAt >= MYABACUS_HEARTBEAT_TTL_MS) return null;
  const snapshot = Object.freeze({
    schemaVersion: 1, sourceDate: input.sourceDate,
    timeBalanceHours: Object.is(input.timeBalanceHours, -0) ? 0 : input.timeBalanceHours,
    vacationRemainingDays: Object.is(input.vacationRemainingDays, -0) ? 0 : input.vacationRemainingDays,
    vacationAvailableDays: Object.is(input.vacationAvailableDays, -0) ? 0 : input.vacationAvailableDays,
    readAt: input.readAt, seenAt: input.seenAt
  });
  const stale = now - input.readAt >= MYABACUS_READ_STALE_MS
    || capture && (metadata.captureState === 'attention' || input.sourceDate !== today);
  return Object.freeze({ ...metadata, state: stale ? 'stale' : 'ready', snapshot });
}

// Only the legacy heartbeat mode expires. Capture data survives an unavailable
// source, while readAt and sourceDate continue to describe its actual age.
export function myAbacusExpiry(snapshot, now = Date.now(), mode = 'legacy') {
  if (mode === 'capture') return null;
  let high = snapshot.seenAt + MYABACUS_HEARTBEAT_TTL_MS;
  if (myAbacusZurichDate(high) === snapshot.sourceDate) return high;
  let low = now;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (myAbacusZurichDate(middle) === snapshot.sourceDate) low = middle;
    else high = middle;
  }
  return high;
}

export function myAbacusNextDateChange(now = Date.now()) {
  if (!timestamp(now) || !timestamp(now + 26 * 60 * 60_000)) return null;
  const today = myAbacusZurichDate(now);
  let low = now, high = now + 26 * 60 * 60_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (myAbacusZurichDate(middle) === today) low = middle; else high = middle;
  }
  return high;
}

export function formatMyAbacusHours(value) {
  return `${value > 0 ? '+' : ''}${numberFormatter.format(Object.is(value, -0) ? 0 : value)} h`;
}

export function formatMyAbacusDays(value) {
  return `${numberFormatter.format(Object.is(value, -0) ? 0 : value)} j`;
}
