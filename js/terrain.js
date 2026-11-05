/*
 * Reads the satellite image around a camera to tell tree cover from open ground (fields, roads, plots).
 *
 * Each ~4 m cell gets a brightness and a texture value; tree canopy is darker and rougher than fields
 * or roads. Rather than fixed thresholds (imagery varies by season and source), the split between
 * "trees" and "open" is found per camera with Otsu's method. If the area is all one thing, or the two
 * groups do not differ clearly, the sampler reports itself unusable and suggestions ignore terrain.
 */
(function () {
  const Z = 17;
  const TILE = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  const tileCache = new Map();

  const px = (lat, lng, z = Z) => {
    const n = 256 * Math.pow(2, z), s = Math.sin((lat * Math.PI) / 180);
    return { x: ((lng + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  };

  function loadTile(x, y) {
    const key = `${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas'); c.width = c.height = 256;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          resolve(g.getImageData(0, 0, 256, 256).data);
        } catch { resolve(null); } // image not readable (no CORS): skip terrain
      };
      img.onerror = () => resolve(null);
      img.src = TILE(Z, x, y);
    });
    tileCache.set(key, p);
    return p;
  }

  /** Mean luminance (0..1) and texture (std dev) of a 5x5 pixel patch. */
  function patch(tiles, gx, gy) {
    let sum = 0, sum2 = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const X = Math.floor(gx) + dx, Y = Math.floor(gy) + dy;
      const t = tiles.get(`${Math.floor(X / 256)}/${Math.floor(Y / 256)}`);
      if (!t) continue;
      const i = (((Y % 256) + 256) % 256 * 256 + (((X % 256) + 256) % 256)) * 4;
      const l = (0.2126 * t[i] + 0.7152 * t[i + 1] + 0.0722 * t[i + 2]) / 255;
      sum += l; sum2 += l * l; n++;
    }
    if (!n) return null;
    const m = sum / n;
    return { lum: m, tex: Math.sqrt(Math.max(0, sum2 / n - m * m)) };
  }

  /** Otsu threshold over values in 0..1. */
  function otsu(vals) {
    const bins = 64, h = new Array(bins).fill(0);
    vals.forEach((v) => h[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))]++);
    const total = vals.length; let sumAll = 0; h.forEach((c, i) => (sumAll += i * c));
    let wB = 0, sumB = 0, best = -1, thr = 0;
    for (let i = 0; i < bins; i++) {
      wB += h[i]; if (!wB) continue; const wF = total - wB; if (!wF) break;
      sumB += i * h[i]; const mB = sumB / wB, mF = (sumAll - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; thr = (i + 1) / bins; }
    }
    return thr;
  }

  /**
   * Build a sampler for the area within `radiusYd` of a point.
   * Returns { ok, trees(lat,lng) -> true|false|null, why }.
   */
  async function samplerFor(center, radiusYd) {
    const r = radiusYd + 30;
    const a = px(Geo.offset(center, 0, r).lat, Geo.offset(center, 270, r).lng), b = px(Geo.offset(center, 180, r).lat, Geo.offset(center, 90, r).lng);
    const tiles = new Map(), jobs = [];
    for (let tx = Math.floor(a.x / 256); tx <= Math.floor(b.x / 256); tx++) for (let ty = Math.floor(a.y / 256); ty <= Math.floor(b.y / 256); ty++) {
      jobs.push(loadTile(tx, ty).then((d) => { if (d) tiles.set(`${tx}/${ty}`, d); }));
    }
    await Promise.all(jobs);
    if (!tiles.size) return { ok: false, why: 'satellite image not available' };
    // Score each cell: darker and rougher = more tree-like. Calibrate on this area only.
    const score = (p) => Math.max(0, Math.min(1, (1 - p.lum) * 0.7 + Math.min(1, p.tex * 6) * 0.3));
    const samples = [];
    for (let dy = -radiusYd; dy <= radiusYd; dy += 4) for (let dx = -radiusYd; dx <= radiusYd; dx += 4) {
      const pt = Geo.offset(Geo.offset(center, 0, dy), 90, dx), g = px(pt.lat, pt.lng), p = patch(tiles, g.x, g.y);
      if (p) samples.push(score(p));
    }
    if (samples.length < 50) return { ok: false, why: 'not enough imagery' };
    const thr = otsu(samples);
    const hi = samples.filter((s) => s >= thr), lo = samples.filter((s) => s < thr);
    const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
    // Need two clearly different groups, each a real share of the area.
    if (hi.length < samples.length * 0.08 || lo.length < samples.length * 0.08 || mean(hi) - mean(lo) < 0.12) {
      return { ok: false, why: 'area looks uniform (all woods or all open)' };
    }
    return {
      ok: true, thr,
      trees(lat, lng) { const g = px(lat, lng), p = patch(tiles, g.x, g.y); return p ? score(p) >= thr : null; },
    };
  }

  /**
   * Check the line from a stand to where the deer pass.
   * Returns { standInTrees, longestTreeRun (yds, ignoring the first 6 yds next to the stand), edgeYd }.
   */
  function sightline(sampler, stand, target) {
    const d = Geo.distanceYd(stand, target), brg = Geo.bearing(stand, target);
    let run = 0, longest = 0, edgeYd = null;
    const standInTrees = sampler.trees(stand.lat, stand.lng);
    for (let s = 2; s <= d - 3; s += 2) {
      const p = Geo.offset(stand, brg, s), t = sampler.trees(p.lat, p.lng);
      if (t === false && edgeYd == null) edgeYd = s;
      if (s < 6) continue;
      run = t ? run + 2 : 0; longest = Math.max(longest, run);
    }
    return { standInTrees, longestTreeRun: longest, edgeYd };
  }

  window.Terrain = { samplerFor, sightline };
})();
