import assert from 'node:assert/strict';
import { initializeMailPreview } from '../mail.js';
import { MAIL_SCOPES, mailListUrl, inboxUnreadCountUrl, safeMailGraphUrl, safeMailWebLink, normalizeUnreadCount, normalizeMailMessages } from '../mail-core.mjs';
import { getNotificationCenter } from '../notifications-core.mjs';
import { OUTLOOK_CONFIG_KEY } from '../outlook-core.mjs';
import { MICROSOFT_DEPLOYMENT, microsoftSessionKey, clearMicrosoftSession, connectMicrosoftServices, getMicrosoftClient } from '../microsoft-session.mjs';

process.env.TZ = 'Europe/Zurich';
const config = { clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', tenantId: MICROSOFT_DEPLOYMENT.tenantId };
const owner = { tenantId: config.tenantId, localAccountId: MICROSOFT_DEPLOYMENT.ownerObjectId, homeAccountId: 'fixture-owner', username: 'owner@example.test' };
const mail = { id: 'mail-1', subject: '<img src=x onerror=alert(1)>', from: { emailAddress: { name: '<svg onload=alert(1)>', address: 'sender@example.test' } }, receivedDateTime: '2026-11-03T08:00:00Z', importance: 'high', isRead: false, webLink: 'https://outlook.office.com/mail/read/example', body: { content: 'SECRET BODY' }, bodyPreview: 'SECRET PREVIEW', attachments: ['SECRET ATTACHMENT'] };
const settle = () => new Promise(resolve => setImmediate(resolve));
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const isFolder = url => new URL(url).pathname.toLowerCase().endsWith('/inbox');
const checks = [];
async function test(name, verify) { await verify(); checks.push(name); }

function harness(options = {}) {
  const nodes = new Map(), network = [], sdkCalls = [], storageWrites = [], stored = new Map([[OUTLOOK_CONFIG_KEY, JSON.stringify(config)]]);
  if (options.remembered) stored.set(microsoftSessionKey(config), '1');
  const auto = { config: null, started: false };
  const docListeners = new Map(), winListeners = new Map(), timers = new Map();
  let clock = Date.parse('2026-11-03T12:00:00Z'), timerId = 0, application;
  const add = (map, name, callback) => { if (!map.has(name)) map.set(name, new Set()); map.get(name).add(callback); };
  const remove = (map, name, callback) => map.get(name)?.delete(callback);
  class Element {
    constructor() { this.listeners = new Map(); this.children = []; this.attributes = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.classList = { toggle() {} }; }
    addEventListener(name, callback) { add(this.listeners, name, callback); }
    removeEventListener(name, callback) { remove(this.listeners, name, callback); }
    async trigger(name) { for (const callback of this.listeners.get(name) || []) await callback({ preventDefault() {}, target: this }); }
    click() { return this.trigger('click'); }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children.flatMap(child => child.fragment ? child.children : [child]); }
  }
  for (const id of ['mail-preview', 'mail-connect', 'mail-refresh', 'mail-disconnect', 'mail-account', 'mail-status', 'mail-items', 'mail-unread-count', 'mail-last-updated', 'mail-view-label', 'outlook-config-form', 'outlook-forget-config', 'outlook-configure']) nodes.set(`#${id}`, new Element());
  const document = {
    baseURI: 'https://example.test/dashboard-personnel/', hidden: false,
    querySelector: selector => nodes.get(selector), querySelectorAll: () => [],
    createElement: () => new Element(), createDocumentFragment() { const fragment = new Element(); fragment.fragment = true; return fragment; },
    addEventListener(name, callback) { add(docListeners, name, callback); }, removeEventListener(name, callback) { remove(docListeners, name, callback); }
  };
  const storage = { getItem: key => stored.get(key) ?? null, setItem(key, value) { storageWrites.push([key, value]); stored.set(key, value); }, removeItem: key => stored.delete(key) };
  const window = { navigator: { onLine: true }, localStorage: storage, addEventListener(name, callback) { add(winListeners, name, callback); }, removeEventListener(name, callback) { remove(winListeners, name, callback); } };
  class PublicClientApplication {
    constructor(configuration) { sdkCalls.push(['configuration', configuration]); application = this; this.accounts = options.cachedAccounts || []; this.active = null; }
    async initialize() { sdkCalls.push(['initialize']); await options.initialize?.(); }
    getAllAccounts() { return this.accounts; } getActiveAccount() { return this.active; }
    setActiveAccount(account) { this.active = account; sdkCalls.push(['setActiveAccount', account]); }
    async loginPopup(request) { sdkCalls.push(['loginPopup', request]); if (options.popupError) throw options.popupError; const account = options.loginAccount || owner; this.accounts = [account]; return { account, accessToken: options.popupToken || 'FIXTURE TOKEN' }; }
    async acquireTokenSilent(request) { sdkCalls.push(['acquireTokenSilent', request]); const error = typeof options.silentError === 'function' ? options.silentError() : options.silentError; if (error) throw error; if (options.acquireTokenSilent) return options.acquireTokenSilent(request); return { account: owner, accessToken: options.silentToken || 'FIXTURE TOKEN' }; }
    async clearCache(request) { sdkCalls.push(['clearCache', request]); await options.cacheClear?.(); this.accounts = this.accounts.filter(account => account !== request?.account); }
  }
  class InteractionRequiredAuthError extends Error {}
  const instance = initializeMailPreview({
    document, window, storage, now: () => new Date(clock),
    loadSdk: async () => ({ PublicClientApplication, InteractionRequiredAuthError }),
    autoRefreshFactory: options.realAutoRefresh ? undefined : settings => { auto.config = settings; return { start() { auto.started = true; }, stop() { auto.started = false; }, dispose() { auto.started = false; } }; },
    autoRefreshOptions: { nowMs: () => clock, setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: clock + delay, callback }); return id; }, clearTimeout: id => timers.delete(id) },
    fetch: async (url, request) => { network.push([url, request]); return options.fetch ? options.fetch(url, request, network.length) : isFolder(url) ? json({ unreadItemCount: 17 }) : json({ value: [mail] }); }
  });
  async function advance(milliseconds) {
    const end = clock + milliseconds;
    while (true) { const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [id, timer] = next; timers.delete(id); clock = timer.at; timer.callback(); await settle(); }
    clock = end; await settle();
  }
  const dispatch = (listeners, event) => { for (const callback of listeners.get(event.type) || []) callback(event); };
  return { nodes, network, sdkCalls, stored, storageWrites, storage, instance, auto, document, window, advance,
    get application() { return application; },
    addTime(milliseconds) { clock += milliseconds; },
    setHidden(hidden) { document.hidden = hidden; dispatch(docListeners, { type: 'visibilitychange' }); },
    setOnline(online) { window.navigator.onLine = online; dispatch(winListeners, { type: online ? 'online' : 'offline' }); },
    storageEvent(key, newValue) { dispatch(winListeners, { type: 'storage', key, newValue }); }
  };
}
const text = node => [node.textContent || '', ...node.children.map(text)].join(' ');

