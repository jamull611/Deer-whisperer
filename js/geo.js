/* Geometry helpers: distances in yards, bearings in degrees (0 = north, clockwise). */
(function () {
  const R_YD = 6371008.8 * 1.0936133; // earth radius in yards
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const norm = (d) => ((d % 360) + 360) % 360;

  function distanceYd(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_YD * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return norm(deg(Math.atan2(y, x)));
  }

  function offset(p, bearingDeg, yards) {
    const d = yards / R_YD, br = rad(bearingDeg), la = rad(p.lat), lo = rad(p.lng);
    const lat2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
    const lng2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat2));
    return { lat: deg(lat2), lng: deg(lng2) };
  }

  /** Smallest absolute difference between two bearings (0..180). */
  function angDiff(a, b) {
    const d = Math.abs(norm(a) - norm(b));
    return d > 180 ? 360 - d : d;
  }

  const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (d) => POINTS[Math.round(norm(d) / 22.5) % 16];
  const compass8 = (d) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(norm(d) / 45) % 8];
  const fromCompass = (s) => { const i = POINTS.indexOf(String(s).toUpperCase()); return i < 0 ? null : i * 22.5; };

  /** Circular mean of bearings with optional weights. Returns {mean, strength 0..1}. */
  function circularMean(list) {
    let x = 0, y = 0, w = 0;
    for (const it of list) {
      const wt = it.w ?? 1;
      x += Math.cos(rad(it.deg)) * wt; y += Math.sin(rad(it.deg)) * wt; w += wt;
    }
    if (!w) return { mean: null, strength: 0 };
    return { mean: norm(deg(Math.atan2(y, x))), strength: Math.hypot(x, y) / w };
  }

  /**
   * Direction of travel (compass heading) given camera facing and in-frame movement.
   * Camera faces F: frame-right is F+90, so left->right travel heads F+90.
   */
  function travelHeading(facing, move) {
    if (facing == null || !move) return null;
    const off = { L2R: 90, R2L: -90, toward: 180, away: 0 }[move];
    return off == null ? null : norm(facing + off);
  }

  /** Polygons are arrays of [lat, lng]. Flat-earth maths is accurate at property scale. */
  function inPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > p.lat) !== (yj > p.lat) && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  /** Shortest distance in yards from a point to a polygon's edge. */
  function distToEdgeYd(p, poly) {
    const ky = 121740, kx = 121740 * Math.cos(rad(p.lat)); // yards per degree
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ax = (poly[j][1] - p.lng) * kx, ay = (poly[j][0] - p.lat) * ky, bx = (poly[i][1] - p.lng) * kx, by = (poly[i][0] - p.lat) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  }

  window.Geo = { inPolygon, distToEdgeYd, distanceYd, bearing, offset, angDiff, compass, compass8, fromCompass, circularMean, travelHeading, norm };
})();
