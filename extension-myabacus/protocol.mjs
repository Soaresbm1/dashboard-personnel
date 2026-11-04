export const SESSION_KEY = 'myabacus-snapshot-v1';
export const HEARTBEAT_TTL_MS = 90_000;
export const MAX_MESSAGE_BYTES = 4_096;

const SOURCE_ORIGIN = 'https://abaprod.isp-spi.ch';
const DASHBOARD_ORIGIN = 'https://soaresbm1.github.io';
const SNAPSHOT_KEYS = ['schemaVersion', 'sourceDate', 'timeBalanceHours', 'vacationRemainingDays', 'vacationAvailableDays'];
const encoder = new TextEncoder();

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function keysAre(value, expected) {
  return record(value) && Object.getOwnPropertySymbols(value).length === 0
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function boundedDecimal(value, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maximum
    && Number(value.toFixed(2)) === value;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
}

export function zurichDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}

export function validateSnapshot(snapshot, now) {
  return keysAre(snapshot, SNAPSHOT_KEYS) && snapshot.schemaVersion === 1
    && validDate(snapshot.sourceDate) && snapshot.sourceDate === zurichDate(now)
    && boundedDecimal(snapshot.timeBalanceHours, 10_000)
    && boundedDecimal(snapshot.vacationRemainingDays, 3_660)
    && (snapshot.vacationAvailableDays === null || boundedDecimal(snapshot.vacationAvailableDays, 3_660));
}

function copySnapshot(snapshot) {
  return Object.fromEntries(SNAPSHOT_KEYS.map(key => [key, snapshot[key]]));
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

function ownerOf(sender) {
  return { tabId: sender.tab.id, documentId: sender.documentId ?? null };
}

function sameOwner(left, right) {
  return left.tabId === right.tabId && left.documentId === right.documentId;
}

function senderIsInternal(sender, extensionId) {
  return record(sender) && sender.id === extensionId && typeof extensionId === 'string' && extensionId.length > 0
    && sender.frameId === 0 && record(sender.tab) && Number.isSafeInteger(sender.tab.id) && sender.tab.id >= 0
    && (sender.documentId === undefined || typeof sender.documentId === 'string'
      && sender.documentId.length > 0 && sender.documentId.length <= 256 && !/[\u0000-\u001f]/.test(sender.documentId));
}

export function validateRequest(message, sender, { extensionId, now }) {
  if (!record(message)) return { ok: false, error: 'invalid_request' };
  try {
    if (encoder.encode(JSON.stringify(message)).length > MAX_MESSAGE_BYTES) return { ok: false, error: 'invalid_request' };
  } catch { return { ok: false, error: 'invalid_request' }; }
  const publishing = message.type === 'MYABACUS_PUBLISH';
  if (!['MYABACUS_PUBLISH', 'MYABACUS_HEARTBEAT', 'MYABACUS_CLEAR', 'MYABACUS_READ'].includes(message.type)
    || !keysAre(message, publishing ? ['type', 'snapshot'] : ['type'])) return { ok: false, error: 'invalid_request' };
  if (!senderIsInternal(sender, extensionId)) return { ok: false, error: 'invalid_sender' };
  const url = safeUrl(sender.url);
  const reading = message.type === 'MYABACUS_READ';
  const origin = reading ? DASHBOARD_ORIGIN : SOURCE_ORIGIN;
  const pathAllowed = reading
    ? url && ['/dashboard-personnel/', '/dashboard-personnel/index.html'].includes(url.pathname)
    : message.type === 'MYABACUS_CLEAR'
      ? url && url.pathname.startsWith('/portal/myabacus/')
      : url && ['/portal/myabacus/proj_inandout', '/portal/myabacus/proj_inandout/'].includes(url.pathname);
  if (!url || url.origin !== origin || sender.origin !== origin || !pathAllowed) return { ok: false, error: 'invalid_sender' };
  if (publishing && !validateSnapshot(message.snapshot, now)) return { ok: false, error: 'invalid_snapshot' };
  return { ok: true, type: message.type, owner: ownerOf(sender), ...(publishing ? { snapshot: copySnapshot(message.snapshot) } : {}) };
}

export function liveState(value, now) {
  if (!keysAre(value, ['schemaVersion', 'owner', 'snapshot']) || value.schemaVersion !== 1
    || !keysAre(value.owner, ['tabId', 'documentId']) || !Number.isSafeInteger(value.owner.tabId) || value.owner.tabId < 0
    || !(value.owner.documentId === null || typeof value.owner.documentId === 'string'
      && value.owner.documentId.length > 0 && value.owner.documentId.length <= 256)
    || !keysAre(value.snapshot, [...SNAPSHOT_KEYS, 'readAt', 'seenAt'])) return null;
  const snapshot = value.snapshot;
  if (!validateSnapshot(copySnapshot(snapshot), now) || !Number.isSafeInteger(snapshot.readAt) || snapshot.readAt < 0
    || !Number.isSafeInteger(snapshot.seenAt) || snapshot.seenAt < snapshot.readAt
    || now < snapshot.seenAt || now - snapshot.seenAt >= HEARTBEAT_TTL_MS) return null;
  return { schemaVersion: 1, owner: { ...value.owner }, snapshot: { ...copySnapshot(snapshot), readAt: snapshot.readAt, seenAt: snapshot.seenAt } };
}

// A validated request is the only input accepted here. No state is mutated in place.
export function transition(previous, request, now) {
  const current = liveState(previous, now);
  if (request.type === 'MYABACUS_READ') {
    return { state: current, response: { ok: true, state: current ? 'ready' : 'empty', snapshot: current ? { ...current.snapshot } : null } };
  }
  if (request.type === 'MYABACUS_PUBLISH') {
    const unchanged = current && sameOwner(current.owner, request.owner)
      && SNAPSHOT_KEYS.every(key => current.snapshot[key] === request.snapshot[key]);
    const next = { schemaVersion: 1, owner: { ...request.owner }, snapshot: {
      ...copySnapshot(request.snapshot), readAt: unchanged ? current.snapshot.readAt : now, seenAt: now,
    } };
    return { state: next, response: { ok: true, state: 'ready' } };
  }
  if (!current) return { state: null, response: { ok: true, state: 'empty' } };
  if (!sameOwner(current.owner, request.owner)) return { state: current, response: { ok: false, error: 'source_mismatch' } };
  if (request.type === 'MYABACUS_CLEAR') return { state: null, response: { ok: true, state: 'empty' } };
  return { state: { ...current, snapshot: { ...current.snapshot, seenAt: now } }, response: { ok: true, state: 'ready' } };
}