await test('The only requested delegated mail scope is Mail.ReadBasic', () => assert.deepEqual(MAIL_SCOPES, ['Mail.ReadBasic']));
await test('Inbox queries select metadata only and satisfy Graph filter/order rules', () => {
  const unread = new URL(mailListUrl()), recent = new URL(mailListUrl('recent'));
  assert.equal(unread.pathname, '/v1.0/me/mailFolders/inbox/messages');
  assert.equal(unread.searchParams.get('$top'), '5');
  assert.equal(unread.searchParams.get('$orderby'), 'receivedDateTime desc');
  assert.ok(unread.searchParams.get('$filter').startsWith('receivedDateTime ge '));
  assert.ok(unread.searchParams.get('$filter').endsWith('isRead eq false'));
  assert.equal(recent.searchParams.get('$filter'), null);
  assert.equal(recent.searchParams.get('$top'), '5');
  assert.equal(recent.searchParams.get('$orderby'), 'receivedDateTime desc');
  assert.equal(unread.searchParams.get('$select'), 'id,subject,from,receivedDateTime,importance,isRead,webLink');
  assert.equal(new URL(inboxUnreadCountUrl()).searchParams.get('$select'), 'unreadItemCount');
});
await test('Pagination only permits HTTPS Graph inbox routes and rejects expanded or forbidden properties', () => {
  assert.ok(safeMailGraphUrl(mailListUrl(), { messagesOnly: true }));
  for (const address of ['https://graph.microsoft.com.evil.test/v1.0/me/mailFolders/inbox/messages', 'https://user@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages', 'https://graph.microsoft.com/v1.0/me/messages', 'http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages', 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$select=body', 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$expand=attachments']) assert.equal(safeMailGraphUrl(address, { messagesOnly: true }), null);
  assert.equal(safeMailGraphUrl(inboxUnreadCountUrl(), { messagesOnly: true }), null);
});
await test('Message links only allow exact HTTPS Outlook hosts', () => {
  assert.ok(safeMailWebLink(mail.webLink));
  for (const address of ['javascript:alert(1)', 'https://outlook.office.com.evil.test/mail', 'http://outlook.office.com/mail', 'https://user@outlook.office.com/mail', 'https://outlook.office.com:444/mail']) assert.equal(safeMailWebLink(address), null);
});
await test('Normalization strips body and attachment properties, sorts descending, deduplicates, filters and caps at five', () => {
  const messages = Array.from({ length: 7 }, (_, index) => ({ ...mail, id: String(index), receivedDateTime: `2026-11-03T0${index}:00:00Z` }));
  const normalized = normalizeMailMessages([...messages, messages[0], { ...mail, id: 'read', isRead: true }]);
  assert.equal(normalized.length, 5); assert.equal(normalized[0].id, '6');
  assert.ok(!JSON.stringify(normalized).includes('SECRET'));
  assert.equal(normalizeMailMessages([{ ...mail, isRead: true }], 'unread').length, 0);
  assert.equal(normalizeMailMessages([{ ...mail, isRead: true }], 'recent').length, 1);
  assert.equal(normalizeMailMessages([{ ...mail, isRead: null }], 'recent').length, 0);
});
await test('Unread count rejects malformed or unsafe counts', () => { assert.equal(normalizeUnreadCount(0), 0); for (const count of [-1, '17', 1.2, Infinity, 2147483648]) assert.equal(normalizeUnreadCount(count), null); });
await test('Initialization never starts a popup or mail request without the remembered owner', async () => {
  const h = harness(); await settle(); assert.equal(h.network.length, 0); assert.equal(h.sdkCalls.filter(call => call[0] === 'loginPopup').length, 0); assert.equal(h.nodes.get('#mail-unread-count').textContent, '—'); h.instance.dispose();
});
await test('Explicit connect requests only Mail.ReadBasic, uses GET only, renders literal text and persists no mail content or token', async () => {
  const h = harness(); await settle(); await h.instance.connect();
  assert.deepEqual(h.sdkCalls.find(call => call[0] === 'loginPopup')[1].scopes, ['Mail.ReadBasic']);
  assert.equal(h.network.length, 2); assert.ok(h.network.every(([, request]) => request.method === 'GET' && request.redirect === 'error' && request.headers.Authorization === 'Bearer FIXTURE TOKEN'));
  assert.ok(text(h.nodes.get('#mail-items')).includes(mail.subject)); assert.ok(text(h.nodes.get('#mail-items')).includes(mail.from.emailAddress.name));
  assert.ok(!text(h.nodes.get('#mail-items')).includes('SECRET'));
  assert.equal(h.nodes.get('#mail-unread-count').textContent, '17'); assert.ok(h.nodes.get('#mail-unread-count').attributes['aria-label'].includes('boîte de réception'));
  assert.deepEqual(h.storageWrites, [[microsoftSessionKey(config), '1']]); assert.ok(!JSON.stringify([...h.stored]).includes('FIXTURE TOKEN')); h.instance.dispose();
});
await test('A remembered owner is restored silently and a non-owner cannot read any mail', async () => {
  const h = harness({ remembered: true, cachedAccounts: [owner] }); await settle(); assert.equal(h.network.length, 2); assert.equal(h.sdkCalls.filter(call => call[0] === 'loginPopup').length, 0); h.instance.dispose();
  const other = harness({ remembered: true, cachedAccounts: [{ ...owner, localAccountId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }] }); await settle(); assert.equal(other.network.length, 0); other.instance.dispose();
  const selected = harness({ loginAccount: { ...owner, localAccountId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } }); await settle(); await selected.instance.connect(); assert.equal(selected.network.length, 0); selected.instance.dispose();
});
await test('Missing mail consent requests an explicit click and never opens an automatic popup', async () => {
  const h = harness({ remembered: true, cachedAccounts: [owner], silentError: { errorCode: 'consent_required' } }); await settle();
  assert.equal(h.network.length, 0); assert.equal(h.sdkCalls.filter(call => call[0] === 'loginPopup').length, 0); assert.equal(h.nodes.get('#mail-connect').textContent, 'Autoriser les mails Outlook'); assert.equal(h.auto.started, false); h.instance.dispose();
});
await test('The five-message preview follows trusted short pages and labels the total unread count separately', async () => {
  let pages = 0;
  const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: 91 }) : json({ value: Array.from({ length: ++pages === 1 ? 2 : 4 }, (_, index) => ({ ...mail, id: `${pages}-${index}` })), '@odata.nextLink': `${mailListUrl()}&$skip=${pages * 2}` }) }); await settle(); await h.instance.connect();
  assert.equal(h.network.length, 3); assert.equal(h.nodes.get('#mail-items').children.length, 5); assert.ok(h.nodes.get('#mail-status').textContent.includes('5 derniers')); assert.equal(h.nodes.get('#mail-unread-count').textContent, '91'); h.instance.dispose();
});
await test('A foreign pagination link is never requested with a token', async () => {
  const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: 17 }) : json({ value: [mail], '@odata.nextLink': 'https://evil.test/collect' }) }); await settle(); await h.instance.connect(); assert.equal(h.network.length, 2); assert.equal(h.nodes.get('#mail-status').dataset.state, 'error'); h.instance.dispose();
});

