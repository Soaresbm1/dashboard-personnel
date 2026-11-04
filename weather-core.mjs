export const WEATHER_LOCATION = Object.freeze({ name: 'Neuchâtel', latitude: 46.99179, longitude: 6.931, timezone: 'Europe/Zurich' });
export const WEATHER_INTERVAL_MS = 15 * 60_000;
export const WEATHER_MAX_AGE_MS = 60 * 60_000;
export const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LOCATION.latitude}&longitude=${WEATHER_LOCATION.longitude}&current=temperature_2m,weather_code,is_day&daily=temperature_2m_min,temperature_2m_max&timezone=Europe%2FZurich&forecast_days=1&timeformat=unixtime`;

const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: WEATHER_LOCATION.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const localTime = new Intl.DateTimeFormat('fr-CH', { timeZone: WEATHER_LOCATION.timezone, hour: '2-digit', minute: '2-digit' });
const temperature = value => typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 65;
export const weatherDate = milliseconds => localDate.format(new Date(milliseconds));
export const weatherTime = milliseconds => localTime.format(new Date(milliseconds));
export const formatTemperature = value => `${Object.is(Math.round(value), -0) ? 0 : Math.round(value)}°`;

export function describeWeather(code, isDay = true) {
  if (code === 0) return isDay ? 'Ensoleillé' : 'Ciel dégagé';
  if (code === 1) return 'Peu nuageux';
  if (code === 2) return 'Éclaircies';
  if (code === 3) return 'Couvert';
  if ([45, 48].includes(code)) return 'Brouillard';
  if ([51, 53, 55].includes(code)) return 'Bruine';
  if ([56, 57].includes(code)) return 'Bruine verglaçante';
  if ([61, 63, 65].includes(code)) return 'Pluie';
  if ([66, 67].includes(code)) return 'Pluie verglaçante';
  if ([71, 73, 75, 77].includes(code)) return 'Neige';
  if ([80, 81, 82].includes(code)) return 'Averses';
  if ([85, 86].includes(code)) return 'Averses de neige';
  if (code === 95) return 'Orage';
  if ([96, 99].includes(code)) return 'Orage avec grêle';
  if (code === 97) return 'Orage violent';
  return 'Conditions inconnues';
}

// Reject incomplete, wrongly scaled or old responses rather than displaying false zeroes.
export function parseWeather(payload, now = Date.now()) {
  const current = payload?.current, daily = payload?.daily;
  if (payload?.error || payload?.current_units?.temperature_2m !== '°C' || !temperature(current?.temperature_2m) ||
      !Number.isFinite(current?.time) || !Number.isInteger(current?.weather_code) || ![0, 1].includes(current?.is_day)) throw new Error('invalid_weather');
  const validAt = current.time * 1_000;
  if (validAt > now + 30 * 60_000 || now - validAt > WEATHER_MAX_AGE_MS) throw new Error('stale_weather');
  const today = weatherDate(now);
  const dayIndex = Array.isArray(daily?.time) ? daily.time.findIndex(time => Number.isFinite(time) && weatherDate(time * 1_000) === today) : -1;
  const minimum = daily?.temperature_2m_min?.[dayIndex], maximum = daily?.temperature_2m_max?.[dayIndex];
  const hasRange = dayIndex >= 0 && payload?.daily_units?.temperature_2m_min === '°C' && payload?.daily_units?.temperature_2m_max === '°C' && temperature(minimum) && temperature(maximum) && minimum <= maximum;
  return { temperature: current.temperature_2m, condition: describeWeather(current.weather_code, current.is_day === 1),
    minimum: hasRange ? minimum : null, maximum: hasRange ? maximum : null, validAt, date: today };
}

export function canShowWeather(weather, now = Date.now()) {
  return !!weather && weather.date === weatherDate(now) && now - weather.validAt <= WEATHER_MAX_AGE_MS;
}
