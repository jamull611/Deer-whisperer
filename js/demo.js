/* A made-up demo property (farm ground in east-central Indiana) so you can see the planner work before adding your own data. */
(function () {
  const C = { lat: 40.1932, lng: -85.3864 };
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const at = (b, yd) => Geo.offset(C, b, yd);

  function fakePhoto(label, sub, ms, night) {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 480);
    if (night) { grd.addColorStop(0, '#2b2b2b'); grd.addColorStop(1, '#6b6b6b'); } else { grd.addColorStop(0, '#9fb38a'); grd.addColorStop(1, '#4d5e3a'); }
    g.fillStyle = grd; g.fillRect(0, 0, 640, 480);
    g.fillStyle = night ? '#ddd' : '#5a3e24'; // crude deer
    g.beginPath(); g.ellipse(320, 280, 110, 50, 0, 0, Math.PI * 2); g.fill();
    g.fillRect(230, 300, 14, 90); g.fillRect(270, 300, 14, 90); g.fillRect(360, 300, 14, 90); g.fillRect(400, 300, 14, 90);
    g.beginPath(); g.ellipse(445, 215, 32, 22, -0.5, 0, Math.PI * 2); g.fill(); g.fillRect(410, 220, 30, 50);
    g.fillStyle = '#000a'; g.fillRect(0, 440, 640, 40);
    g.fillStyle = '#fff'; g.font = 'bold 26px system-ui'; g.fillText('DEMO PHOTO', 16, 40);
    g.font = '22px system-ui'; g.fillText(label, 16, 72); g.fillText(sub, 16, 100);
    g.font = '18px monospace'; g.fillText(new Date(ms).toLocaleString(), 16, 467);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.7));
  }

  async function load() {
    seed = 7;
    const id = () => Store.uid();
    const cams = [
      { id: id(), name: 'Creek Crossing', ...at(300, 260), facing: 90, notes: 'Shallow crossing below the beaver dam' },
      { id: id(), name: 'Ridge Saddle', ...at(20, 330), facing: 180, notes: '' },
      { id: id(), name: 'Clover Plot', ...at(160, 230), facing: 270, notes: 'NE corner of the 2-acre plot' },
      { id: id(), name: 'Fence-line Pinch', ...at(230, 420), facing: 0, notes: 'Woods narrow to ~40 yds here' },
    ];
    const stands = [
      { id: id(), name: 'Big Oak', ...at(285, 300), type: 'Hang-on', goodWinds: [], notes: '' },
      { id: id(), name: 'Plot Ladder', ...at(150, 260), type: 'Ladder', goodWinds: ['N', 'NE', 'E'], notes: 'Owner says east winds only' },
      { id: id(), name: 'Saddle Climber', ...at(35, 360), type: 'Climber', goodWinds: [], notes: '' },
    ];
    const bucks = [
      { id: id(), name: 'Switchblade', points: '11pt, ~4.5 yrs', description: 'Tall 10 with a kicker off the right G2, heavy bases', created: Date.now() },
      { id: id(), name: 'Wingspan', points: '8pt, ~3.5 yrs', description: 'Very wide, short tines, broken left brow', created: Date.now() },
      { id: id(), name: 'Forktongue', points: '9pt', description: 'Split brow tine on the left side, dark rack', created: Date.now() },
    ];
    const [cr, rs, cp, fp] = cams, [kick, wide, split] = bucks;
    // [camera, buckOrKind, travel, hourOfDay] patterns
    const patterns = [
      [cr, kick, 'L2R', 6.8], [cr, kick, 'L2R', 7.4], [cr, kick, 'R2L', 23], [cr, 'doe', 'L2R', 17.5], [cr, 'doe', 'R2L', 18],
      [rs, wide, 'away', 8.2], [rs, wide, 'toward', 17.9], [rs, split, 'away', 7.1], [rs, kick, 'toward', 2],
      [cp, 'doe', 'R2L', 17.6], [cp, 'doe', 'R2L', 17.9], [cp, 'fawn', 'R2L', 18.1], [cp, wide, 'R2L', 18.3], [cp, split, 'L2R', 21],
      [fp, kick, 'toward', 16.9], [fp, kick, 'toward', 17.3], [fp, 'doe', 'away', 7], [fp, split, 'toward', 17.8], [fp, 'doe', 'toward', 16.5],
    ];
    const photos = [];
    for (let rep = 0; rep < 3; rep++) for (const [cam, who, travel, hr] of patterns) {
      if (rnd() < 0.3) continue;
      const daysAgo = Math.floor(rnd() * 30) + rep;
      const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(0, 0, 0, 0);
      const ms = d.getTime() + (hr + (rnd() - 0.5) * 0.8) * 36e5;
      if (ms > Date.now()) continue;
      const isBuck = typeof who === 'object';
      const night = hr < 6.3 || hr > 18.6;
      const blob = await fakePhoto(isBuck ? `${who.name} (buck)` : who, `${cam.name} · moving ${travel}`, ms, night);
      const thumb = await Store.blobToDataURL(blob);
      photos.push({ id: id(), cameraId: cam.id, takenAt: ms, kind: isBuck ? 'buck' : who, buckId: isBuck ? who.id : '', travel, blob, thumb, fileName: 'demo.jpg', demo: true });
    }
    kick.refPhotoId = (photos.find((p) => p.buckId === kick.id) || {}).id || '';
    wide.refPhotoId = (photos.find((p) => p.buckId === wide.id) || {}).id || '';
    split.refPhotoId = (photos.find((p) => p.buckId === split.id) || {}).id || '';
    for (const c of cams) await Store.put('cameras', c);
    for (const s of stands) await Store.put('stands', s);
    for (const b of bucks) await Store.put('bucks', b);
    for (const p of photos) await Store.put('photos', p);
  }

  window.Demo = { load };
})();
