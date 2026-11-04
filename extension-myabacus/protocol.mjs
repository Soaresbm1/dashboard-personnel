export const SESSION_KEY = 'myabacus-capture-v1';
export const HEARTBEAT_TTL_MS = 90_000; // Legacy export; capture validity does not depend on heartbeats.
export const CAPTURE_TTL_MS = 15 * 60_000;
export const CAPTURE_INTERVAL_MS = 10 * 60_000;
export const FORCE_INTERVAL_MS = 30_000;
export const CAPTURE_DEADLINE_MS = 60_000;
export const CLEANUP_ALARM = 'myabacus-capture-cleanup-v1';
export const SOURCE_URL = 'https://abaprod.isp-spi.ch/portal/myabacus/';
export const MAX_MESSAGE_BYTES = 4_096;
export const VERSION = '1.1.0';

const SOURCE_ORIGIN = 'https://abaprod.isp-spi.ch';
const DASHBOARD_ORIGIN = 'https://soaresbm1.github.io';
const SNAPSHOT_KEYS = ['schemaVersion', 'sourceDate', 'timeBalanceHours', 'vacationRemainingDays', 'vacationAvailableDays'];
const DASHBOARD_TYPES = ['MYABACUS_READ', 'MYABACUS_CAPTURE', 'MYABACUS_STOP'];
const SOURCE_TYPES = ['MYABACUS_HELLO', 'MYABACUS_PUBLISH', 'MYABACUS_DONE', 'MYABACUS_CLEAR', 'MYABACUS_RELEASE', 'MYABACUS_FAILURE'];
const FAILURES = ['account', 'context', 'date', 'layout', 'number', 'exception'];
const encoder = new TextEncoder();

export function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function keysAre(value, expected) {
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
export function copySnapshot(snapshot) {
  return Object.fromEntries(SNAPSHOT_KEYS.map(key => [key, snapshot[key]]));
}
function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}
export function sameOwner(left, right) {
  return left?.tabId === right?.tabId && left?.documentId === right?.documentId;
}
function validDocumentId(value) {
  return value === null || typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
}
function senderIsInternal(sender, extensionId) {
  return record(sender) && sender.id === extensionId && typeof extensionId === 'string' && extensionId.length > 0
    && sender.frameId === 0 && record(sender.tab) && Number.isSafeInteger(sender.tab.id) && sender.tab.id >= 0
    && (sender.documentId === undefined || sender.documentId !== null && validDocumentId(sender.documentId))
    && (sender.documentLifecycle === undefined || sender.documentLifecycle === 'active');
}
export function validateRequest(message, sender, { extensionId, now }) {
  if (!record(message)) return { ok: false, error: 'invalid_request' };
  try {
    if (encoder.encode(JSON.stringify(message)).length > MAX_MESSAGE_BYTES) return { ok: false, error: 'invalid_request' };
  } catch { return { ok: false, error: 'invalid_request' }; }
  const publishing = message.type === 'MYABACUS_PUBLISH', failure = message.type === 'MYABACUS_FAILURE';
  const dashboard = DASHBOARD_TYPES.includes(message.type);
  if (!dashboard && !SOURCE_TYPES.includes(message.type)
    || !keysAre(message, publishing ? ['type', 'snapshot'] : failure ? ['type', 'reason'] : ['type'])) return { ok: false, error: 'invalid_request' };
  if (!senderIsInternal(sender, extensionId)) return { ok: false, error: 'invalid_sender' };
  const url = safeUrl(sender.url), origin = dashboard ? DASHBOARD_ORIGIN : SOURCE_ORIGIN;
  const path = url?.pathname.replace(/\/$/, '');
  const pathAllowed = dashboard
    ? url && ['/dashboard-personnel/', '/dashboard-personnel/index.html'].includes(url.pathname)
    : publishing || message.type === 'MYABACUS_DONE'
      ? path === '/portal/myabacus/proj_inandout'
      : ['/portal/myabacus', '/portal/myabacus/welcome', '/portal/myabacus/proj_inandout'].includes(path);
  if (!url || url.origin !== origin || sender.origin !== origin || !pathAllowed) return { ok: false, error: 'invalid_sender' };
  if (publishing && !validateSnapshot(message.snapshot, now)) return { ok: false, error: 'invalid_snapshot' };
  if (failure && !FAILURES.includes(message.reason)) return { ok: false, error: 'invalid_request' };
  return { ok: true, type: message.type, owner: { tabId: sender.tab.id, documentId: sender.documentId ?? null },
    ...(dashboard && Number.isSafeInteger(sender.tab.windowId) && sender.tab.windowId >= 0 ? { windowId: sender.tab.windowId } : {}),
    ...(publishing ? { snapshot: copySnapshot(message.snapshot) } : {}), ...(failure ? { reason: message.reason } : {}) };
}
export function liveSnapshot(value, now) {
  if (!keysAre(value, [...SNAPSHOT_KEYS, 'readAt', 'seenAt']) || !validateSnapshot(copySnapshot(value), now)
    || !Number.isSafeInteger(value.readAt) || value.readAt < 0 || value.seenAt !== value.readAt
    || now < value.readAt || now - value.readAt >= CAPTURE_TTL_MS) return null;
  return { ...copySnapshot(value), readAt: value.readAt, seenAt: value.seenAt };
}
export function emptyCaptureState() {
  return { schemaVersion: 1, snapshot: null, lastAttemptAt: null, captureState: 'idle', reason: '', job: null };
}
export function restoreState(value, now) {
  const result = emptyCaptureState();
  if (!keysAre(value, Object.keys(result)) || value.schemaVersion !== 1) return result;
  result.snapshot = liveSnapshot(value.snapshot, now);
  if (value.lastAttemptAt === null || Number.isSafeInteger(value.lastAttemptAt) && value.lastAttemptAt >= 0) result.lastAttemptAt = value.lastAttemptAt;
  if (['idle', 'reading', 'attention'].includes(value.captureState)) result.captureState = value.captureState;
  if (['', 'account', 'unavailable', 'timeout', 'user_interaction'].includes(value.reason)) result.reason = value.reason;
  const job = value.job;
  if (keysAre(job, ['tabId', 'documentId', 'bound', 'deadlineAt', 'phase'])
    && Number.isSafeInteger(job.tabId) && job.tabId >= 0 && validDocumentId(job.documentId) && typeof job.bound === 'boolean'
    && Number.isSafeInteger(job.deadlineAt) && job.deadlineAt >= 0 && ['reading', 'captured', 'closing'].includes(job.phase)) result.job = { ...job };
  if (result.captureState === 'reading' && !result.job) { result.captureState = 'attention'; result.reason = 'unavailable'; }
  return result;
}
export function publicState(state) {
  return { ok: true, state: state.snapshot ? 'ready' : 'empty', mode: 'capture', version: VERSION,
    captureState: state.captureState, reason: state.reason,
    nextAttemptAt: state.lastAttemptAt === null ? 0 : state.lastAttemptAt + CAPTURE_INTERVAL_MS,
    snapshot: state.snapshot ? { ...state.snapshot } : null };
}
export const liveState = liveSnapshot;
