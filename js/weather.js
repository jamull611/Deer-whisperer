/* Weather via Open-Meteo (free, no API key). One call returns ~3 months of history + 16-day forecast. */
(function () {
  const HOURLY = ['temperature_2m', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'pressure_msl', 'precipitation', 'cloud_cover'];
  const CACHE_KEY = 'dw.weather.v1';
  const MAX_AGE_MS = 60 * 60e3;

  function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; } }
  function writeCache(v) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch { /* quota / private mode */ } }

  async function load(lat, lng, { force = false } = {}) {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const c = readCache();
    if (!force && c && c.key === key && Date.now() - c.fetched < MAX_AGE_MS) return hydrate(c.data);
    const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lng.toFixed(4), hourly: HOURLY.join(','),
      temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch',
      timezone: 'auto', timeformat: 'unixtime', past_days: '92', forecast_days: '16',
    });
    let data;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Weather request failed (${res.status})`);
      data = await res.json();
    } catch (e) {
      // No signal in the woods? Fall back to the last forecast we saved.
      if (c && c.key === key) { const w = hydrate(c.data); w.stale = c.fetched; return w; }
      throw e;
    }
    writeCache({ key, fetched: Date.now(), data });
    return hydrate(data);
  }

  /** Turn column arrays into an hour-indexed lookup. */
  function hydrate(data) {
    const h = data.hourly, hours = h.time.map((t, i) => ({
      t: t * 1000,
      temp: h.temperature_2m[i], wind: h.wind_speed_10m[i], windDir: h.wind_direction_10m[i],
      gust: h.wind_gusts_10m[i], pressure: h.pressure_msl[i] != null ? h.pressure_msl[i] * 0.02953 : null, // hPa -> inHg
      precip: h.precipitation[i], cloud: h.cloud_cover[i],
    }));
    const start = hours.length ? hours[0].t : 0;
    const at = (ms) => { const i = Math.round((ms - start) / 36e5); return hours[i] || null; };
    return { hours, at, tz: data.timezone, utcOffset: data.utc_offset_seconds };
  }

  window.Weather = { load };
})();
