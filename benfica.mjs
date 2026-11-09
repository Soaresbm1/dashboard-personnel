import { initializeFootballFixtures } from './football-fixtures.mjs';
import { BENFICA_URL, BENFICA_INTERVAL_MS, BENFICA_CACHE_KEY, BENFICA_CACHE_MAX_AGE_MS,
  parseBenficaSchedule, upcomingBenficaMatches, benficaMatchWhen, readBenficaCache } from './benfica-core.mjs';

export function initializeBenficaFixtures(options = {}) {
  return initializeFootballFixtures({ prefix: 'benfica', label: 'Benfica', sourceName: 'ESPN', url: BENFICA_URL,
    intervalMs: BENFICA_INTERVAL_MS, cacheKey: BENFICA_CACHE_KEY, cacheMaxAgeMs: BENFICA_CACHE_MAX_AGE_MS,
    readCache: readBenficaCache, selectUpcoming: upcomingBenficaMatches, formatWhen: benficaMatchWhen,
    readSchedule: async (response, at) => ({ matches: parseBenficaSchedule(await response.json()), at, stale: false })
  }, options);
}

if (typeof document !== 'undefined') initializeBenficaFixtures();
