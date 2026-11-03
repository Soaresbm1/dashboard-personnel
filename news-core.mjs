import { INTRANET_ORIGIN } from './intranet-core.mjs';

export const NEWS_API_URL = `${INTRANET_ORIGIN}/api/dashboard/v1/news`;
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function safeNewsUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value, INTRANET_ORIGIN);
    return url.origin === INTRANET_ORIGIN && !url.username && !url.password && url.pathname === '/intranet'
      && /^\?page=[1-9]\d*$/.test(url.search) && /^#post-[1-9]\d*$/.test(url.hash) ? url.href : null;
  } catch { return null; }
}

export function normalizeNewsResponse(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.news) || value.meta?.selection !== 'important') throw new Error('Invalid news response');
  const seen = new Set(), news = [];
  for (const item of value.news.slice(0, 5)) {
    if (!item || item.isImportant !== true) continue;
    const id = text(String(item.id ?? ''), 100), title = text(item.title, 300);
    const publishedAt = typeof item.publishedAt === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(item.publishedAt) ? new Date(item.publishedAt) : null;
    if (!id || !title || seen.has(id) || !publishedAt || !Number.isFinite(+publishedAt)) continue;
    seen.add(id);
    news.push({ id, title, excerpt: text(item.excerpt, 240), publishedAt, isPinned: item.isPinned === true,
      label: text(item.label, 80), url: safeNewsUrl(item.url) });
  }
  return { news, hasMore: value.meta.hasMore === true || value.news.length > 5 };
}

export function newsDateLabel(date) {
  return new Intl.DateTimeFormat('fr-CH', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}
