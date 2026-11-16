import { initializeFootballFixtures } from './football-fixtures.mjs';
import { subscribeFootballExtension } from './football-extension.mjs?v=20261116-teams';
import { ANF_TEAMS, anfTeam, anfCacheKey } from './anf-teams.mjs';
import { LELOCLE_URL, LELOCLE_INTERVAL_MS, LELOCLE_CACHE_MAX_AGE_MS, parseLeLocleFeed, upcomingLeLocleMatches,
  leLocleMatchWhen, readLeLocleCache, selectLeLocleView, mergeLeLocleSnapshot, mergeLeLocleExtension } from './lelocle-core.mjs?v=20261116-teams';

export function initializeLeLocleFixtures(options = {}) {
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  if (!doc.getElementById('summary-lelocle')) return null;
  const selector = doc.getElementById('anf-team'), source = doc.getElementById('anf-team-source');
  let storage;
  try { storage = options.storage || win.localStorage; } catch { /* Selection works without persistent storage. */ }
  let current = null, bridge = null, disposed = false, selected = '34107';
  try { const saved = options.teamId || storage?.getItem('dashboard.anf.selected.v1'); if (ANF_TEAMS.some(team => team.id === saved)) selected = saved; } catch { /* Default to Juniors A. */ }
  function start(teamId) {
    current?.dispose(); bridge?.dispose();
    selected = teamId; const team = anfTeam(teamId); let extensionSnapshot = null;
    if (selector) { selector.value = teamId; selector.title = team.name; }
    if (source) { source.href = team.sourceUrl; source.setAttribute('aria-label', `Calendrier officiel — ${team.name}`); }
    current = initializeFootballFixtures({ prefix: 'lelocle', label: team.name, sourceName: 'ANF',
      url: teamId === '34107' ? LELOCLE_URL : `${LELOCLE_URL}?team=${teamId}`, intervalMs: LELOCLE_INTERVAL_MS,
      cacheKey: anfCacheKey(teamId), cacheMaxAgeMs: LELOCLE_CACHE_MAX_AGE_MS,
      readCache: (raw, at) => readLeLocleCache(raw, at, teamId), selectUpcoming: upcomingLeLocleMatches, formatWhen: leLocleMatchWhen,
      selectView: selectLeLocleView, mergeSnapshot: mergeLeLocleSnapshot, requestTimeoutMs: 20_000,
      mergeExternalSnapshot: (snapshot, packet, at) => mergeLeLocleExtension(snapshot, packet, at, teamId),
      readSchedule: async (response, at) => mergeLeLocleExtension(parseLeLocleFeed(await response.json(), at, teamId), extensionSnapshot, at, teamId)
    }, options);
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
    if (disposed || !ANF_TEAMS.some(team => team.id === selector.value) || selector.value === selected) return;
    const id = selector.value; try { storage?.setItem('dashboard.anf.selected.v1', id); } catch { /* Optional preference. */ }
    start(id);
  };
  selector?.addEventListener('change', onChange);
  const dispose = () => { disposed = true; bridge?.dispose(); current?.dispose(); selector?.removeEventListener?.('change', onChange); win.removeEventListener?.('pagehide', onPageHide); };
  const onPageHide = event => { if (!event.persisted) dispose(); };
  win.addEventListener?.('pagehide', onPageHide); start(selected);
  return { refresh: () => current?.refresh(), applyExternalSnapshot: packet => current?.applyExternalSnapshot(packet), dispose };
}
if (typeof document !== 'undefined') initializeLeLocleFixtures();
