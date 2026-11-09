import { initializeFootballFixtures } from './football-fixtures.mjs';
import { subscribeFootballExtension } from './football-extension.mjs';
import { LELOCLE_URL, LELOCLE_INTERVAL_MS, LELOCLE_CACHE_KEY, LELOCLE_CACHE_MAX_AGE_MS,
  parseLeLocleFeed, upcomingLeLocleMatches, leLocleMatchWhen, readLeLocleCache, selectLeLocleView, mergeLeLocleSnapshot, mergeLeLocleExtension } from './lelocle-core.mjs';

export function initializeLeLocleFixtures(options = {}) {
  let extensionSnapshot = null;
  const widget = initializeFootballFixtures({ prefix: 'lelocle', label: 'FC Le Locle · Juniors A', sourceName: 'ANF', url: LELOCLE_URL,
    intervalMs: LELOCLE_INTERVAL_MS, cacheKey: LELOCLE_CACHE_KEY, cacheMaxAgeMs: LELOCLE_CACHE_MAX_AGE_MS,
    readCache: readLeLocleCache, selectUpcoming: upcomingLeLocleMatches, formatWhen: leLocleMatchWhen,
    selectView: selectLeLocleView, mergeSnapshot: mergeLeLocleSnapshot, requestTimeoutMs: 20_000,
    mergeExternalSnapshot: mergeLeLocleExtension,
    readSchedule: async (response, at) => mergeLeLocleExtension(parseLeLocleFeed(await response.json(), at), extensionSnapshot, at)
  }, options);
  if (!widget) return null;
  const doc = options.document || globalThis.document, win = options.window || globalThis.window;
  const bridge = (options.extensionBridgeFactory || subscribeFootballExtension)(packet => {
    extensionSnapshot = packet;
    widget.applyExternalSnapshot(packet);
    const status = doc.getElementById('lelocle-extension-status');
    if (status) {
      status.dataset.state = packet.installed ? 'connected' : 'not-installed';
      status.textContent = packet.installed ? packet.refreshing ? 'Extension football connectée · lecture de l’ANF en cours.' : 'Extension football connectée.' : 'Extension football non détectée dans ce navigateur.';
    }
  }, { ...options, document: doc, window: win });
  const dispose = () => { bridge.dispose(); widget.dispose(); win.removeEventListener?.('pagehide', onPageHide); };
  const onPageHide = event => { if (!event.persisted) dispose(); };
  win.addEventListener?.('pagehide', onPageHide);
  return { ...widget, dispose };
}

if (typeof document !== 'undefined') initializeLeLocleFixtures();
