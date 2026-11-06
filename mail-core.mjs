// Inbox metadata only. No message bodies, attachments, storage or browser side effects.
export const MAIL_SCOPES = Object.freeze(['Mail.ReadBasic']);
export const MAIL_PREVIEW_LIMIT = 5;
export const MAIL_PREVIEW_PAGES = 3;
const MESSAGE_PATH = '/v1.0/me/mailFolders/inbox/messages';
const FOLDER_PATH = '/v1.0/me/mailFolders/inbox';

export function mailListUrl(filter = 'unread') {
  const url = new URL(`https://graph.microsoft.com${MESSAGE_PATH}`);
  url.searchParams.set('$select', 'id,subject,from,receivedDateTime,importance,isRead,webLink');
  // Graph requires the ordered property to precede isRead in $filter.
  if (filter !== 'recent') url.searchParams.set('$filter', 'receivedDateTime ge 0001-01-01T00:00:00Z and isRead eq false');
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  url.searchParams.set('$top', String(MAIL_PREVIEW_LIMIT));
  return url.href;
}

export function inboxUnreadCountUrl() {
  const url = new URL(`https://graph.microsoft.com${FOLDER_PATH}`);
  url.searchParams.set('$select', 'unreadItemCount');
  return url.href;
}

export function safeMailGraphUrl(value, { messagesOnly = false } = {}) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const path = url.pathname.toLowerCase();
    if (url.origin !== 'https://graph.microsoft.com' || url.username || url.password || url.hash) return null;
    if (url.searchParams.has('$expand')) return null;
    const selected = url.searchParams.get('$select');
    const allowed = path === MESSAGE_PATH.toLowerCase() ? ['id', 'subject', 'from', 'receivedDateTime', 'importance', 'isRead', 'webLink'] : ['unreadItemCount'];
    if (selected && selected.split(',').some(property => !allowed.includes(property.trim()))) return null;
    return path === MESSAGE_PATH.toLowerCase() || !messagesOnly && path === FOLDER_PATH.toLowerCase() ? url.href : null;
  } catch { return null; }
}

export function safeMailWebLink(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

export function normalizeUnreadCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2147483647 ? value : null;
}

export function normalizeMailMessages(values, filter = 'unread') {
  if (!Array.isArray(values)) return [];
  const messages = [], seen = new Set();
  for (const value of values) {
    if (!value || typeof value.id !== 'string' || !value.id || seen.has(value.id)) continue;
    if (typeof value.isRead !== 'boolean' || filter !== 'recent' && value.isRead !== false) continue;
    if (typeof value.receivedDateTime !== 'string' || !/(?:z|[+-]\d{2}:\d{2})$/i.test(value.receivedDateTime)) continue;
    const receivedAt = new Date(value.receivedDateTime.replace(/(\.\d{3})\d+/, '$1'));
    if (!Number.isFinite(receivedAt.getTime())) continue;
    seen.add(value.id);
    const email = value.from?.emailAddress;
    messages.push({
      id: value.id.slice(0, 1500),
      subject: (typeof value.subject === 'string' ? value.subject.trim().slice(0, 300) : '') || 'Sans objet',
      senderName: typeof email?.name === 'string' ? email.name.trim().slice(0, 200) : '',
      senderAddress: typeof email?.address === 'string' ? email.address.trim().slice(0, 250) : '',
      receivedAt, importance: value.importance === 'high' ? 'high' : value.importance === 'low' ? 'low' : 'normal',
      isRead: value.isRead === true, url: safeMailWebLink(value.webLink)
    });
  }
  return messages.sort((a, b) => b.receivedAt - a.receivedAt || a.id.localeCompare(b.id)).slice(0, MAIL_PREVIEW_LIMIT);
}

export function mailDateLabel(date, now = new Date()) {
  const isToday = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat('fr-CH', { ...(isToday ? {} : { day: 'numeric', month: 'short' }), hour: '2-digit', minute: '2-digit' }).format(date);
}