await test('One unread mail appears alone; reading it switches automatically to five recent mails and a new unread switches back', async () => {
  let unread = 1;
  const recent = Array.from({ length: 8 }, (_, index) => ({ ...mail, id: `recent-${index}`, subject: `Recent ${index}`, isRead: true, receivedDateTime: `2026-11-03T0${index}:00:00Z` }));
  const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: unread }) : json({ value: new URL(url).searchParams.has('$filter') ? [{ ...mail, subject: unread === 2 ? 'Nouveau non lu' : 'Seul non lu' }] : recent }) });
  await settle(); await h.instance.connect();
  assert.equal(h.nodes.get('#mail-items').children.length, 1);
  assert.ok(text(h.nodes.get('#mail-items')).includes('Seul non lu'));
  assert.equal(h.nodes.get('#mail-view-label').textContent, 'Non lus');
  assert.equal(getNotificationCenter(h.document).getSnapshot().items.length, 1);
  unread = 0; h.addTime(60000); await h.auto.config.refresh();
  assert.equal(h.nodes.get('#mail-items').children.length, 5);
  assert.ok(text(h.nodes.get('#mail-items')).includes('Recent 7'));
  assert.ok(!text(h.nodes.get('#mail-items')).includes('Seul non lu'));
  assert.equal(h.nodes.get('#mail-view-label').textContent, '5 derniers mails');
  assert.equal(h.nodes.get('#mail-unread-count').textContent, '0');
  assert.equal(getNotificationCenter(h.document).getSnapshot().items.length, 0);
  unread = 2; h.addTime(60000); await h.auto.config.refresh();
  assert.equal(h.nodes.get('#mail-items').children.length, 1);
  assert.ok(text(h.nodes.get('#mail-items')).includes('Nouveau non lu'));
  assert.ok(!text(h.nodes.get('#mail-items')).includes('Recent'));
  assert.equal(h.nodes.get('#mail-view-label').textContent, 'Non lus');
  assert.ok(h.network.every(([, request]) => request.method === 'GET'));
  h.instance.dispose();
});
await test('An empty inbox is empty, and fewer than five read mails are all shown without notifications', async () => {
  for (const count of [0, 3]) {
    const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: 0 }) : json({ value: Array.from({ length: count }, (_, index) => ({ ...mail, id: `read-${index}`, isRead: true })) }) });
    await settle(); await h.instance.connect();
    assert.equal(h.nodes.get('#mail-view-label').textContent, '5 derniers mails');
    assert.equal(getNotificationCenter(h.document).getSnapshot().items.length, 0);
    if (count) assert.equal(h.nodes.get('#mail-items').children.length, count);
    else assert.ok(text(h.nodes.get('#mail-items')).includes('Aucun mail à afficher'));
    h.instance.dispose();
  }
});
await test('A mail arriving between the count and recent query triggers an unread-only request before rendering', async () => {
  const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: 0 }) : json({ value: new URL(url).searchParams.has('$filter') ? [mail] : [mail, { ...mail, id: 'read', subject: 'Doit rester masqué', isRead: true }] }) });
  await settle(); await h.instance.connect();
  assert.equal(h.network.length, 3);
  assert.equal(h.nodes.get('#mail-items').children.length, 1);
  assert.ok(!text(h.nodes.get('#mail-items')).includes('Doit rester masqué'));
  assert.equal(h.nodes.get('#mail-view-label').textContent, 'Non lus');
  h.instance.dispose();
});
await test('An unavailable unread count never becomes zero or triggers the recent-mail fallback', async () => {
  let fail = false;
  const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: fail ? null : 1 }) : json({ value: [mail] }) });
  await settle(); await h.instance.connect(); const first = h.nodes.get('#mail-items').children[0];
  fail = true; await h.auto.config.refresh();
  assert.equal(h.network.length, 3); assert.equal(h.nodes.get('#mail-items').children[0], first);
  assert.equal(h.nodes.get('#mail-view-label').textContent, 'Non lus');
  assert.equal(h.nodes.get('#mail-status').dataset.state, 'error'); h.instance.dispose();
});
await test('Auto-refresh runs every minute, pauses hidden/offline and preserves unchanged list nodes', async () => {
  const h = harness({ remembered: true, cachedAccounts: [owner], realAutoRefresh: true }); await settle(); const first = h.nodes.get('#mail-items').children[0];
  await h.advance(59999); assert.equal(h.network.length, 2); await h.advance(1); assert.equal(h.network.length, 4); assert.equal(h.nodes.get('#mail-items').children[0], first);
  h.setHidden(true); await h.advance(180000); assert.equal(h.network.length, 4); h.setHidden(false); await h.advance(0); assert.equal(h.network.length, 6);
  h.setOnline(false); await h.advance(180000); assert.equal(h.network.length, 6); h.setOnline(true); await h.advance(0); assert.equal(h.network.length, 8); h.instance.dispose();
});
await test('Automatic refresh retains the last good preview and timestamp on a transient error, and does not overlap', async () => {
  let calls = 0, finish;
  const h = harness({ fetch: url => isFolder(url) ? ++calls === 1 ? json({ unreadItemCount: 17 }) : new Promise(resolve => { finish = resolve; }) : json({ value: [mail] }) }); await settle(); await h.instance.connect();
  const first = h.nodes.get('#mail-items').children[0], updated = h.nodes.get('#mail-last-updated').textContent;
  h.addTime(60000); const pending = h.auto.config.refresh(); await settle(); await h.auto.config.refresh(); assert.equal(h.network.length, 3); assert.equal(h.nodes.get('#mail-items').children[0], first);
  finish(json({}, 503)); await pending; assert.equal(h.nodes.get('#mail-items').children[0], first); assert.equal(h.nodes.get('#mail-last-updated').textContent, updated); assert.ok(h.nodes.get('#mail-status').textContent.includes(updated.replace('Actualisé le ', ''))); h.instance.dispose();
});
await test('A 401 or 403 clears mail metadata and stops automatic refresh until explicit authorization', async () => {
  for (const status of [401, 403]) {
    let folders = 0;
    const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: 17 }, ++folders === 1 ? 200 : status) : json({ value: [mail] }) }); await settle(); await h.instance.connect(); await h.auto.config.refresh();
    assert.ok(!text(h.nodes.get('#mail-items')).includes(mail.subject)); assert.equal(h.nodes.get('#mail-unread-count').textContent, '—'); assert.equal(h.nodes.get('#mail-last-updated').textContent, ''); assert.equal(h.auto.started, false); assert.equal(h.nodes.get('#mail-connect').textContent, 'Autoriser les mails Outlook'); h.instance.dispose();
  }
});

