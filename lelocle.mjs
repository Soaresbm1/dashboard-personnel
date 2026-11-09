import { initializeFootballFixtures } from './football-fixtures.mjs';
import { LELOCLE_URL, LELOCLE_INTERVAL_MS, LELOCLE_CACHE_KEY, LELOCLE_CACHE_MAX_AGE_MS,
  parseLeLocleFeed, upcomingLeLocleMatches, leLocleMatchWhen, readLeLocleCache } from './lelocle-core.mjs';

export function initializeLeLocleFixtures(options = {}) {
  return initializeFootballFixtures({ prefix: 'lelocle', label: 'FC Le Locle · Juniors A', sourceName: 'ANF', url: LELOCLE_URL,
    intervalMs: LELOCLE_INTERVAL_MS, cacheKey: LELOCLE_CACHE_KEY, cacheMaxAgeMs: LELOCLE_CACHE_MAX_AGE_MS,
    readCache: readLeLocleCache, selectUpcoming: upcomingLeLocleMatches, formatWhen: leLocleMatchWhen,
    readSchedule: async (response, at) => parseLeLocleFeed(await response.json(), at)
  }, options);
}

if (typeof document !== 'undefined') initializeLeLocleFixtures();
