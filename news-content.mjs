import { INTRANET_ORIGIN } from './intranet-core.mjs';
import { safeNewsUrl } from './news-core.mjs';

const allowedTags = new Set(['div', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'li', 'a', 'span']);
const droppedTags = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'template', 'svg', 'math', 'img', 'picture', 'video', 'audio', 'source', 'track', 'canvas', 'noscript', 'base', 'meta', 'link']);

export function safePublicationLink(value, publicationUrl) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value.trim(), safeNewsUrl(publicationUrl) || `${INTRANET_ORIGIN}/intranet`);
    if (url.username || url.password || !['https:', 'http:', 'mailto:'].includes(url.protocol)) return null;
    if (url.protocol === 'mailto:' && (!url.pathname || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.href))) return null;
    return url.href;
  } catch { return null; }
}

export function renderPublicationContent(doc, item) {
  function plainContent() {
    if (!item.content) return null;
    const plain = doc.createElement('p'); plain.className = 'news-item-content'; plain.textContent = item.content;
    return plain;
  }
  if (!item.contentHtml) return plainContent();
  // A detached template is inert. Only newly created, allowlisted nodes reach the page;
  // source attributes, styles, event handlers and resource-loading elements never do.
  const template = doc.createElement('template'); template.innerHTML = item.contentHtml;
  const content = doc.createElement('div'); content.className = 'news-item-content is-rich';
  let nodes = 0;
  const complexityLimit = new Error('Publication formatting limit');
  function copy(source, parent, depth = 0) {
    if (++nodes > 5000 || depth > 128) throw complexityLimit;
    if (source.nodeType === 3) { parent.append(doc.createTextNode(source.textContent)); return; }
    if (source.nodeType !== 1) return;
    const tag = source.localName.toLowerCase();
    if (droppedTags.has(tag)) return;
    if (!allowedTags.has(tag)) { for (const child of source.childNodes) copy(child, parent, depth + 1); return; }
    const href = tag === 'a' ? safePublicationLink(source.getAttribute('href'), item.url) : null;
    const node = doc.createElement(tag === 'a' && !href ? 'span' : tag);
    if (href) { node.href = href; node.target = '_blank'; node.rel = 'noopener noreferrer'; node.referrerPolicy = 'no-referrer'; }
    if (tag === 'span' && /^[1-9]\d*$/.test(source.getAttribute('data-mention-id') || '')) node.className = 'news-mention';
    for (const child of source.childNodes) copy(child, node, depth + 1);
    parent.append(node);
  }
  try { for (const child of template.content.childNodes) copy(child, content); }
  catch (error) { if (error !== complexityLimit) throw error; return plainContent(); }
  return content;
}
