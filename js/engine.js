/*
 * The hunting brain. Pure functions: give it cameras, stands, bucks, photos and weather and it returns
 * buck patterns, stand ratings for every upcoming morning/evening sit, and suggested stand locations.
 *
 * It is a transparent, rule-based model (no black box): every score comes with the reasons behind it,
 * so you can sanity-check it against what you know about your ground.
 */
(function () {
  const HOUR = 36e5, DAY = 24 * HOUR;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const WIND8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

  const DEFAULTS = {
    rutPeak: '11-12',     // MM-DD, peak breeding for your area
    radiusYd: 500,        // how far a camera "feeds" a stand
    halfLifeDays: 21,     // how fast old sightings fade
    shotYd: 25,           // suggested stand offset from the trail (bow 20-30, gun 75-150)
    scentConeDeg: 50,     // half-width of the scent plume we treat as dangerous
  };

  function localMidnight(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; }

  /** Classify a time as AM / PM / midday / night relative to sunrise/sunset at that place. */
  function period(ms, lat, lng) {
    const s = Astro.sunTimes(new Date(localMidnight(ms).getTime() + 12 * HOUR), lat, lng);
    const rise = +s.sunrise, set = +s.sunset;
    if (ms < rise - 45 * 60e3 || ms > set + 45 * 60e3) return 'night';
    if (ms <= rise + 3 * HOUR) return 'AM';
    if (ms >= set - 3 * HOUR) return 'PM';
    return 'midday';
  }

  /** Attach derived info (heading, period, wind at the time, moon) to each photo/sighting. */
  function enrichSightings(photos, cameras, weather) {
    const camById = Object.fromEntries(cameras.map((c) => [c.id, c]));
    return photos.filter((p) => p.cameraId && camById[p.cameraId] && p.takenAt && p.kind && p.kind !== 'none').map((p) => {
      const cam = camById[p.cameraId];
      const cond = p.wxSnap || (weather ? Patterns.conditionsAt(weather, p.takenAt) : null);
      return {
        ...p, cam,
        heading: Geo.travelHeading(cam.facing, p.travel),
        period: period(p.takenAt, cam.lat, cam.lng),
        wx: cond, cond,
        moon: Astro.moonIllumination(new Date(p.takenAt)),
      };
    });
  }

  /** Human-readable pattern for one buck. */
  function buckPattern(buck, sightings) {
    const mine = sightings.filter((s) => s.buckId === buck.id).sort((a, b) => a.takenAt - b.takenAt);
    if (!mine.length) return { count: 0, summary: 'No sightings logged yet.' };
    const byCam = {};
    mine.forEach((s) => { (byCam[s.cam.id] = byCam[s.cam.id] || { cam: s.cam, n: 0, daylight: 0, headings: [] }).n++; if (s.period !== 'night') byCam[s.cam.id].daylight++; if (s.heading != null) byCam[s.cam.id].headings.push({ deg: s.heading }); });
    const periods = { AM: 0, midday: 0, PM: 0, night: 0 };
    mine.forEach((s) => periods[s.period]++);
    const daylight = mine.filter((s) => s.period !== 'night');
    const windCounts = {};
    daylight.forEach((s) => { if (s.wx) { const k = Geo.compass8(s.wx.windDir); windCounts[k] = (windCounts[k] || 0) + 1; } });
    const topWinds = Object.entries(windCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    const cams = Object.values(byCam).sort((a, b) => b.n - a.n).map((c) => {
      const m = Geo.circularMean(c.headings);
      return { ...c, travel: m.mean != null && m.strength > 0.5 ? Geo.compass(m.mean) : null };
    });
    const last = mine[mine.length - 1];
    const lines = [];
    lines.push(`${mine.length} sighting${mine.length > 1 ? 's' : ''}, ${daylight.length} in daylight. Last seen ${new Date(last.takenAt).toLocaleDateString()} at ${last.cam.name}.`);
    lines.push('Cameras: ' + cams.map((c) => `${c.cam.name} ×${c.n}${c.travel ? ` (heading ${c.travel})` : ''}`).join(', ') + '.');
    const pBits = Object.entries(periods).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`);
    lines.push('Timing: ' + pBits.join(' · ') + '.');
    if (topWinds.length) lines.push(`Daylight sightings mostly on ${topWinds.join('/')} winds.`);
    return { count: mine.length, daylight: daylight.length, periods, cams, topWinds, last, summary: lines.join(' ') };
  }

  /** Points around a stand that the deer occupy / approach from, weighted. Used for wind checks. */
  function threatPoints(stand, sightings, cfg, targetBuckId) {
    const pts = [];
    for (const s of sightings) {
      if (targetBuckId && s.buckId !== targetBuckId) continue;
      const d = Geo.distanceYd(stand, s.cam);
      if (d > cfg.radiusYd) continue;
      const w = s.kind === 'buck' ? 1 : 0.5;
      pts.push({ p: s.cam, w });
      if (s.heading != null) pts.push({ p: Geo.offset(s.cam, Geo.norm(s.heading + 180), 80), w: w * 0.8 }); // where it came from
    }
    return pts.filter((t) => Geo.distanceYd(stand, t.p) > 5);
  }

  /** 0..1 — how well a wind (FROM direction, degrees) keeps scent off the deer. */
  function windSafety(stand, windFrom, pts, cfg) {
    if (stand.goodWinds && stand.goodWinds.length) {
      const k = Geo.compass8(windFrom), i = WIND8.indexOf(k);
      if (stand.goodWinds.includes(k)) return 1;
      if (stand.goodWinds.includes(WIND8[(i + 1) % 8]) || stand.goodWinds.includes(WIND8[(i + 7) % 8])) return 0.55;
      return 0.1;
    }
    if (!pts.length) return 0.7; // unknown — no deer data near this stand
    const scent = Geo.norm(windFrom + 180);
    let bad = 0, tot = 0;
    for (const t of pts) {
      const diff = Geo.angDiff(scent, Geo.bearing(stand, t.p));
      const exposure = diff < cfg.scentConeDeg ? 1 : diff < cfg.scentConeDeg + 25 ? 0.4 : 0;
      bad += exposure * t.w; tot += t.w;
    }
    return clamp(1 - bad / tot);
  }

  function goodWindsFor(stand, pts, cfg) {
    return WIND8.filter((k, i) => windSafety({ ...stand, goodWinds: null }, i * 45, pts, cfg) >= 0.75);
  }

  function windSpeedFactor(mph) {
    if (mph == null) return 1;
    if (mph < 2) return 0.8; if (mph <= 14) return 1; if (mph <= 20) return 0.8; return 0.55;
  }

  function avg(list, key) { const v = list.map((x) => x[key]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

  /** Hours (from the weather series) covering a sit, plus the window bounds. */
  function sitWindow(dayMs, which, lat, lng) {
    const s = Astro.sunTimes(new Date(dayMs + 12 * HOUR), lat, lng);
    const start = which === 'AM' ? +s.sunrise - 30 * 60e3 : +s.sunset - 2.5 * HOUR;
    const end = which === 'AM' ? +s.sunrise + 2.5 * HOUR : +s.sunset + 30 * 60e3;
    return { start, end, sun: s };
  }

  function rutBonus(ms, cfg) {
    const d = new Date(ms), [m, dd] = cfg.rutPeak.split('-').map(Number);
    const peak = new Date(d.getFullYear(), m - 1, dd).getTime();
    const days = (ms - peak) / DAY;
    if (days >= -21 && days < -10) return { b: 0.04, txt: 'Pre-rut: scrapes heating up' };
    if (days >= -10 && days <= 7) return { b: 0.08, txt: 'Rut: bucks cruising — all-day sits pay off' };
    if (days > 7 && days <= 18) return { b: 0.04, txt: 'Late rut: bucks still checking does' };
    return null;
  }

  /**
   * Rate one stand for one sit. Returns { score 0-100, reasons[], wx }.
   */
  function rateSit(stand, dayMs, which, ctx) {
    const { sightings, weather, cfg, targetBuckId, now } = ctx;
    const win = sitWindow(dayMs, which, stand.lat, stand.lng);
    if (win.end < now) return null;
    const hrs = weather ? weather.hours.filter((h) => h.t >= win.start && h.t <= win.end) : [];
    if (weather && !hrs.length) return null;
    const wx = hrs.length ? {
      temp: avg(hrs, 'temp'), wind: avg(hrs, 'wind'), gust: avg(hrs, 'gust'), pressure: avg(hrs, 'pressure'),
      precip: hrs.reduce((a, h) => a + (h.precip || 0), 0), cloud: avg(hrs, 'cloud'),
      windDir: Geo.circularMean(hrs.map((h) => ({ deg: h.windDir, w: Math.max(h.wind, 0.5) }))).mean,
    } : null;
    const reasons = [];
    let r_bins = null;
    let bonus = 0;

    // --- Activity near this stand ---
    let act = 0, actRaw = 0, n = 0;
    for (const s of sightings) {
      if (targetBuckId && s.buckId !== targetBuckId) continue;
      const d = Geo.distanceYd(stand, s.cam);
      if (d > ctx.cfg.radiusYd) continue;
      const ageDays = Math.max(0, (now - s.takenAt) / DAY);
      const w = Math.pow(0.5, ageDays / cfg.halfLifeDays) * (1 - 0.6 * d / cfg.radiusYd) * (s.kind === 'buck' ? 1 : 0.35);
      const pm = s.period === which ? 1 : s.period === 'midday' ? 0.5 : s.period === 'night' ? 0.25 : 0.4;
      actRaw += w * pm; n++;
    }
    act = 1 - Math.exp(-actRaw / 1.5);
    if (n) reasons.push({ v: act >= 0.5 ? 1 : 0, t: `${n} sighting${n > 1 ? 's' : ''} within ${cfg.radiusYd} yd${targetBuckId ? ' of this buck' : ''}; ${act >= 0.5 ? 'strong' : act >= 0.2 ? 'some' : 'little'} recent ${which === 'AM' ? 'morning' : 'evening'} activity` });
    else reasons.push({ v: -1, t: targetBuckId ? 'This buck has not been seen near this stand' : 'No camera activity near this stand yet' });

    // --- Wind ---
    let windScore = 0.7, speedF = 1;
    if (wx && wx.windDir != null) {
      const pts = threatPoints(stand, sightings, cfg, targetBuckId);
      windScore = windSafety(stand, wx.windDir, pts, cfg);
      speedF = windSpeedFactor(wx.wind);
      const wtxt = `${Geo.compass(wx.windDir)} wind ${Math.round(wx.wind)} mph`;
      if (windScore >= 0.75) reasons.push({ v: 1, t: `${wtxt} — scent blows away from where deer travel` });
      else if (windScore >= 0.4) reasons.push({ v: 0, t: `${wtxt} — marginal, part of the deer traffic is downwind` });
      else reasons.push({ v: -1, t: `${wtxt} — blows your scent toward the deer. Wrong wind for this stand` });
      if (wx.wind < 2) reasons.push({ v: 0, t: 'Near-calm air: thermals and swirling likely' });
      if (wx.wind > 20) reasons.push({ v: -1, t: 'High wind — deer tend to hunker down' });
    }

    // --- Weather changes ---
    let sitDT = null, sitDP = null;
    if (wx && weather) {
      const prior = [1, 2, 3].map((k) => weather.hours.filter((h) => h.t >= win.start - k * DAY && h.t <= win.end - k * DAY)).filter((x) => x.length);
      if (prior.length) {
        const pastT = prior.map((x) => avg(x, 'temp')).reduce((a, b) => a + b, 0) / prior.length;
        const dt = wx.temp - pastT; sitDT = dt;
        if (dt <= -10) { bonus += 0.18; reasons.push({ v: 1, t: `Cold snap: ${Math.round(-dt)}°F cooler than the last 3 days` }); }
        else if (dt <= -5) { bonus += 0.08; reasons.push({ v: 1, t: `Cooling trend (${Math.round(dt)}°F)` }); }
        else if (dt >= 10) { bonus -= 0.1; reasons.push({ v: -1, t: `Warm spell (+${Math.round(dt)}°F) — expect less daylight movement` }); }
      }
      const p12 = weather.at(win.start - 12 * HOUR);
      if (p12 && p12.pressure && wx.pressure) {
        const dp = wx.pressure - p12.pressure; sitDP = dp;
        if (dp >= 0.06) { bonus += 0.08; reasons.push({ v: 1, t: `Rising pressure (${wx.pressure.toFixed(2)} inHg) — post-front movement` }); }
        else if (dp <= -0.08) { bonus += 0.06; reasons.push({ v: 1, t: 'Falling pressure — deer often feed ahead of a front' }); }
      }
      if (wx.precip > 0.25) { bonus -= 0.15; reasons.push({ v: -1, t: `Heavy rain (${wx.precip.toFixed(2)}")` }); }
      else if (wx.precip > 0.02) reasons.push({ v: 0, t: 'Light rain — quiet walking in, deer still move' });
    }

    // --- Moon ---
    const mid = (win.start + win.end) / 2;
    const ill = Astro.moonIllumination(new Date(mid));
    const sol = Astro.solunar(localMidnight(mid), stand.lat, stand.lng);
    const overlaps = (p) => p.start < win.end && p.end > win.start;
    const major = sol.majors.find(overlaps), minor = sol.minors.find(overlaps);
    if (major) { bonus += 0.06; reasons.push({ v: 1, t: `Solunar major: ${major.kind} ~${fmtTime(major.center)}` }); }
    else if (minor) { bonus += 0.03; reasons.push({ v: 1, t: `Solunar minor: ${minor.kind} ~${fmtTime(minor.center)}` }); }
    if (ill.fraction > 0.85) { bonus -= 0.04; reasons.push({ v: 0, t: `${Astro.phaseName(ill.phase)} — more night feeding, consider midday` }); }
    else if (ill.fraction < 0.15) { bonus += 0.03; reasons.push({ v: 1, t: `${Astro.phaseName(ill.phase)} — dark nights push movement toward dawn/dusk` }); }

    // --- Rut ---
    const rut = rutBonus(mid, cfg);
    if (rut) { bonus += rut.b; reasons.push({ v: 1, t: rut.txt }); }

    // --- Learned weather pattern (this buck, or this stand's deer) ---
    const pat = ctx.cond && (targetBuckId ? ctx.cond.bucks[targetBuckId] : ctx.cond.stands[stand.id]);
    r_bins = wx ? Patterns.sitBins(wx, sitDT, sitDP, ill.fraction) : null;
    if (pat && wx) {
      const m = Patterns.matchSit(pat, r_bins);
      bonus += m.adj;
      const who = targetBuckId ? 'his' : "this stand's";
      if (m.hits.length) reasons.push({ v: 1, t: `Matches ${who} weather pattern: ${m.hits.map((f) => f.short).join(', ')} (${pat.tier} pattern, ${pat.n} daylight visits)` });
      if (m.misses.length) reasons.push({ v: -1, t: `${targetBuckId ? 'He rarely moves' : 'Deer here rarely move'} in ${m.misses.map((f) => f.short).join(', ')}` });
    }

    // Deer activity and conditions set the ceiling; the wind multiplies it (a wrong wind ruins any sit).
    let score = (0.45 * act + 0.25 + clamp(bonus, -0.3, 0.25)) * (0.45 + 0.55 * windScore * speedF);
    if (windScore < 0.35) score = Math.min(score, 0.33);
    return { bins: r_bins, stand, day: dayMs, which, start: win.start, end: win.end, score: Math.round(clamp(score) * 100), windScore, act, reasons, wx, moon: ill };
  }

  function fmtTime(d) { return new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  /** Every remaining AM/PM sit for each stand across the forecast. */
  /**
   * Which named bucks you might see on a sit, from each buck's own sightings near the stand
   * (recency, distance, time of day) and whether the sit's wind keeps your scent off his routes.
   */
  function bucksForSit(r, bucks, ctx) {
    const { sightings, cfg, patterns, now } = ctx;
    const out = [];
    for (const b of bucks) {
      let raw = 0, n = 0, last = 0, same = 0;
      const cams = {};
      for (const s of sightings) {
        if (s.buckId !== b.id) continue;
        const d = Geo.distanceYd(r.stand, s.cam);
        if (d > cfg.radiusYd) continue;
        const ageDays = Math.max(0, (now - s.takenAt) / DAY);
        const pm = s.period === r.which ? 1 : s.period === 'midday' ? 0.5 : s.period === 'night' ? 0.2 : 0.35;
        raw += Math.pow(0.5, ageDays / cfg.halfLifeDays) * (1 - 0.6 * d / cfg.radiusYd) * pm;
        n++; last = Math.max(last, s.takenAt); cams[s.cam.name] = (cams[s.cam.name] || 0) + 1;
        if (s.period === r.which) same++;
      }
      if (!n) continue;
      let chance = 1 - Math.exp(-raw / 2);
      const why = [];
      const daysAgo = Math.round((now - last) / DAY);
      why.push(`seen ${n}× at ${Object.keys(cams).join(', ')}, last ${daysAgo <= 0 ? 'today' : daysAgo === 1 ? 'yesterday' : daysAgo + ' days ago'}`);
      if (same) why.push(`${same} in the ${r.which === 'AM' ? 'morning' : 'evening'}`);
      if (r.wx && r.wx.windDir != null) {
        const w = windSafety(r.stand, r.wx.windDir, threatPoints(r.stand, sightings, cfg, b.id), cfg);
        chance *= 0.45 + 0.55 * w;
        if (w < 0.4) why.push('wind blows toward his travel');
        const bp = ctx.cond && ctx.cond.bucks[b.id];
        const m = bp && r.bins ? Patterns.matchSit(bp, r.bins) : null;
        if (m && m.adj) { chance = Math.max(0, Math.min(1, chance * (1 + 2 * m.adj))); }
        if (m && m.hits.length) why.push(`weather fits his pattern (${m.hits.map((f) => f.short).join(', ')})`);
        if (m && m.misses.length) why.push(`he rarely moves in ${m.misses.map((f) => f.short).join(', ')}`);
      }
      const level = chance >= 0.5 ? "good" : chance >= 0.2 ? "possible" : chance >= 0.05 ? "outside" : null;
      if (level) out.push({ buck: b, chance, level, why: why.join('; ') });
    }
    return out.sort((a, b) => b.chance - a.chance);
  }

  /** Learned weather patterns for every buck and every stand. */
  function conditionPatterns({ bucks, stands, sightings, weather, settings, center, now = Date.now() }) {
    const cfg = { ...DEFAULTS, ...(settings || {}) };
    const out = { bucks: {}, stands: {} };
    const day = sightings.filter((s) => s.period !== 'night' && s.cond);
    if (!weather || !center) return out;
    const first = weather.hours.length ? weather.hours[0].t + 3 * DAY : now;
    const oldest = day.reduce((m, s) => Math.min(m, s.takenAt), now);
    const base = Patterns.baseline(weather, center.lat, center.lng, Math.max(first, oldest - 7 * DAY), Math.min(now, weather.hours[weather.hours.length - 1].t));
    out.baseline = base;
    for (const b of bucks) out.bucks[b.id] = Patterns.analyse(Patterns.visits(day.filter((s) => s.buckId === b.id), (s) => s.buckId), base);
    for (const st of stands) {
      const near = day.filter((s) => Geo.distanceYd(st, s.cam) <= cfg.radiusYd);
      out.stands[st.id] = Patterns.analyse(Patterns.visits(near, (s) => s.buckId || 'anon-' + s.kind), base);
    }
    return out;
  }

  function planSits({ stands, sightings, weather, settings, targetBuckId, patterns, cond, bucks = [], now = Date.now(), days = 16 }) {
    const cfg = { ...DEFAULTS, ...(settings || {}) };
    const ctx = { sightings, weather, cfg, targetBuckId, patterns, cond, now };
    const lastHour = weather && weather.hours.length ? weather.hours[weather.hours.length - 1].t : now + 7 * DAY;
    const out = [];
    for (let d = 0; d < days; d++) {
      const day = localMidnight(now + d * DAY).getTime();
      if (day > lastHour) break;
      for (const which of ['AM', 'PM']) for (const st of stands) {
        const r = rateSit(st, day, which, ctx);
        if (r) { r.bucks = bucks.length ? bucksForSit(r, targetBuckId ? bucks.filter((b) => b.id === targetBuckId) : bucks, ctx) : []; out.push(r); }
      }
    }
    return out;
  }

  /**
   * Suggest stand spots for cameras with activity but no stand close by.
   * Tries 16 positions around the camera at shooting distance and picks the one whose scent clears
   * the deer traffic on the most upcoming sits (falling back to all 8 winds if no forecast).
   */
  function recommendStands({ cameras, stands, sightings, weather, settings, now = Date.now() }) {
    const cfg = { ...DEFAULTS, ...(settings || {}) };
    const upcoming = weather ? weather.hours.filter((h) => h.t > now && h.t < now + 10 * DAY && period(h.t, cameras[0]?.lat || 0, cameras[0]?.lng || 0) !== 'night') : [];
    const recs = [];
    for (const cam of cameras) {
      const near = sightings.filter((s) => s.cam.id === cam.id);
      const bucks = near.filter((s) => s.kind === 'buck');
      if (near.length < 2 && !bucks.length) continue;
      const nearestStand = stands.reduce((m, s) => Math.min(m, Geo.distanceYd(cam, s)), Infinity);
      if (nearestStand < 150) continue;
      // Travel axis (axial mean: double the angles so N and S travel reinforce)
      const hs = near.filter((s) => s.heading != null);
      const ax = Geo.circularMean(hs.map((s) => ({ deg: (s.heading * 2) % 360 })));
      const axis = ax.mean != null && ax.strength > 0.3 ? ax.mean / 2 : null;
      let best = null;
      for (let b = 0; b < 360; b += 22.5) {
        const spot = { ...Geo.offset(cam, b, cfg.shotYd), goodWinds: null };
        const pts = threatPoints(spot, near, { ...cfg, radiusYd: cfg.radiusYd + cfg.shotYd }, null);
        if (axis != null) { // the trail itself, both directions
          pts.push({ p: Geo.offset(cam, axis, 70), w: 0.7 }, { p: Geo.offset(cam, axis + 180, 70), w: 0.7 });
        }
        let s = 0;
        if (upcoming.length) s = upcoming.reduce((a, h) => a + windSafety(spot, h.windDir, pts, cfg), 0) / upcoming.length;
        else s = WIND8.reduce((a, k, i) => a + windSafety(spot, i * 45, pts, cfg), 0) / 8;
        // prefer spots off the trail (perpendicular) for a broadside shot
        if (axis != null) s -= 0.15 * Math.max(0, 1 - Math.min(Geo.angDiff(b, axis), Geo.angDiff(b, axis + 180)) / 90);
        if (!best || s > best.s) best = { s, b, spot, pts };
      }
      const good = goodWindsFor(best.spot, best.pts, cfg);
      recs.push({
        cam, lat: best.spot.lat, lng: best.spot.lng, fit: Math.round(clamp(best.s) * 100), goodWinds: good,
        text: `~${cfg.shotYd} yds ${Geo.compass(best.b)} of ${cam.name}` + (axis != null ? `, off the ${Geo.compass(axis)}–${Geo.compass(axis + 180)} travel route` : '') +
          `. Good on ${good.length ? good.join(', ') : 'few'} winds; scent stays clear on ~${Math.round(clamp(best.s) * 100)}% of upcoming daylight hours.`,
        sightings: near.length, bucks: new Set(bucks.map((b) => b.buckId).filter(Boolean)).size,
      });
    }
    return recs;
  }

  /** Good-wind list for an existing stand from the deer data around it. */
  function standWinds(stand, sightings, settings) {
    const cfg = { ...DEFAULTS, ...(settings || {}) };
    if (stand.goodWinds && stand.goodWinds.length) return { winds: stand.goodWinds, source: 'manual' };
    const pts = threatPoints(stand, sightings, cfg, null);
    if (!pts.length) return { winds: [], source: 'none' };
    return { winds: goodWindsFor(stand, pts, cfg), source: 'computed' };
  }

  window.Engine = { DEFAULTS, enrichSightings, buckPattern, conditionPatterns, planSits, recommendStands, standWinds, period, fmtTime };
})();
