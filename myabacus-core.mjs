export const MYABACUS_CHANNEL = 'myabacus-local-v1';
export const MYABACUS_HEARTBEAT_TTL_MS = 90_000;
export const MYABACUS_READ_STALE_MS = 15 * 60_000;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit'
});
const numberFormatter = new Intl.NumberFormat('fr-CH', { maximumFractionDigits: 2 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const decimal = (value, maximum) => typeof value === 'number' && Number.isFinite(value)
  && Math.abs(value) <= maximum && Math.round(value * 100) / 100 === value;

export function myAbacusZurichDate(now = Date.now()) {
  if (!timestamp(now)) return '';
  const parts = Object.fromEntries(dayFormatter.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// The bridge is a source of untrusted data. Copy only the small, typed contract;
// no HTML, identifiers, URLs or credentials are accepted from it.
export function normalizeMyAbacusResult(result, now = Date.now()) {
  if (!timestamp(now) || !record(result) || result.ok !== true) return null;
  if (result.state === 'empty') return result.snapshot === null ? Object.freeze({ state: 'empty', snapshot: null }) : null;
  if (result.state !== 'ready' || !record(result.snapshot)) return null;
  const input = result.snapshot;
  if (input.schemaVersion !== 1 || typeof input.sourceDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.sourceDate) || input.sourceDate !== myAbacusZurichDate(now)
    || !decimal(input.timeBalanceHours, 10_000) || !decimal(input.vacationRemainingDays, 3660)
    || !(input.vacationAvailableDays === null || decimal(input.vacationAvailableDays, 3660))
    || !timestamp(input.readAt) || !timestamp(input.seenAt) || input.readAt > input.seenAt
    || input.readAt > now + 5000 || input.seenAt > now + 5000
    || now - input.seenAt >= MYABACUS_HEARTBEAT_TTL_MS) return null;
  const snapshot = Object.freeze({
    schemaVersion: 1, sourceDate: input.sourceDate,
    timeBalanceHours: Object.is(input.timeBalanceHours, -0) ? 0 : input.timeBalanceHours,
    vacationRemainingDays: Object.is(input.vacationRemainingDays, -0) ? 0 : input.vacationRemainingDays,
    vacationAvailableDays: Object.is(input.vacationAvailableDays, -0) ? 0 : input.vacationAvailableDays,
    readAt: input.readAt, seenAt: input.seenAt
  });
  return Object.freeze({ state: now - input.readAt >= MYABACUS_READ_STALE_MS ? 'stale' : 'ready', snapshot });
}

// Expiry also happens at the Zurich day change, even if the last heartbeat was
// received a few seconds before midnight. Search only inside the short TTL.
export function myAbacusExpiry(snapshot, now = Date.now()) {
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

export function formatMyAbacusHours(value) {
  return `${value > 0 ? '+' : ''}${numberFormatter.format(Object.is(value, -0) ? 0 : value)} h`;
}

export function formatMyAbacusDays(value) {
  return `${numberFormatter.format(Object.is(value, -0) ? 0 : value)} j`;
}
