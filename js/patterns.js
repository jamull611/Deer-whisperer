/*
 * Weather patterns: what conditions does a buck (or a stand's deer) actually move in?
 *
 * Every daylight visit is tagged with the conditions at that hour, then compared with how often those
 * conditions occurred across ALL daylight hours in the same period (the baseline). A condition only
 * counts as a pattern when it shows up far more (or less) than chance would explain, using an exact
 * binomial test with a correction for the number of options in each group.
 *
 *   < 5 daylight visits   -> "not enough data" (nothing is used for scoring)
 *   5-11 daylight visits  -> early pattern: only very strong signals
 *   12+ daylight visits   -> established pattern: fuller analysis, incl. a best combination
 */
(function () {
  const HOUR = 36e5, DAY = 24 * HOUR;
  const MIN_EARLY = 5, MIN_ESTABLISHED = 12;

  /** Conditions at a moment, including the changes deer react to. */
  function conditionsAt(weather, t) {
    if (!weather) return null;
    const h = weather.at(t);
    if (!h || h.temp == null) return null;
    const prior = [1, 2, 3].map((k) => weather.at(t - k * DAY)).filter((x) => x && x.temp != null);
    const p12 = weather.at(t - 12 * HOUR);
    return {
      temp: h.temp, wind: h.wind, windDir: h.windDir, gust: h.gust, pressure: h.pressure, precip: h.precip, cloud: h.cloud,
      dTemp: prior.length ? h.temp - prior.reduce((a, x) => a + x.temp, 0) / prior.length : null,
      dPress: p12 && p12.pressure != null && h.pressure != null ? h.pressure - p12.pressure : null,
      moonFrac: Astro.moonIllumination(new Date(t)).fraction,
    };
  }

  const WIND8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  /** Groups of condition bins. `quiet` bins are the ordinary case and are never reported as a pattern. */
  const GROUPS = {
    wind:  { label: 'Wind direction', values: WIND8, quiet: [], of: (c) => (c.windDir == null ? null : Geo.compass8(c.windDir)) },
    temp:  { label: 'Temperature', values: ['colder', 'normal', 'warmer'], quiet: ['normal'],
             of: (c) => (c.dTemp == null ? null : c.dTemp <= -5 ? 'colder' : c.dTemp >= 5 ? 'warmer' : 'normal') },
    press: { label: 'Pressure', values: ['rising', 'steady', 'falling'], quiet: ['steady'],
             of: (c) => (c.dPress == null ? null : c.dPress >= 0.04 ? 'rising' : c.dPress <= -0.04 ? 'falling' : 'steady') },
    rain:  { label: 'Rain', values: ['rain', 'dry'], quiet: ['dry'], of: (c) => (c.precip == null ? null : c.precip > 0.01 ? 'rain' : 'dry') },
    speed: { label: 'Wind speed', values: ['calm', 'moderate', 'windy'], quiet: ['moderate'],
             of: (c) => (c.wind == null ? null : c.wind < 3 ? 'calm' : c.wind > 12 ? 'windy' : 'moderate') },
    moon:  { label: 'Moon', values: ['dark', 'mid', 'bright'], quiet: ['mid'],
             of: (c) => (c.moonFrac == null ? null : c.moonFrac < 0.25 ? 'dark' : c.moonFrac > 0.75 ? 'bright' : 'mid') },
  };
  const LABEL = {
    colder: 'colder than the 3-day average (5°F+)', warmer: 'warmer than the 3-day average (5°F+)',
    rising: 'rising pressure', falling: 'falling pressure', rain: 'rain', calm: 'calm air (under 3 mph)',
    windy: 'windy (over 12 mph)', dark: 'a dark moon (under 25% lit)', bright: 'a bright moon (over 75% lit)',
  };
  const SHORT = { colder: 'cold', warmer: 'warm', rising: 'rising pressure', falling: 'falling pressure', rain: 'rain', calm: 'calm', windy: 'windy', dark: 'dark moon', bright: 'bright moon' };
  const labelOf = (g, v) => (g === 'wind' ? `${v} wind` : LABEL[v] || v);
  const shortOf = (g, v) => (g === 'wind' ? `${v} wind` : SHORT[v] || v);

  function binsOf(c) {
    if (!c) return null;
    const out = {};
    for (const [g, def] of Object.entries(GROUPS)) out[g] = def.of(c);
    return out;
  }

  /** Exact binomial tail: P(X >= k) when upper, else P(X <= k). */
  function binomTail(k, n, p, upper) {
    if (p <= 0) return upper ? (k <= 0 ? 1 : 0) : 1;
    if (p >= 1) return upper ? 1 : (k >= n ? 1 : 0);
    const lp = Math.log(p), lq = Math.log(1 - p);
    let lc = 0, sum = 0;
    for (let i = 0; i <= n; i++) {
      if (i > 0) lc += Math.log((n - i + 1) / i);
      if (upper ? i >= k : i <= k) sum += Math.exp(lc + i * lp + (n - i) * lq);
    }
    return Math.min(1, sum);
  }

  /** How often each condition occurred over all daylight hours in [start, end]. */
  function baseline(weather, lat, lng, start, end) {
    const counts = {}, totals = {};
    for (const g of Object.keys(GROUPS)) { counts[g] = {}; totals[g] = 0; }
    if (!weather) return { counts, totals, hours: 0 };
    let hours = 0;
    for (const h of weather.hours) {
      if (h.t < start || h.t > end) continue;
      if (Engine.period(h.t, lat, lng) === 'night') continue;
      const b = binsOf(conditionsAt(weather, h.t));
      if (!b) continue;
      hours++;
      for (const g of Object.keys(GROUPS)) if (b[g] != null) { counts[g][b[g]] = (counts[g][b[g]] || 0) + 1; totals[g]++; }
    }
    return { counts, totals, hours };
  }

  /**
   * Collapse photos into visits: one per deer per morning / midday / evening, whatever the camera.
   * Several photos in the same outing share the same weather, so counting them separately would
   * make a pattern look far stronger than it is.
   */
  function visits(sightings, keyOf) {
    const seen = new Set(), out = [];
    for (const s of [...sightings].sort((a, b) => a.takenAt - b.takenAt)) {
      const d = new Date(s.takenAt);
      const k = `${keyOf(s)}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}|${s.period}`;
      if (seen.has(k)) continue;
      seen.add(k); out.push(s);
    }
    return out;
  }

  /**
   * Analyse daylight visits against the baseline.
   * Returns { n, tier: 'none'|'early'|'established', need, findings[], combo, span }.
   */
  function analyse(daylightVisits, base) {
    const n = daylightVisits.length;
    const res = { n, tier: n >= MIN_ESTABLISHED ? 'established' : n >= MIN_EARLY ? 'early' : 'none', need: MIN_EARLY, findings: [], combo: null };
    if (res.tier === 'none' || !base || base.hours < 48) return res;
    // Family-wise error control: the alpha is shared by every condition tested (Bonferroni).
    const tests = Object.values(GROUPS).reduce((a, g) => a + g.values.length - g.quiet.length, 0);
    const a = (res.tier === 'established' ? 0.10 : 0.05) / tests;
    const tagged = daylightVisits.map((s) => ({ s, b: binsOf(s.cond) })).filter((x) => x.b);
    for (const [g, def] of Object.entries(GROUPS)) {
      const withG = tagged.filter((x) => x.b[g] != null);
      const ng = withG.length, tot = base.totals[g];
      if (ng < MIN_EARLY || !tot) continue;
      for (const v of def.values) {
        if (def.quiet.includes(v)) continue;
        const k = withG.filter((x) => x.b[g] === v).length;
        const p0 = (base.counts[g][v] || 0) / tot;
        if (p0 <= 0 || p0 >= 1) continue;
        const share = k / ng, lift = share / p0;
        if (k >= 3 && lift >= 1.5) {
          const p = binomTail(k, ng, p0, true);
          if (p < a) res.findings.push({ group: g, value: v, dir: 'more', k, n: ng, share, base: p0, lift, p, label: labelOf(g, v), short: shortOf(g, v) });
        } else if (ng * p0 >= 3 && lift <= 0.5) {
          const p = binomTail(k, ng, p0, false);
          if (p < a) res.findings.push({ group: g, value: v, dir: 'less', k, n: ng, share, base: p0, lift, p, label: labelOf(g, v), short: shortOf(g, v) });
        }
      }
    }
    res.findings.sort((x, y) => x.p - y.p);
    // Established patterns: does the best pair of "more" conditions stack up?
    if (res.tier === 'established') {
      const more = res.findings.filter((f) => f.dir === 'more');
      if (more.length >= 2 && more[0].group !== more[1].group) {
        const [f1, f2] = more;
        const k = tagged.filter((x) => x.b[f1.group] === f1.value && x.b[f2.group] === f2.value).length;
        const p0 = f1.base * f2.base; // assumes independence; good enough to flag a strong combination
        if (k >= 3) res.combo = { f1, f2, k, n: tagged.length, share: k / tagged.length, base: p0, lift: (k / tagged.length) / p0 };
      }
    }
    return res;
  }

  /** Bins for a planned sit (averages over the sit window). */
  function sitBins(wx, dTemp, dPress, moonFrac) {
    if (!wx) return null;
    return binsOf({ ...wx, dTemp, dPress, moonFrac, precip: wx.precip != null ? wx.precip / 3 : null });
  }

  /** Score adjustment and reasons for a sit given a pattern. */
  function matchSit(pattern, bins) {
    if (!pattern || !pattern.findings.length || !bins) return { adj: 0, hits: [], misses: [] };
    let adj = 0; const hits = [], misses = [];
    for (const f of pattern.findings) {
      if (bins[f.group] !== f.value) continue;
      if (f.dir === 'more') { adj += Math.min(0.07, 0.035 * Math.log2(f.lift)); hits.push(f); }
      else { adj -= 0.06; misses.push(f); }
    }
    return { adj: Math.max(-0.12, Math.min(0.14, adj)), hits, misses };
  }

  function pct(x) { return Math.round(x * 100) + '%'; }
  /** One line per finding, for the Bucks tab. */
  function describe(f) {
    if (f.dir === 'more') return `${cap(f.label)}: ${f.k} of ${f.n} daylight visits (${pct(f.share)}) vs ${pct(f.base)} of daylight hours, ${f.lift.toFixed(1)}× more than chance.`;
    return `${cap(f.label)}: only ${f.k} of ${f.n} daylight visits (${pct(f.share)}) vs ${pct(f.base)} of daylight hours, so movement drops off in it.`;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  window.Patterns = { conditionsAt, binsOf, baseline, visits, analyse, sitBins, matchSit, describe, MIN_EARLY, MIN_ESTABLISHED, GROUPS };
})();
