import { safeMailWebLink } from './mail-core.mjs';
import { safeIntranetItemUrl, intranetStatusLabel, intranetPriority } from './intranet-core.mjs';
import { safeNewsUrl } from './news-core.mjs';

export const NOTIFICATION_LIMIT = 30;
export const NOTIFICATION_SEEN_LIMIT = 1000;
const centers = new WeakMap();
const text = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const milliseconds = value => value instanceof Date ? Number.isFinite(+value) ? +value : null : typeof value === 'number' && Number.isFinite(value) ? value : null;
const closed = new Set(['done', 'completed', 'complete', 'closed', 'cancelled', 'canceled', 'resolved', 'refused']);
const dueFormat = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'short', year: 'numeric' });

export function notificationIdentity(account, config) {
  const client = text(config?.clientId, 100).toLowerCase(), tenant = text(config?.tenantId, 100).toLowerCase();
  const actualTenant = text(account?.tenantId, 100).toLowerCase();
  const objectId = text(account?.idTokenClaims?.oid || account?.localAccountId, 100).toLowerCase();
  return client && tenant && actualTenant === tenant && objectId ? `${client}:${tenant}:${objectId}` : null;
}

export function createNotificationCenter({ now = Date.now, maxNotifications = NOTIFICATION_LIMIT, maxSeen = NOTIFICATION_SEEN_LIMIT } = {}) {
  const limit = Math.max(1, Math.min(100, Number.isInteger(maxNotifications) ? maxNotifications : NOTIFICATION_LIMIT));
  const seenLimit = Math.max(1, Math.min(1000, Number.isInteger(maxSeen) ? maxSeen : NOTIFICATION_SEEN_LIMIT));
  const listeners = new Set();
  let owner = null, items = [], limited = false;
  const freshState = () => ({ ready: false, stale: false });
  const registry = () => ({ seen: new Map(), ready: false, complete: false, overflowed: false });
  let sources, mail, tasks, tickets, news;
  function reset() {
    items = []; limited = false;
    sources = { mail: freshState(), work: freshState(), news: freshState() };
    mail = { ...registry(), startedAt: 0 }; tasks = registry(); tickets = registry();
    news = { ...registry(), watermark: -Infinity };
  }
  reset();
  function getSnapshot() {
    const values = items.map(item => ({ ...item, stale: sources[item.source].stale }))
      .sort((a, b) => Number(a.seen) - Number(b.seen) || b.observedAt - a.observedAt || b.eventAt - a.eventAt || a.id.localeCompare(b.id));
    return { items: values, unseenCount: values.filter(item => !item.seen).length, limited,
      sources: Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, { ...value }])) };
  }
  function emit() {
    for (const callback of listeners) {
      try { callback(getSnapshot()); } catch { /* A view must not interrupt a source refresh. */ }
    }
  }
  function begin(identity, source, at) {
    if (typeof identity !== 'string' || !identity || identity.length > 400) return null;
    if (owner !== null && owner !== identity) { reset(); emit(); }
    owner = identity; sources[source] = { ready: true, stale: false };
    return milliseconds(at) ?? milliseconds(now()) ?? Date.now();
  }
  function remember(state, key, value) {
    if (!state.seen.has(key) && state.seen.size >= seenLimit) {
      state.seen.delete(state.seen.keys().next().value); state.overflowed = true; limited = true;
    }
    state.seen.set(key, value);
  }
  function add({ kind, source, entityId, label, title, detail = '', url = null, observedAt, eventAt = observedAt }) {
    const id = `${kind.startsWith('mail') ? 'mail' : kind.startsWith('task') ? 'task' : kind.startsWith('ticket') ? 'ticket' : 'news'}:${entityId}`;
    const entry = { id, source, kind, entityId, label, title: text(title), detail: text(detail, 400), url, observedAt, eventAt, seen: false };
    items = items.filter(item => item.id !== id);
    items.push(entry);
    if (items.length > limit) { items = items.sort((a, b) => b.observedAt - a.observedAt).slice(0, limit); limited = true; }
  }
  function removeEntity(prefix, id) { items = items.filter(item => item.id !== `${prefix}:${id}`); }
  function ingestMail(snapshot = {}) {
    const at = begin(snapshot.identity, 'mail', snapshot.at); if (at === null) return;
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages.slice(0, seenLimit) : [];
    if (snapshot.unreadCount === 0) {
      items = items.filter(item => item.source !== 'mail');
      if (!mail.ready) mail.startedAt = at;
      mail.ready = true; emit(); return;
    }
    // Other partial previews cannot establish a new-mail baseline.
    if (snapshot.filter !== 'unread') {
      for (const message of messages) if (message?.isRead === true) removeEntity('mail', text(message.id, 1500));
      emit(); return;
    }
    const first = !mail.ready;
    for (const message of messages) {
      const id = text(message?.id, 1500), receivedAt = milliseconds(message?.receivedAt);
      if (!id || receivedAt === null) continue;
      if (message.isRead !== false) { if (message.isRead === true) removeEntity('mail', id); continue; }
      const known = mail.seen.has(id);
      if (!known && !mail.overflowed && (first || receivedAt > mail.startedAt)) {
        add({ kind: first ? 'mail-unread' : 'mail-new', source: 'mail', entityId: id,
          label: first ? 'Mail non lu' : 'Nouveau mail', title: text(message.subject) || 'Sans objet',
          detail: text(message.senderName, 200) || text(message.senderAddress, 250),
          url: typeof message.url === 'string' && message.url.length <= 2000 ? safeMailWebLink(message.url) : null, observedAt: at, eventAt: receivedAt });
      }
      remember(mail, id, true);
    }
    if (first) mail.startedAt = at;
    mail.ready = true; emit();
  }
  function ingestWork(snapshot = {}) {
    const at = begin(snapshot.identity, 'work', snapshot.at); if (at === null || !snapshot.work) return;
    function ingest(kind, state, values, partial) {
      const rows = Array.isArray(values) ? values.slice(0, seenLimit) : [];
      const couldDetectNew = state.ready && state.complete && !state.overflowed;
      for (const row of rows) {
        const id = text(row?.id, 120), title = text(row?.title);
        if (!id || !title) continue;
        const current = { title, status: text(row.status, 40), priority: text(row.priority, 40), dueAt: milliseconds(row.dueAt) };
        const fingerprint = JSON.stringify(current), previous = state.seen.get(id);
        const changed = previous && previous !== fingerprint;
        if (changed || !previous && couldDetectNew && !state.overflowed && !closed.has(current.status.toLowerCase())) {
          const priority = intranetPriority(current.priority).label;
          const detail = [intranetStatusLabel(current.status), priority,
            current.dueAt !== null ? `Échéance : ${dueFormat.format(new Date(current.dueAt))}` : ''].filter(Boolean).join(' · ');
          const label = kind === 'task' ? changed ? 'Tâche mise à jour' : 'Nouvelle tâche attribuée' : changed ? 'Ticket mis à jour' : 'Nouveau ticket attribué';
          const key = kind === 'ticket' ? text(row.key, 40) : '';
          add({ kind: `${kind}-${changed ? 'updated' : 'assigned'}`, source: 'work', entityId: id, label,
            title: key ? `${key} · ${title}` : title, detail, url: safeIntranetItemUrl(row.url), observedAt: at });
        }
        remember(state, id, fingerprint);
      }
      // A first complete snapshot after partial data fills the reference silently.
      state.ready = true;
      if (!partial && Array.isArray(values) && values.length <= seenLimit) state.complete = true;
    }
    ingest('task', tasks, snapshot.work.tasks, snapshot.work.tasksHasMore === true);
    ingest('ticket', tickets, snapshot.work.tickets, snapshot.work.ticketsHasMore === true);
    emit();
  }
  function ingestNews(snapshot = {}) {
    const at = begin(snapshot.identity, 'news', snapshot.at); if (at === null) return;
    const entries = Array.isArray(snapshot.news) ? snapshot.news.slice(0, seenLimit) : [];
    const previousWatermark = news.watermark;
    let valid = 0;
    for (const post of entries) {
      const id = text(post?.id, 100), title = text(post?.title), publishedAt = milliseconds(post?.publishedAt);
      if (!id || !title || publishedAt === null) continue;
      valid++;
      if (news.ready && !news.seen.has(id) && publishedAt > previousWatermark) {
        add({ kind: 'news-published', source: 'news', entityId: id, label: 'Nouvelle publication', title,
          detail: 'Actualités internes', url: safeNewsUrl(post.url), observedAt: at, eventAt: publishedAt });
      }
      remember(news, id, true); news.watermark = Math.max(news.watermark, publishedAt);
    }
    if (!news.ready && !valid) news.watermark = at;
    news.ready = true; emit();
  }
  function clearSource(source) {
    if (!Object.hasOwn(sources, source)) return;
    items = items.filter(item => item.source !== source); sources[source] = freshState();
    if (source === 'mail') mail = { ...registry(), startedAt: 0 };
    if (source === 'work') { tasks = registry(); tickets = registry(); }
    if (source === 'news') news = { ...registry(), watermark: -Infinity };
    if (!Object.values(sources).some(value => value.ready)) { owner = null; limited = false; }
    emit();
  }
  return { ingestMail, ingestWork, ingestNews, clearSource,
    staleSource(source) { if (Object.hasOwn(sources, source)) { sources[source].stale = true; emit(); } },
    markSeen(id) { const item = items.find(value => value.id === id); if (item && !item.seen) { item.seen = true; emit(); } },
    markAllSeen() { if (items.some(item => !item.seen)) { for (const item of items) item.seen = true; emit(); } },
    getSnapshot,
    subscribe(callback) { listeners.add(callback); try { callback(getSnapshot()); } catch { /* Isolate a view. */ } return () => listeners.delete(callback); }
  };
}

export function getNotificationCenter(doc = globalThis.document) {
  if (!doc || typeof doc !== 'object') return null;
  if (!centers.has(doc)) centers.set(doc, createNotificationCenter());
  return centers.get(doc);
}
export const publishMailNotifications = (doc, snapshot) => getNotificationCenter(doc)?.ingestMail(snapshot);
export const publishWorkNotifications = (doc, snapshot) => getNotificationCenter(doc)?.ingestWork(snapshot);
export const publishNewsNotifications = (doc, snapshot) => getNotificationCenter(doc)?.ingestNews(snapshot);
export const clearNotificationSource = (doc, source) => getNotificationCenter(doc)?.clearSource(source);
export const markNotificationSourceStale = (doc, source) => getNotificationCenter(doc)?.staleSource(source);