await test('Retry-After prevents both manual and automatic refresh from bypassing throttling', async () => {
  let folders = 0;
  const h = harness({ fetch: url => isFolder(url) ? ++folders === 2 ? json({}, 429, { 'Retry-After': '120' }) : json({ unreadItemCount: 17 }) : json({ value: [mail] }) }); await settle(); await h.instance.connect(); await h.auto.config.refresh();
  const size = h.network.length; assert.equal(h.nodes.get('#mail-refresh').disabled, true);
  await h.instance.refresh(); await h.auto.config.refresh(); assert.equal(h.network.length, size);
  assert.equal(h.nodes.get('#mail-view-label').textContent, 'Non lus');
  assert.ok(text(h.nodes.get('#mail-items')).includes(mail.subject)); h.instance.dispose();
});
await test('Manual refresh cancels an automatic request and ignores its late mail response', async () => {
  let lists = 0, finish;
  const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: 17 }) : ++lists === 2 ? new Promise(resolve => { finish = resolve; }) : json({ value: [{ ...mail, subject: lists === 3 ? 'Manuel récent' : mail.subject }] }) }); await settle(); await h.instance.connect(); const automatic = h.auto.config.refresh(); await settle(); await h.instance.refresh(); assert.equal(h.network[3][1].signal.aborted, true); finish(json({ value: [{ ...mail, subject: 'Trop tard' }] })); await automatic; assert.ok(text(h.nodes.get('#mail-items')).includes('Manuel récent')); assert.ok(!text(h.nodes.get('#mail-items')).includes('Trop tard')); h.instance.dispose();
});
await test('Global Microsoft sign-out clears mails before a late request returns', async () => {
  let lists = 0, finish;
  const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: 17 }) : ++lists === 2 ? new Promise(resolve => { finish = resolve; }) : json({ value: [mail] }) }); await settle(); await h.instance.connect(); const automatic = h.auto.config.refresh(); await settle();
  await clearMicrosoftSession({ application: h.application, account: owner, config, storage: h.storage, window: h.window });
  finish(json({ value: [mail] })); await automatic; assert.ok(!text(h.nodes.get('#mail-items')).includes(mail.subject)); assert.equal(h.nodes.get('#mail-unread-count').textContent, '—'); assert.equal(h.stored.has(microsoftSessionKey(config)), false); assert.equal(h.auto.started, false); h.instance.dispose();
});
await test('Cross-tab sign-out and Outlook configuration changes invalidate the previous preview without a popup', async () => {
  const h = harness(); await settle(); await h.instance.connect(); h.storageEvent(microsoftSessionKey(config), null); assert.ok(!text(h.nodes.get('#mail-items')).includes(mail.subject)); assert.equal(h.auto.started, false); h.instance.dispose();
  const changed = harness(); await settle(); await changed.instance.connect(); changed.storage.setItem(OUTLOOK_CONFIG_KEY, JSON.stringify({ ...config, clientId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' })); await changed.nodes.get('#outlook-config-form').trigger('submit'); await settle(); assert.ok(!text(changed.nodes.get('#mail-items')).includes(mail.subject)); assert.equal(changed.network.length, 2); assert.equal(changed.sdkCalls.filter(call => call[0] === 'loginPopup').length, 1); changed.instance.dispose();
  const forgotten = harness(); await settle(); await forgotten.instance.connect(); await forgotten.nodes.get('#outlook-forget-config').trigger('click'); assert.ok(!text(forgotten.nodes.get('#mail-items')).includes(mail.subject)); assert.equal(forgotten.auto.started, false); forgotten.instance.dispose();
});

await test('A late recent-mail response cannot overwrite the unread mode from a newer refresh', async () => {
  let unread = 0, lists = 0, finish;
  const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: unread }) : ++lists === 2 ? new Promise(resolve => { finish = resolve; }) : json({ value: [{ ...mail, isRead: unread === 0, subject: unread ? 'Non lu récent' : 'Ancien lu' }] }) });
  await settle(); await h.instance.connect();
  const background = h.auto.config.refresh(); await settle(); unread = 1; await h.instance.refresh();
  assert.equal(h.network[3][1].signal.aborted, true);
  finish(json({ value: [{ ...mail, subject: 'Réponse récente trop tardive', isRead: true }] })); await background;
  assert.ok(text(h.nodes.get('#mail-items')).includes('Non lu récent'));
  assert.ok(!text(h.nodes.get('#mail-items')).includes('Réponse récente trop tardive'));
  assert.equal(h.nodes.get('#mail-view-label').textContent, 'Non lus'); h.instance.dispose();
});
await test('Pagination stops after three pages and never labels an incomplete empty result as an empty inbox', async () => {
  let pages = 0;
  const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: 17 }) : json({ value: [{ ...mail, isRead: true, id: `unexpected-${++pages}` }], '@odata.nextLink': `${mailListUrl()}&$skip=${pages}` }) }); await settle(); await h.instance.connect();
  assert.equal(h.network.length, 4); assert.ok(text(h.nodes.get('#mail-items')).includes('aperçu est partiel')); assert.ok(!text(h.nodes.get('#mail-items')).includes('Aucun mail non lu')); h.instance.dispose();
});
await test('Shared asynchronous sign-out prevents reconnection until the cache cleanup finishes', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const h = harness({ cacheClear: () => pending }); await settle(); await h.instance.connect();
  const signOut = h.instance.disconnect(); assert.equal(h.nodes.get('#mail-connect').disabled, true); assert.equal(h.nodes.get('#mail-connect').textContent, 'Déconnexion…');
  await h.instance.connect(); assert.equal(h.sdkCalls.filter(call => call[0] === 'loginPopup').length, 1);
  finish(); await signOut; assert.equal(h.nodes.get('#mail-connect').disabled, false); h.instance.dispose();
});

