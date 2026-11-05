/*
 * Sun & moon calculations (adapted from the public-domain/BSD formulas popularised by SunCalc,
 * Vladimir Agafonkin). Used for sunrise/sunset, moon phase and solunar (moon over/underfoot) windows.
 */
(function () {
  const PI = Math.PI, rad = PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, e = rad * 23.4397;
  const toJulian = (d) => d.valueOf() / dayMs - 0.5 + J1970;
  const fromJulian = (j) => new Date((j + 0.5 - J1970) * dayMs);
  const toDays = (d) => toJulian(d) - J2000;
  const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const azimuth = (H, phi, dec) => Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const altitude = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
  const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
  function eclipticLongitude(M) {
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    return M + C + rad * 102.9372 + PI;
  }
  function sunCoords(d) {
    const M = solarMeanAnomaly(d), L = eclipticLongitude(M);
    return { dec: declination(L, 0), ra: rightAscension(L, 0) };
  }
  const J0 = 0.0009;
  const julianCycle = (d, lw) => Math.round(d - J0 - lw / (2 * PI));
  const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * PI) + n;
  const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const hourAngle = (h, phi, d) => Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));

  function sunTimes(date, lat, lng) {
    const lw = rad * -lng, phi = rad * lat, d = toDays(date), n = julianCycle(d, lw), ds = approxTransit(0, lw, n);
    const M = solarMeanAnomaly(ds), L = eclipticLongitude(M), dec = declination(L, 0), Jnoon = solarTransitJ(ds, M, L);
    const at = (h) => {
      const w = hourAngle(h * rad, phi, dec), a = approxTransit(w, lw, n);
      const Jset = solarTransitJ(a, M, L);
      return { rise: fromJulian(Jnoon - (Jset - Jnoon)), set: fromJulian(Jset) };
    };
    const s = at(-0.833), civil = at(-6);
    return { sunrise: s.rise, sunset: s.set, dawn: civil.rise, dusk: civil.set, noon: fromJulian(Jnoon) };
  }

  function moonCoords(d) {
    const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.22935 * d);
    const l = L + rad * 6.289 * Math.sin(M), b = rad * 5.128 * Math.sin(F), dt = 385001 - 20905 * Math.cos(M);
    return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
  }

  function moonPosition(date, lat, lng) {
    const lw = rad * -lng, phi = rad * lat, d = toDays(date), c = moonCoords(d), H = siderealTime(d, lw) - c.ra;
    return { azimuth: azimuth(H, phi, c.dec), altitude: altitude(H, phi, c.dec), hourAngle: H };
  }

  /** fraction 0..1 illuminated, phase 0=new .25=first qtr .5=full .75=last qtr */
  function moonIllumination(date) {
    const d = toDays(date || new Date()), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
    const phiA = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    const inc = Math.atan2(sdist * Math.sin(phiA), m.dist - sdist * Math.cos(phiA));
    const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
    return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / PI };
  }

  function phaseName(p) {
    const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
    return names[Math.round(p * 8) % 8];
  }
  function phaseEmoji(p) { return ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'][Math.round(p * 8) % 8]; }

  /**
   * Solunar periods for the 24h starting at `dayStart` (local midnight).
   * Majors = moon overhead / underfoot (±1h), minors = moonrise / moonset (±30 min).
   * Found by scanning in 10-minute steps — accurate to a few minutes, plenty for hunting.
   */
  function solunar(dayStart, lat, lng) {
    const step = 10 * 60e3, out = { majors: [], minors: [] };
    let prev = moonPosition(new Date(dayStart.getTime() - step), lat, lng);
    for (let t = dayStart.getTime(); t < dayStart.getTime() + dayMs; t += step) {
      const cur = moonPosition(new Date(t), lat, lng);
      // altitude crossing horizon -> rise/set (minor)
      if ((prev.altitude < 0) !== (cur.altitude < 0)) out.minors.push({ center: new Date(t), kind: cur.altitude > 0 ? 'moonrise' : 'moonset' });
      // hour angle crossing 0 (overhead) or PI (underfoot) -> major
      const hp = ((prev.hourAngle % (2 * PI)) + 2 * PI) % (2 * PI), hc = ((cur.hourAngle % (2 * PI)) + 2 * PI) % (2 * PI);
      if (hc < hp) out.majors.push({ center: new Date(t), kind: 'moon overhead' });
      else if (hp < PI && hc >= PI) out.majors.push({ center: new Date(t), kind: 'moon underfoot' });
      prev = cur;
    }
    out.majors.forEach((p) => { p.start = new Date(p.center - 60 * 60e3); p.end = new Date(+p.center + 60 * 60e3); });
    out.minors.forEach((p) => { p.start = new Date(p.center - 30 * 60e3); p.end = new Date(+p.center + 30 * 60e3); });
    return out;
  }

  window.Astro = { sunTimes, moonPosition, moonIllumination, phaseName, phaseEmoji, solunar };
})();
