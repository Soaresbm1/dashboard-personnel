import { initializeFootballFixtures } from './football-fixtures.mjs';
import { subscribeFootballExtension } from './football-extension.mjs?v=20261116-teams';
import { ANF_TEAMS, anfTeam, anfCacheKey } from './anf-teams.mjs';
import { LELOCLE_URL, LELOCLE_INTERVAL_MS, LELOCLE_CACHE_MAX_AGE_MS, parseLeLocleFeed, upcomingLeLocleMatches,
  leLocleMatchWhen, readLeLocleCache, selectLeLocleView, mergeLeLocleSnapshot, mergeLeLocleExtension } from './lelocle-core.mjs?v=20261116-teams';

export const ANF_ROTATION_INTERVAL_MS = 10_000;

export function initializeLeLocleFixtures(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const region = doc.getElementById('summary-lelocle');
  if (!region) return null;
  const selector = doc.getElementById('anf-team'), source = doc.getElementById('anf-team-source');
  const now = options.now || Date.now, fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  const schedule = options.setTimeout || globalThis.setTimeout.bind(globalThis), cancel = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  let storage;
  try { storage = options.storage || win.localStorage; } catch { /* Selection works without persistent storage. */ }
  const memory = new Map(), feeds = new Map(), requests = new Set();
  const fixtureStorage = {
    getItem(key) { if (memory.has(key)) return memory.get(key); try { return storage?.getItem(key); } catch { return null; } },
    setItem(key, value) { memory.set(key, value); try { storage?.setItem(key, value); } catch { /* Public data remains cached in memory. */ } }
  };
  let current = null, bridge = null, disposed = false, selected = '34107', timer = null, hovered = false, focused = false;
  try { const saved = options.teamId || storage?.getItem('dashboard.anf.selected.v1'); if (ANF_TEAMS.some(team => team.id === saved)) selected = saved; } catch { /* Default to Juniors A. */ }

  // Changing the visible team must not restart or cancel its fifteen-minute source check.
  function loadFeed(teamId, url) {
    const previous = feeds.get(teamId);
    if (previous && now() - previous.at < LELOCLE_INTERVAL_MS) return previous.promise;
    const controller = new AbortController(); requests.add(controller);
    const timeout = globalThis.setTimeout(() => controller.abort(), 20_000); timeout?.unref?.();
    const promise = (async () => {
      try {
        const response = await fetcher(url, { method: 'GET', signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('Football schedule request failed');
        const body = await response.json();
        parseLeLocleFeed(body, now(), teamId);
        return body;
      } finally { globalThis.clearTimeout(timeout); requests.delete(controller); }
    })();
    feeds.set(teamId, { at: now(), promise });
    return promise;
  }
  function clearTimer() { if (timer !== null) cancel(timer); timer = null; }
  function armRotation() {
    clearTimer();
    if (disposed || !selector || doc.hidden || hovered || focused) return;
    timer = schedule(() => {
      timer = null;
      if (disposed || doc.hidden || hovered || focused) return;
      const index = ANF_TEAMS.findIndex(team => team.id === selected);
      start(ANF_TEAMS[(index + 1) % ANF_TEAMS.length].id);
      armRotation();
    }, ANF_ROTATION_INTERVAL_MS);
    timer?.unref?.();
  }
  function start(teamId, manual = false) {
    current?.dispose(); bridge?.dispose();
    selected = teamId; const team = anfTeam(teamId); let extensionSnapshot = null;
    for (const id of ['lelocle-status', 'lelocle-extension-status']) doc.getElementById(id)?.setAttribute('aria-live', manual ? 'polite' : 'off');
    if (selector) { selector.value = teamId; selector.title = team.name; }
    if (source) { source.href = team.sourceUrl; source.setAttribute('aria-label', `Calendrier officiel — ${team.name}`); }
    current = initializeFootballFixtures({ prefix: 'lelocle', label: team.name, sourceName: 'ANF',
      url: teamId === '34107' ? LELOCLE_URL : `${LELOCLE_URL}?team=${teamId}`, intervalMs: LELOCLE_INTERVAL_MS,
      cacheKey: anfCacheKey(teamId), cacheMaxAgeMs: LELOCLE_CACHE_MAX_AGE_MS,
      readCache: (raw, at) => readLeLocleCache(raw, at, teamId), selectUpcoming: upcomingLeLocleMatches, formatWhen: leLocleMatchWhen,
      selectView: selectLeLocleView, mergeSnapshot: mergeLeLocleSnapshot, requestTimeoutMs: 20_000,
      mergeExternalSnapshot: (snapshot, packet, at) => mergeLeLocleExtension(snapshot, packet, at, teamId),
      readSchedule: async (response, at) => mergeLeLocleExtension(parseLeLocleFeed(await response.json(), at, teamId), extensionSnapshot, at, teamId)
    }, { ...options, storage: fixtureStorage, fetch: async url => {
      const body = await loadFeed(teamId, url);
      return { ok: true, json: async () => body };
    } });
    bridge = (options.extensionBridgeFactory || subscribeFootballExtension)(packet => {
      if (disposed || selected !== teamId) return;
      extensionSnapshot = packet; current.applyExternalSnapshot(packet);
      const status = doc.getElementById('lelocle-extension-status');
      if (status) {
        status.dataset.state = packet.installed ? 'connected' : 'not-installed';
        status.textContent = packet.installed ? packet.refreshing ? 'Extension football connectée · lecture de l’ANF en cours.' : 'Extension football connectée.' : 'Extension football non détectée dans ce navigateur.';
      }
    }, { ...options, teamId, document: doc, window: win });
  }
  const onChange = () => {
    if (disposed || !ANF_TEAMS.some(team => team.id === selector.value)) return;
    const id = selector.value; try { storage?.setItem('dashboard.anf.selected.v1', id); } catch { /* Optional preference. */ }
    if (id !== selected) start(id, true);
    armRotation();
  };
  const enter = () => { hovered = true; armRotation(); }, leave = () => { hovered = false; armRotation(); };
  const focus = () => { focused = true; armRotation(); };
  const blur = event => { if (!region.contains?.(event.relatedTarget)) { focused = false; armRotation(); } };
  selector?.addEventListener('change', onChange);
  region.addEventListener('mouseenter', enter); region.addEventListener('mouseleave', leave);
  region.addEventListener('focusin', focus); region.addEventListener('focusout', blur);
  doc.addEventListener?.('visibilitychange', armRotation); win.addEventListener?.('pageshow', armRotation);
  const dispose = () => {
    disposed = true; clearTimer(); bridge?.dispose(); current?.dispose(); requests.forEach(request => request.abort());
    selector?.removeEventListener?.('change', onChange);
    region.removeEventListener('mouseenter', enter); region.removeEventListener('mouseleave', leave);
    region.removeEventListener('focusin', focus); region.removeEventListener('focusout', blur);
    doc.removeEventListener?.('visibilitychange', armRotation); win.removeEventListener?.('pageshow', armRotation);
    win.removeEventListener?.('pagehide', onPageHide);
  };
  const onPageHide = event => { if (!event.persisted) dispose(); };
  win.addEventListener?.('pagehide', onPageHide); start(selected); armRotation();
  return { refresh: () => { feeds.delete(selected); return current?.refresh(); }, applyExternalSnapshot: packet => current?.applyExternalSnapshot(packet), dispose };
}
if (typeof document !== 'undefined') initializeLeLocleFixtures();