const sharedSignIn = (h, selectedConfig = config) => connectMicrosoftServices({ application: h.application, config: selectedConfig, storage: h.storage, window: h.window, redirectUri: 'https://example.test/dashboard-personnel/auth-redirect.html' });

await test('Central Microsoft sign-in resumes mail using only its own silent token and one popup', async () => {
  const h = harness({ popupToken: 'SHARED POPUP TOKEN', silentToken: 'MAIL SCOPED TOKEN' }); await settle(); await sharedSignIn(h);
  assert.equal(h.sdkCalls.filter(call => call[0] === 'loginPopup').length, 1);
  assert.deepEqual(h.sdkCalls.find(call => call[0] === 'loginPopup')[1].scopes, ['Calendars.ReadBasic', 'Mail.ReadBasic', 'Place.Read.All']);
  assert.deepEqual(h.sdkCalls.find(call => call[0] === 'acquireTokenSilent')[1].scopes, ['Mail.ReadBasic']);
  assert.equal(h.network.length, 2); assert.ok(h.network.every(([, request]) => request.headers.Authorization === 'Bearer MAIL SCOPED TOKEN'));
  assert.equal(h.auto.started, true); h.instance.dispose();
});
await test('Explicit central sign-in can resume mail for this page when persistence is unavailable', async () => {
  const h = harness(); await settle(); h.storage.setItem = () => { throw new Error('Storage blocked'); };
  await sharedSignIn(h);
  assert.equal(h.network.length, 2); assert.equal(h.auto.started, true);
  assert.equal(h.stored.has(microsoftSessionKey(config)), false); h.instance.dispose();
});
await test('A fresh central sign-in resets mail 401, 403 and Retry-After gates', async () => {
  for (const status of [401, 403, 429]) {
    let folders = 0;
    const h = harness({ fetch: url => isFolder(url) ? ++folders === 2 ? json({}, status, { 'Retry-After': '120' }) : json({ unreadItemCount: 17 }) : json({ value: [mail] }) }); await settle();
    await h.instance.connect(); await h.auto.config.refresh(); assert.equal(h.nodes.get('#mail-status').dataset.state, 'error');
    await sharedSignIn(h);
    assert.equal(folders, 3, String(status)); assert.equal(h.nodes.get('#mail-status').dataset.state, 'connected');
    assert.equal(h.nodes.get('#mail-connect').hidden, true); assert.equal(h.auto.started, true); h.instance.dispose();
  }
});
await test('Central sign-in invalidates an older mail response before refreshing the new session', async () => {
  let lists = 0, finish;
  const h = harness({ fetch: url => isFolder(url) ? json({ unreadItemCount: 17 }) : ++lists === 2 ? new Promise(resolve => { finish = resolve; }) : json({ value: [{ ...mail, subject: lists === 3 ? 'Nouvelle session mails' : mail.subject }] }) }); await settle(); await h.instance.connect();
  const oldRefresh = h.auto.config.refresh(); await settle(); await sharedSignIn(h);
  assert.equal(h.network[3][1].signal.aborted, true);
  finish(json({ value: [{ ...mail, subject: 'Ancienne session tardive' }] })); await oldRefresh;
  assert.ok(text(h.nodes.get('#mail-items')).includes('Nouvelle session mails'));
  assert.ok(!text(h.nodes.get('#mail-items')).includes('Ancienne session tardive')); h.instance.dispose();
});
await test('Sign-out during central mail token restoration prevents a late fetch and restart', async () => {
  let finish;
  const h = harness({ acquireTokenSilent: () => new Promise(resolve => { finish = resolve; }) }); await settle();
  const connecting = Promise.allSettled([sharedSignIn(h)]); await settle(); assert.equal(typeof finish, 'function');
  await h.instance.disconnect(); finish({ account: owner, accessToken: 'LATE TOKEN' }); await connecting;
  assert.equal(h.network.length, 0); assert.equal(h.auto.started, false); assert.equal(h.nodes.get('#mail-connect').hidden, false); h.instance.dispose();
});
await test('Changing Outlook configuration during central mail restoration prevents use of the old token', async () => {
  let finish;
  const h = harness({ acquireTokenSilent: () => new Promise(resolve => { finish = resolve; }) }); await settle();
  const connecting = Promise.allSettled([sharedSignIn(h)]); await settle();
  h.storage.setItem(OUTLOOK_CONFIG_KEY, JSON.stringify({ ...config, clientId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' }));
  await h.nodes.get('#outlook-config-form').trigger('submit'); await settle();
  finish({ account: owner, accessToken: 'OLD CONFIG TOKEN' }); await connecting;
  assert.equal(h.network.length, 0); assert.equal(h.auto.started, false); h.instance.dispose();
});
await test('Disposing during mail SDK initialization prevents cache restoration or later central notifications', async () => {
  let finish;
  const h = harness({ remembered: true, cachedAccounts: [owner], initialize: () => new Promise(resolve => { finish = resolve; }) }); await settle();
  h.instance.dispose(); finish(); await settle(); await sharedSignIn(h);
  assert.equal(h.network.length, 0); assert.equal(h.auto.started, false);
  assert.equal(h.sdkCalls.filter(call => call[0] === 'acquireTokenSilent').length, 0);
});
await test('Restoring Outlook defaults also leaves mail subscribed to the next central default-app sign-in', async () => {
  const h = harness(); await settle(); await h.instance.connect();
  await h.instance.disconnect(); await h.nodes.get('#outlook-forget-config').trigger('click');
  h.storage.removeItem(OUTLOOK_CONFIG_KEY);
  const PublicClientApplication = h.application.constructor;
  await getMicrosoftClient({ config: MICROSOFT_DEPLOYMENT, window: h.window, redirectUri: 'https://example.test/dashboard-personnel/auth-redirect.html', loadSdk: async () => ({ PublicClientApplication }) });
  assert.equal(h.network.length, 2);
  await sharedSignIn(h, MICROSOFT_DEPLOYMENT);
  assert.equal(h.network.length, 4); assert.equal(h.nodes.get('#mail-status').dataset.state, 'connected');
  assert.equal(h.auto.started, true); h.instance.dispose();
});

console.log(`${checks.length} mail checks passed:\n${checks.map(name => `- ${name}`).join('\n')}`);
