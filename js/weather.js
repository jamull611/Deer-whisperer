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

  /**
   * Historical hourly weather (for photos older than the ~3 months the forecast call covers).
   * Uses Open-Meteo's free archive API; results are cached in this browser when there is room.
   */
  async function loadArchive(lat, lng, startMs, endMs) {
    const d = (ms) => new Date(ms).toISOString().slice(0, 10);
    const key = `dw.archive.${lat.toFixed(2)},${lng.toFixed(2)},${d(startMs)},${d(endMs)}`;
    try { const c = JSON.parse(localStorage.getItem(key) || 'null'); if (c) return hydrate(c); } catch { /* ignore */ }
    const url = 'https://archive-api.open-meteo.com/v1/archive?' + new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lng.toFixed(4), hourly: HOURLY.join(','),
      temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch',
      timezone: 'auto', timeformat: 'unixtime', start_date: d(startMs), end_date: d(endMs),
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather history request failed (${res.status})`);
    const data = await res.json();
    try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* storage full: just don't cache */ }
    return hydrate(data);
  }

  /** Combine two hourly series (e.g. archive + forecast) into one lookup. */
  function merge(a, b) {
    if (!a) return b; if (!b) return a;
    const byT = new Map();
    for (const h of a.hours) byT.set(h.t, h);
    for (const h of b.hours) byT.set(h.t, h);
    const out = fromHours([...byT.values()].sort((x, y) => x.t - y.t));
    return Object.assign(out, { tz: b.tz || a.tz, utcOffset: b.utcOffset ?? a.utcOffset, stale: b.stale || a.stale });
  }

  function fromHours(hours) {
    const idx = new Map(hours.map((h) => [Math.round(h.t / 36e5), h]));
    return { hours, at: (ms) => idx.get(Math.round(ms / 36e5)) || null };
  }

  /** Turn column arrays into an hour-indexed lookup. */
  function hydrate(data) {
    const h = data.hourly, hours = h.time.map((t, i) => ({
      t: t * 1000,
      temp: h.temperature_2m[i], wind: h.wind_speed_10m[i], windDir: h.wind_direction_10m[i],
      gust: h.wind_gusts_10m[i], pressure: h.pressure_msl[i] != null ? h.pressure_msl[i] * 0.02953 : null, // hPa -> inHg
      precip: h.precipitation[i], cloud: h.cloud_cover[i],
    }));
    return Object.assign(fromHours(hours), { tz: data.timezone, utcOffset: data.utc_offset_seconds });
  }

  window.Weather = { load, loadArchive, merge };
})();
