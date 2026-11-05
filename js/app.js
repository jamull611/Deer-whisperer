/* UI wiring for Deer Whisperer. */
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DIRS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const WIND8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const TRAVEL = { '': 'Not sure / standing', L2R: 'Left → right', R2L: 'Right → left', toward: 'Toward camera', away: 'Away from camera' };
  const KINDS = { '': '— needs review —', buck: 'Buck', doe: 'Doe', fawn: 'Fawn', none: 'No deer' };

  const S = { cameras: [], stands: [], bucks: [], photos: [], settings: {}, weather: null, weatherErr: null, recs: [], target: '' };

  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
  function modal(html) { $('#modal-content').innerHTML = html; $('#modal').showModal(); }
  const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtDT = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const toLocalInput = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

  // ---------- data ----------
  async function loadAll() {
    [S.cameras, S.stands, S.bucks, S.photos] = await Promise.all(['cameras', 'stands', 'bucks', 'photos'].map(Store.all));
    S.photos.sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0));
    S.settings = {
      rutPeak: await Store.getSetting('rutPeak', Engine.DEFAULTS.rutPeak),
      shotYd: await Store.getSetting('shotYd', Engine.DEFAULTS.shotYd),
      radiusYd: await Store.getSetting('radiusYd', Engine.DEFAULTS.radiusYd),
      center: await Store.getSetting('center', null),
    };
    try { S.apiKey = localStorage.getItem('dw.apiKey') || ''; S.model = localStorage.getItem('dw.model') || AI.DEFAULT_MODEL; } catch { S.apiKey = ''; S.model = AI.DEFAULT_MODEL; }
  }
  function center() {
    const pts = [...S.cameras, ...S.stands];
    if (pts.length) return { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length };
    return S.settings.center;
  }
  const sightings = () => Engine.enrichSightings(S.photos, S.cameras, S.weather);
  const camName = (id) => (S.cameras.find((c) => c.id === id) || {}).name || '—';
  const buckName = (id) => (S.bucks.find((b) => b.id === id) || {}).name || '—';

  async function ensureWeather(force) {
    const c = center();
    if (!c) { S.weather = null; return; }
    try { S.weather = Weather.merge(S.archive, await Weather.load(c.lat, c.lng, { force })); S.weatherErr = null; }
    catch (e) { S.weatherErr = e.message; S.weather = S.archive || null; }
    await backfillWeather();
  }

  /** Save the conditions at each photo's time onto the photo, fetching older history when needed. */
  async function backfillWeather() {
    const c = center(), DAY = 864e5;
    if (!c || !S.weather || !S.weather.hours.length) return;
    const start = S.weather.hours[0].t;
    const old = S.photos.filter((p) => p.takenAt && !p.wxSnap && p.takenAt < start + 3 * DAY);
    if (old.length && !S.archiveTried) {
      S.archiveTried = true;
      const from = Math.max(Math.min(...old.map((p) => p.takenAt)) - 4 * DAY, Date.now() - 730 * DAY);
      if (from < start) {
        try { S.archive = await Weather.loadArchive(c.lat, c.lng, from, start); S.weather = Weather.merge(S.archive, S.weather); }
        catch (e) { console.warn('Weather history unavailable', e); }
      }
    }
    for (const p of S.photos) {
      if (p.wxSnap || !p.takenAt || p.takenAt > Date.now()) continue;
      const cond = Patterns.conditionsAt(S.weather, p.takenAt);
      if (cond && cond.dTemp != null && cond.dPress != null) { p.wxSnap = cond; await Store.put('photos', p); }
    }
  }
  const condPatterns = (sts) => Engine.conditionPatterns({ bucks: S.bucks, stands: S.stands, sightings: sts, weather: S.weather, settings: S.settings, center: center() });

  function patternHTML(cp, who) {
    if (!cp) return '';
    if (cp.tier === 'none') return `<div class="pattern small muted"><b>Weather pattern:</b> not enough data yet. ${cp.n} of ${Patterns.MIN_EARLY} daylight visits needed (all photos of a deer from the same morning, midday or evening count as one visit).</div>`;
    const head = cp.tier === 'established'
      ? `<b>Weather pattern</b> <span class="pill good">Established</span> ${cp.n} daylight visits.`
      : `<b>Weather pattern</b> <span class="pill">Early</span> ${cp.n} daylight visits, so only very strong signals are shown. Fuller analysis at ${Patterns.MIN_ESTABLISHED}.`;
    if (!cp.findings.length) return `<div class="pattern small">${head}<br>No clear weather preference yet: ${who} moving in all kinds of conditions.</div>`;
    const combo = cp.combo ? `<li class="p"><b>Best combination:</b> ${esc(cp.combo.f1.short)} + ${esc(cp.combo.f2.short)}: ${cp.combo.k} of ${cp.combo.n} visits (${Math.round(cp.combo.share * 100)}%) vs about ${Math.round(cp.combo.base * 100)}% of daylight hours.</li>` : '';
    return `<div class="pattern small">${head}<ul class="reasons">${cp.findings.map((f) => `<li class="${f.dir === 'more' ? 'p' : 'n'}">${esc(Patterns.describe(f))}</li>`).join('')}${combo}</ul></div>`;
  }

  // ---------- tabs ----------
  function showTab(name) {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
    if (name === 'map') { initMap(); setTimeout(() => map.invalidateSize(), 50); }
    if (name === 'plan') renderPlan();
    if (name === 'photos') renderPhotos();
    if (name === 'bucks') renderBucks();
    try { localStorage.setItem('dw.tab', name); } catch { /* ignore */ }
  }

  // ---------- map ----------
  let map, layer, placing = null;
  const markerById = {};
  function initMap() {
    if (map) return;
    const c = center();
    map = L.map('map', { zoomControl: true }).setView(c ? [c.lat, c.lng] : [39.8, -89.6], c ? 16 : 5);
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri' });
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap' });
    const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
    sat.addTo(map);
    L.control.layers({ Satellite: sat, Topo: topo, Street: street }).addTo(map);
    layer = L.layerGroup().addTo(map);
    map.on('click', onMapClick);
    renderMarkers();
    if (S.cameras.length + S.stands.length > 1) map.fitBounds(L.latLngBounds([...S.cameras, ...S.stands].map((p) => [p.lat, p.lng])).pad(0.3));
  }

  function icon(kind, facing) {
    const em = kind === 'camera' ? '📷' : kind === 'rec' ? '⭐' : '🪜';
    const arrow = kind === 'camera' && facing != null ? `<span class="arrow" style="transform:rotate(${facing}deg)"></span>` : '';
    return L.divIcon({ className: '', html: `<div class="mk ${kind === 'rec' ? 'rec' : ''}">${arrow}${em}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  }

  function renderMarkers() {
    if (!layer) return;
    const openId = Object.keys(markerById).find((k) => markerById[k].isPopupOpen());
    layer.clearLayers();
    for (const k in markerById) delete markerById[k];
    for (const c of S.cameras) {
      const m = L.marker([c.lat, c.lng], { icon: icon('camera', c.facing), draggable: true }).addTo(layer);
      markerById[c.id] = m;
      m.bindTooltip(c.name, { permanent: true, direction: 'bottom', offset: [0, 10], className: 'mk-label' });
      m.bindPopup(() => cameraForm(c));
      m.on('dragend', async () => { c.lat = m.getLatLng().lat; c.lng = m.getLatLng().lng; await Store.put('cameras', c); dataChanged(); });
    }
    const sts = sightings();
    for (const s of S.stands) {
      const m = L.marker([s.lat, s.lng], { icon: icon('stand'), draggable: true }).addTo(layer);
      markerById[s.id] = m;
      m.bindTooltip(s.name, { permanent: true, direction: 'bottom', offset: [0, 10], className: 'mk-label' });
      m.bindPopup(() => standForm(s, sts));
      m.on('dragend', async () => { s.lat = m.getLatLng().lat; s.lng = m.getLatLng().lng; await Store.put('stands', s); dataChanged(); });
    }
    for (const r of S.recs) {
      const m = L.marker([r.lat, r.lng], { icon: icon('rec') }).addTo(layer);
      m.bindPopup(() => {
        const d = document.createElement('div');
        d.innerHTML = `<b>Suggested stand</b><p>${esc(r.text)}</p><button>Add stand here</button>`;
        d.querySelector('button').onclick = () => addStandAt(r.lat, r.lng, `Stand near ${r.cam.name}`);
        return d;
      });
    }
    if (openId && markerById[openId]) markerById[openId].openPopup();
  }

  function dirSelect(val, allowBlank) {
    return `<select data-f="facing">${allowBlank ? '<option value="">Unknown</option>' : ''}${DIRS16.map((d, i) => `<option value="${i * 22.5}" ${val === i * 22.5 ? 'selected' : ''}>${d}</option>`).join('')}</select>`;
  }

  function cameraForm(c) {
    const d = document.createElement('div');
    const n = S.photos.filter((p) => p.cameraId === c.id).length;
    d.innerHTML = `<label>Name<input data-f="name" value="${esc(c.name)}"></label>
      <label>Lens faces ${dirSelect(c.facing, true)}</label>
      <label>Notes<textarea data-f="notes" rows="2">${esc(c.notes)}</textarea></label>
      <div class="small">${n} photo${n === 1 ? '' : 's'}</div>
      <div class="row" style="margin-top:.4rem"><button data-a="save">Save</button><button data-a="del" class="danger">Delete</button></div>`;
    d.querySelector('[data-a=save]').onclick = async () => {
      c.name = d.querySelector('[data-f=name]').value.trim() || c.name;
      const f = d.querySelector('[data-f=facing]').value; c.facing = f === '' ? null : Number(f);
      c.notes = d.querySelector('[data-f=notes]').value;
      await Store.put('cameras', c); map.closePopup(); dataChanged(); toast('Camera saved');
    };
    d.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`Delete camera "${c.name}"? Its photos stay but lose their location.`)) return;
      await Store.del('cameras', c.id); S.cameras = S.cameras.filter((x) => x !== c); map.closePopup(); dataChanged();
    };
    return d;
  }

  function standForm(s, sts) {
    const d = document.createElement('div');
    const w = Engine.standWinds(s, sts, S.settings);
    const sugg = w.source === 'computed' ? `<div class="small">From your camera data, best winds: <b>${w.winds.join(', ') || 'none clear'}</b></div>` : '';
    d.innerHTML = `<label>Name<input data-f="name" value="${esc(s.name)}"></label>
      <label>Type<select data-f="type">${['Ladder', 'Hang-on', 'Climber', 'Ground blind', 'Box blind', 'Saddle'].map((t) => `<option ${s.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="small" style="color:#555">Good winds you already know (optional — leave blank to let the app work it out):</div>
      <div class="row" style="gap:.2rem;margin:.2rem 0 .4rem">${WIND8.map((k) => `<label class="check" style="margin:0 .3rem 0 0;color:#222"><input type="checkbox" value="${k}" ${s.goodWinds && s.goodWinds.includes(k) ? 'checked' : ''}>${k}</label>`).join('')}</div>
      ${sugg}
      <label>Notes<textarea data-f="notes" rows="2">${esc(s.notes)}</textarea></label>
      <div class="row"><button data-a="save">Save</button><button data-a="del" class="danger">Delete</button></div>`;
    d.querySelector('[data-a=save]').onclick = async () => {
      s.name = d.querySelector('[data-f=name]').value.trim() || s.name;
      s.type = d.querySelector('[data-f=type]').value;
      s.goodWinds = $$('input[type=checkbox]:checked', d).map((x) => x.value);
      s.notes = d.querySelector('[data-f=notes]').value;
      await Store.put('stands', s); map.closePopup(); dataChanged(); toast('Stand saved');
    };
    d.querySelector('[data-a=del]').onclick = async () => {
      if (!confirm(`Delete stand "${s.name}"?`)) return;
      await Store.del('stands', s.id); S.stands = S.stands.filter((x) => x !== s); map.closePopup(); dataChanged();
    };
    return d;
  }

  function onMapClick(e) {
    if (!placing) return;
    const { lat, lng } = e.latlng, kind = placing; placing = null; $('#map-hint').textContent = '';
    if (kind === 'camera') {
      const c = { id: Store.uid(), name: `Camera ${S.cameras.length + 1}`, lat, lng, facing: 0, notes: '' };
      S.cameras.push(c); Store.put('cameras', c).then(() => { renderMarkers(); openPopupFor(c); dataChanged(); });
    } else addStandAt(lat, lng);
  }
  async function addStandAt(lat, lng, name) {
    const s = { id: Store.uid(), name: name || `Stand ${S.stands.length + 1}`, lat, lng, type: 'Ladder', goodWinds: [], notes: '' };
    S.stands.push(s); await Store.put('stands', s);
    if (map) { map.closePopup(); renderMarkers(); openPopupFor(s); }
    dataChanged(); toast('Stand added');
  }
  function openPopupFor(obj) {
    const m = markerById[obj.id]; if (m) m.openPopup();
  }

  // ---------- photos ----------
  async function makeThumb(blob, max = 480) {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.75);
  }
  async function readTakenAt(file) {
    try {
      const ex = await exifr.parse(file, { tiff: true, ifd0: true, exif: true, gps: false, xmp: false, icc: false, iptc: false, jfif: false });
      const d = ex && (ex.DateTimeOriginal || ex.CreateDate || ex.ModifyDate);
      if (d instanceof Date && !isNaN(d)) return { t: d.getTime(), exif: true };
    } catch { /* no exif */ }
    return { t: file.lastModified || Date.now(), exif: false };
  }

  async function handleUpload(files) {
    const camId = $('#up-camera').value;
    if (!camId) { toast('Add a camera on the Map tab first, then pick it here.'); return; }
    const useAI = $('#up-ai').checked;
    const prog = $('#up-progress');
    let i = 0;
    for (const f of files) {
      i++; prog.textContent = `Adding ${i} of ${files.length}…`;
      const when = await readTakenAt(f);
      const p = { id: Store.uid(), cameraId: camId, takenAt: when.t, exifTrusted: when.exif, kind: '', buckId: '', travel: '', blob: f, thumb: await makeThumb(f), fileName: f.name, added: Date.now() };
      await Store.put('photos', p); S.photos.unshift(p);
      if (useAI) { prog.textContent = `AI is looking at photo ${i} of ${files.length}…`; await runAI(p, true); }
    }
    S.photos.sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0));
    prog.textContent = `Added ${files.length} photo${files.length > 1 ? 's' : ''}.`;
    renderPhotos(); dataChanged(true);
  }

  async function runAI(p, quiet) {
    if (!S.apiKey) { toast('Add your Anthropic API key in Settings first.'); return; }
    try {
      const known = await Promise.all(S.bucks.map(async (b) => {
        const ref = b.refPhotoId && S.photos.find((x) => x.id === b.refPhotoId);
        return { id: b.id, name: b.name, description: [b.points ? `${b.points} points` : '', b.description].filter(Boolean).join('. '), refBlob: ref && ref.blob };
      }));
      const r = await AI.identify({ apiKey: S.apiKey, model: S.model, photoBlob: p.blob, knownBucks: known });
      p.ai = { at: Date.now(), result: r };
      if (r.overlay_datetime) { const t = Date.parse(r.overlay_datetime); if (!isNaN(t) && Math.abs(t - p.takenAt) > 5 * 60e3 && !p.exifTrusted) p.takenAt = t; }
      if (!r.deer_present || !r.animals.length) { p.kind = 'none'; }
      else {
        // Focus on the most interesting animal: a buck if there is one.
        const a = r.animals.find((x) => x.kind === 'buck') || r.animals[0];
        p.kind = a.kind === 'buck' ? 'buck' : a.kind === 'fawn' ? 'fawn' : a.kind === 'doe' ? 'doe' : '';
        if (['L2R', 'R2L', 'toward', 'away'].includes(a.movement_in_frame)) p.travel = a.movement_in_frame;
        if (a.kind === 'buck') {
          const match = S.bucks.find((b) => b.id === a.match_buck_id);
          if (match && a.match_confidence !== 'low' && a.match_confidence !== 'none') p.buckId = match.id;
          else p.aiSuggest = { name: a.suggested_name || 'New buck', points: a.est_points, description: [a.antler_description, a.distinguishing_features].filter(Boolean).join('. ') };
        }
        p.count = r.animals.filter((x) => x.kind !== 'other_animal').length;
      }
      p.needsCheck = true;
      await Store.put('photos', p);
      if (!quiet) { renderPhotos(); dataChanged(true); toast('AI finished — check the result.'); }
    } catch (e) { console.error(e); toast('AI error: ' + e.message, 5000); }
  }

  function photoCard(p) {
    const el = document.createElement('div');
    el.className = 'photo' + (!p.kind || p.needsCheck ? ' review' : '');
    const cam = S.cameras.find((c) => c.id === p.cameraId);
    const heading = cam ? Geo.travelHeading(cam.facing, p.travel) : null;
    const ai = p.ai && p.ai.result;
    const aiA = ai && ai.animals && (ai.animals.find((x) => x.kind === 'buck') || ai.animals[0]);
    el.innerHTML = `<img alt="" src="${p.thumb}">
      <div class="body">
        <label><select data-f="cam" aria-label="Camera">${S.cameras.map((c) => `<option value="${c.id}" ${p.cameraId === c.id ? 'selected' : ''}>📷 ${esc(c.name)}</option>`).join('')}${S.cameras.some((c) => c.id === p.cameraId) ? '' : '<option value="" selected>📷 No camera</option>'}</select></label>
        <div class="meta">${fmtDT(p.takenAt)} ${p.kind && cam ? `· ${Engine.period(p.takenAt, cam.lat, cam.lng)}` : ''}</div>
        ${ai ? `<div class="small"><span class="pill ai">AI</span>${esc(aiA ? `${aiA.kind}${aiA.est_points ? ` ~${aiA.est_points}pt` : ''}${aiA.match_confidence !== 'none' ? ` · match ${aiA.match_confidence}` : ''}. ${aiA.antler_description || ''}` : ai.notes)}</div>` : ''}
        <label><select data-f="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${p.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label ${p.kind === 'buck' ? '' : 'hidden'}><select data-f="buck"><option value="">Which buck?</option>${S.bucks.map((b) => `<option value="${b.id}" ${p.buckId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}<option value="__new">＋ New buck${p.aiSuggest ? ` (“${esc(p.aiSuggest.name)}”)` : ''}…</option></select></label>
        <label ${p.kind && p.kind !== 'none' ? '' : 'hidden'}>Moving in photo<select data-f="travel">${Object.entries(TRAVEL).map(([k, v]) => `<option value="${k}" ${p.travel === k || (!p.travel && !k) ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        ${heading != null ? `<div class="small">Heading <b>${Geo.compass(heading)}</b></div>` : p.travel && cam && cam.facing == null ? '<div class="small muted">Set the camera’s facing on the map to get a heading.</div>' : ''}
        <label>Time<input type="datetime-local" data-f="time" value="${toLocalInput(p.takenAt)}"></label>
        <div class="row">${p.needsCheck ? '<button class="tiny" data-a="ok">✓ Looks right</button>' : ''}<button class="tiny ghost" data-a="ai">AI ID</button><button class="tiny ghost" data-a="del">Delete</button></div>
      </div>`;
    el.querySelector('img').onclick = () => modal(`<img src="${URL.createObjectURL(p.blob)}" alt=""><p class="small">${esc(camName(p.cameraId))} · ${fmtDT(p.takenAt)} ${p.fileName ? '· ' + esc(p.fileName) : ''}</p>${ai ? `<pre class="small" style="white-space:pre-wrap">${esc(JSON.stringify(ai, null, 2))}</pre>` : ''}`);
    const save = async (rerender) => { p.needsCheck = false; await Store.put('photos', p); if (rerender) renderPhotos(); dataChanged(true); };
    el.querySelector('[data-f=kind]').onchange = (e) => { p.kind = e.target.value; if (p.kind !== 'buck') p.buckId = ''; save(true); };
    el.querySelector('[data-f=buck]').onchange = async (e) => {
      if (e.target.value === '__new') {
        const sug = p.aiSuggest || {};
        const name = prompt('Name this buck', sug.name || '');
        if (!name) { e.target.value = p.buckId || ''; return; }
        const b = { id: Store.uid(), name, points: sug.points || '', description: sug.description || '', refPhotoId: p.id, created: Date.now() };
        await Store.put('bucks', b); S.bucks.push(b); p.buckId = b.id; delete p.aiSuggest;
      } else p.buckId = e.target.value;
      save(true);
    };
    el.querySelector('[data-f=travel]').onchange = (e) => { p.travel = e.target.value; save(true); };
    el.querySelector('[data-f=cam]').onchange = (e) => { p.cameraId = e.target.value; save(true); };
    el.querySelector('[data-f=time]').onchange = (e) => { const t = new Date(e.target.value).getTime(); if (!isNaN(t)) { p.takenAt = t; save(true); } };
    const ok = el.querySelector('[data-a=ok]'); if (ok) ok.onclick = () => save(true);
    el.querySelector('[data-a=ai]').onclick = async (e) => { e.target.disabled = true; e.target.textContent = 'Looking…'; await runAI(p); };
    el.querySelector('[data-a=del]').onclick = async () => { if (!confirm('Delete this photo?')) return; await Store.del('photos', p.id); S.photos = S.photos.filter((x) => x !== p); renderPhotos(); dataChanged(true); };
    return el;
  }

  function renderPhotos() {
    const camOpts = S.cameras.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    const upSel = $('#up-camera'), keep = upSel.value;
    upSel.innerHTML = camOpts || '<option value="">Add a camera on the map first</option>'; if (keep) upSel.value = keep;
    const fSel = $('#ph-filter-cam'), fk = fSel.value; fSel.innerHTML = '<option value="">All</option>' + camOpts; fSel.value = fk;
    const kind = $('#ph-filter-kind').value;
    const list = S.photos.filter((p) => (!fSel.value || p.cameraId === fSel.value) && (
      !kind || (kind === 'review' && (!p.kind || p.needsCheck)) || (kind === 'buck' && p.kind === 'buck') || (kind === 'doe' && (p.kind === 'doe' || p.kind === 'fawn'))));
    $('#ph-move').innerHTML = camOpts; S.shownPhotos = list;
    $('#ph-move-go').disabled = !list.length || !S.cameras.length;
    const grid = $('#photo-grid'); grid.innerHTML = '';
    if (!list.length) grid.innerHTML = '<div class="empty">No photos here yet.</div>';
    const shown = list.slice(0, 200); shown.forEach((p) => grid.appendChild(photoCard(p)));
    $('#ph-count').textContent = `${list.length} photo${list.length === 1 ? '' : 's'}${list.length > shown.length ? ` (showing ${shown.length})` : ''}`;
  }

  /** Import a batch file saved by the Buck ID page that runs inside Claude. */
  async function importBatch(file) {
    const fallbackCam = $('#up-camera').value;
    if (!S.cameras.length) { toast('Add your cameras on the Map tab first.'); return; }
    const camByName = (n) => n && S.cameras.find((c) => c.name.trim().toLowerCase() === String(n).trim().toLowerCase());
    const perCam = {};
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('That file could not be read.'); return; }
    if (!data || data.app !== 'deer-whisperer-batch' || !Array.isArray(data.photos)) { toast('This is not a Buck ID batch file.', 4000); return; }
    const prog = $('#up-progress');
    const byName = (n) => S.bucks.find((b) => b.name.toLowerCase() === String(n).toLowerCase());
    let added = 0, skipped = 0, newBucks = 0;
    for (const bp of data.photos) {
      prog.textContent = `Importing ${added + skipped + 1} of ${data.photos.length}…`;
      const cam = camByName(bp.cameraName), camId = cam ? cam.id : fallbackCam;
      if (S.photos.some((x) => x.fileName === bp.fileName && x.takenAt === bp.takenAt)) { skipped++; continue; }
      const blob = await Store.dataURLToBlob(bp.image);
      const p = { id: Store.uid(), cameraId: camId, takenAt: bp.takenAt, exifTrusted: !!bp.exifTrusted, kind: bp.kind || '', buckId: '', travel: bp.travel || '',
        blob, thumb: await makeThumb(blob), fileName: bp.fileName, added: Date.now(), needsCheck: !bp.confirmed, ai: bp.ai ? { at: Date.now(), result: bp.ai, via: 'buck-id' } : undefined };
      if (bp.kind === 'buck' && bp.buckName) {
        let b = byName(bp.buckName);
        if (!b) {
          const info = (data.bucks || []).find((x) => x.name === bp.buckName) || {};
          b = { id: Store.uid(), name: bp.buckName, points: info.points || '', description: info.description || '', refPhotoId: p.id, created: Date.now() };
          await Store.put('bucks', b); S.bucks.push(b); newBucks++;
        }
        p.buckId = b.id;
      }
      await Store.put('photos', p); S.photos.push(p); added++; perCam[camId] = (perCam[camId] || 0) + 1;
    }
    S.photos.sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0));
    prog.textContent = `Imported ${added} photo${added === 1 ? '' : 's'}${added ? ': ' + Object.entries(perCam).map(([id, n]) => `${n} to ${camName(id)}`).join(', ') : ''}` + (newBucks ? `, added ${newBucks} new buck${newBucks > 1 ? 's' : ''}` : '') + (skipped ? ` (${skipped} already here, skipped)` : '') + '.';
    renderPhotos(); dataChanged(true);
  }

  /** Save the buck roster (names, notes, one reference photo each) for the Buck ID page. */
  function exportRoster() {
    if (!S.bucks.length && !S.cameras.length) { toast('Add some cameras or bucks first.'); return; }
    const bucks = S.bucks.map((b) => {
      const ref = S.photos.find((p) => p.id === b.refPhotoId) || S.photos.find((p) => p.buckId === b.id);
      return { name: b.name, points: b.points || '', description: b.description || '', refThumb: ref ? ref.thumb : '' };
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'deer-whisperer-roster', version: 1, bucks, cameras: S.cameras.map((c) => ({ name: c.name })) })], { type: 'application/json' }));
    a.download = 'deer-whisperer-roster.json'; a.click();
    toast('Saved. In Buck ID, tap “Import bucks & cameras from app”.', 4000);
  }

  // ---------- bucks ----------
  function renderBucks() {
    const box = $('#buck-list'); box.innerHTML = '';
    if (!S.bucks.length) { box.innerHTML = '<div class="empty">No bucks named yet. Tag a buck on a photo (or use AI ID) and choose “＋ New buck”.</div>'; return; }
    const sts = sightings(), cps = condPatterns(sts);
    for (const b of S.bucks) {
      const pat = Engine.buckPattern(b, sts), cp = cps.bucks[b.id];
      const ref = S.photos.find((p) => p.id === b.refPhotoId) || S.photos.find((p) => p.buckId === b.id);
      const mine = S.photos.filter((p) => p.buckId === b.id);
      const el = document.createElement('div'); el.className = 'buck';
      el.innerHTML = `${ref ? `<img alt="" src="${ref.thumb}">` : ''}
        <div class="body">
          <input class="name" value="${esc(b.name)}" aria-label="Buck name">
          <label>Points / age class<input data-f="points" value="${esc(b.points)}" placeholder="e.g. 10pt, 4.5 yrs"></label>
          <label>Identifying features<textarea data-f="desc" placeholder="Kicker off left G2, split brow…">${esc(b.description)}</textarea></label>
          <div class="small">${esc(pat.summary)}</div>
          ${patternHTML(cp, "he's")}
          ${mine.length > 1 ? `<label>Reference photo (used by AI)<select data-f="ref">${mine.map((p) => `<option value="${p.id}" ${p.id === (ref && ref.id) ? 'selected' : ''}>${fmtDT(p.takenAt)} · ${esc(camName(p.cameraId))}</option>`).join('')}</select></label>` : ''}
          <div class="row"><button data-a="plan">Plan a hunt for ${esc(b.name)}</button><button class="ghost" data-a="del">Delete</button></div>
        </div>`;
      const save = () => Store.put('bucks', b);
      el.querySelector('.name').onchange = (e) => { b.name = e.target.value.trim() || b.name; save(); };
      el.querySelector('[data-f=points]').onchange = (e) => { b.points = e.target.value; save(); };
      el.querySelector('[data-f=desc]').onchange = (e) => { b.description = e.target.value; save(); };
      const r = el.querySelector('[data-f=ref]'); if (r) r.onchange = (e) => { b.refPhotoId = e.target.value; save(); renderBucks(); };
      el.querySelector('[data-a=plan]').onclick = () => { S.target = b.id; showTab('plan'); };
      el.querySelector('[data-a=del]').onclick = async () => {
        if (!confirm(`Delete ${b.name}? Photos stay, untagged.`)) return;
        await Store.del('bucks', b.id); S.bucks = S.bucks.filter((x) => x !== b);
        for (const p of S.photos.filter((p) => p.buckId === b.id)) { p.buckId = ''; await Store.put('photos', p); }
        renderBucks();
      };
      box.appendChild(el);
    }
  }

  // ---------- plan ----------
  const scClass = (s) => (s == null ? 'sc0' : s < 35 ? 'sc1' : s < 55 ? 'sc2' : s < 72 ? 'sc3' : 'sc4');
  function reasonList(r) { return `<ul class="reasons">${r.reasons.map((x) => `<li class="${x.v > 0 ? 'p' : x.v < 0 ? 'n' : ''}">${esc(x.t)}</li>`).join('')}</ul>`; }
  function sitTitle(r) { return `${fmtDate(r.day)} ${r.which === 'AM' ? 'morning ☀' : 'evening ☾'} · ${esc(r.stand.name)}`; }
  function sitDetail(r) {
    const wx = r.wx ? `${Math.round(r.wx.temp)}°F · ${Geo.compass(r.wx.windDir)} ${Math.round(r.wx.wind)} mph (gust ${Math.round(r.wx.gust)}) · ${r.wx.pressure ? r.wx.pressure.toFixed(2) + ' inHg' : ''} · ${r.wx.precip > 0.01 ? r.wx.precip.toFixed(2) + '" rain' : 'dry'}` : 'No forecast';
    return `<div class="head"><span>${sitTitle(r)}</span><span class="score">${r.score}</span></div>
      <div class="small muted">${Engine.fmtTime(r.start)}–${Engine.fmtTime(r.end)} · ${wx} · ${Astro.phaseEmoji(r.moon.phase)} ${Math.round(r.moon.fraction * 100)}%</div>${buckLine(r)}${reasonList(r)}`;
  }
  const CHANCE = { good: 'Good chance', possible: 'Possible', outside: 'Outside chance' };
  function buckLine(r) {
    if (S.target || !S.bucks.length) return '';
    if (!r.bucks || !r.bucks.length) return '<div class="bucks small muted">No named bucks seen near this stand yet.</div>';
    return `<div class="bucks">${r.bucks.slice(0, 6).map((x) => `<span class="pill chance-${x.level}" title="${esc(x.why)}">🦌 ${esc(x.buck.name)} · ${CHANCE[x.level]}</span>`).join('')}</div>
      <details class="small why"><summary>Why these bucks</summary><ul class="reasons">${r.bucks.slice(0, 6).map((x) => `<li><b>${esc(x.buck.name)}</b>: ${esc(x.why)}</li>`).join('')}</ul></details>`;
  }

  function renderPlan() {
    const tSel = $('#plan-target');
    tSel.innerHTML = '<option value="">Any deer</option>' + S.bucks.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    tSel.value = S.target;
    const c = center();
    const status = $('#plan-status');
    status.textContent = S.weatherErr ? `Weather unavailable: ${S.weatherErr}` : S.weather ? (S.weather.stale ? `Offline — using forecast saved ${fmtDT(S.weather.stale)}` : `Forecast for ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`) : '';

    // today strip
    const today = $('#plan-today');
    if (c) {
      const now = new Date(), sun = Astro.sunTimes(now, c.lat, c.lng), ill = Astro.moonIllumination(now);
      const sol = Astro.solunar(new Date(new Date().setHours(0, 0, 0, 0)), c.lat, c.lng);
      const h = S.weather && S.weather.at(Date.now());
      today.innerHTML = [
        `🌅 ${Engine.fmtTime(sun.sunrise)} – 🌇 ${Engine.fmtTime(sun.sunset)}`,
        `${Astro.phaseEmoji(ill.phase)} ${Astro.phaseName(ill.phase)} (${Math.round(ill.fraction * 100)}%)`,
        sol.majors.length ? `Solunar majors: ${sol.majors.map((m) => Engine.fmtTime(m.center)).join(', ')}` : '',
        h ? `Now: ${Math.round(h.temp)}°F, ${Geo.compass(h.windDir)} ${Math.round(h.wind)} mph` : '',
      ].filter(Boolean).map((t) => `<span class="chip">${t}</span>`).join('');
    } else today.innerHTML = '<div class="empty">Start on the <b>Map</b> tab: drop your cameras and stands. Or load the demo property in Settings to try it out.</div>';

    const sts = sightings();
    const patterns = Object.fromEntries(S.bucks.map((b) => [b.id, Engine.buckPattern(b, sts)]));
    const cond = condPatterns(sts);
    const sits = S.stands.length ? Engine.planSits({ stands: S.stands, sightings: sts, weather: S.weather, settings: S.settings, targetBuckId: S.target || null, patterns, cond, bucks: S.bucks }) : [];

    // best list
    const perStand = {};
    const best = [...sits].sort((a, b) => b.score - a.score).filter((r) => (perStand[r.stand.id] = (perStand[r.stand.id] || 0) + 1) <= 2).slice(0, 5);
    const bl = $('#plan-best');
    bl.innerHTML = best.length ? '' : `<div class="empty">${S.stands.length ? 'No forecast available yet.' : 'Add at least one stand on the Map tab.'}</div>`;
    best.forEach((r) => { const d = document.createElement('div'); d.className = 'best'; d.style.borderLeftColor = r.score >= 72 ? 'var(--good)' : r.score >= 55 ? 'var(--ok)' : 'var(--bad)'; d.innerHTML = sitDetail(r); bl.appendChild(d); });
    if (S.target && patterns[S.target]) bl.insertAdjacentHTML('afterbegin', `<div class="card small"><b>${esc(buckName(S.target))}:</b> ${esc(patterns[S.target].summary)}${patternHTML(cond.bucks[S.target], "he's")}</div>`);

    // matrix
    const days = [...new Set(sits.map((r) => r.day))].sort((a, b) => a - b);
    const mt = $('#plan-matrix');
    if (!days.length) { mt.innerHTML = ''; } else {
      const head = `<tr><th class="stand">Stand</th>${days.map((d) => `<th colspan="2">${new Date(d).toLocaleDateString([], { weekday: 'short' })}<br>${new Date(d).getDate()}</th>`).join('')}</tr>`;
      const rows = S.stands.map((s) => `<tr><th class="stand">${esc(s.name)}</th>${days.map((d) => ['AM', 'PM'].map((w) => {
        const r = sits.find((x) => x.stand === s && x.day === d && x.which === w);
        return `<td class="cell ${scClass(r && r.score)}" data-k="${s.id}|${d}|${w}" title="${w}">${r ? r.score : ''}</td>`;
      }).join('')).join('')}</tr>`).join('');
      mt.innerHTML = head + rows;
      mt.onclick = (e) => {
        const td = e.target.closest('td.cell'); if (!td || !td.dataset.k) return;
        const [id, d, w] = td.dataset.k.split('|');
        const r = sits.find((x) => x.stand.id === id && x.day === Number(d) && x.which === w);
        $$('td.sel', mt).forEach((x) => x.classList.remove('sel')); td.classList.add('sel');
        $('#plan-detail').innerHTML = r ? sitDetail(r) : '';
      };
    }
    $('#plan-detail').innerHTML = '';

    // recommendations
    const rb = $('#plan-recs');
    rb.innerHTML = S.recs.length ? '' : '<div class="empty small">None right now. Suggestions appear for cameras with deer activity and no stand within 150 yds.</div>';
    S.recs.forEach((r) => {
      const d = document.createElement('div'); d.className = 'rec';
      d.innerHTML = `<b>⭐ Near ${esc(r.cam.name)}</b> <span class="pill">${r.sightings} sightings${r.bucks ? ` · ${r.bucks} buck${r.bucks > 1 ? 's' : ''}` : ''}</span><p class="small">${esc(r.text)}</p><div class="row"><button class="tiny" data-a="show">Show on map</button><button class="tiny ghost" data-a="add">Add as stand</button></div>`;
      d.querySelector('[data-a=show]').onclick = () => { showTab('map'); map.setView([r.lat, r.lng], 18); };
      d.querySelector('[data-a=add]').onclick = () => addStandAt(r.lat, r.lng, `Stand near ${r.cam.name}`);
      rb.appendChild(d);
    });
  }

  // ---------- refresh ----------
  let refreshTimer;
  async function dataChanged(light) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (!light && !S.weather) await ensureWeather();
      S.recs = S.cameras.length ? Engine.recommendStands({ cameras: S.cameras, stands: S.stands, sightings: sightings(), weather: S.weather, settings: S.settings }) : [];
      renderMarkers();
      if ($('#tab-plan').classList.contains('active')) renderPlan();
      if ($('#tab-bucks').classList.contains('active')) renderBucks();
    }, 60);
  }

  // ---------- settings ----------
  function renderSettings() {
    const [m, d] = S.settings.rutPeak.split('-');
    $('#set-rut').value = `${new Date().getFullYear()}-${m}-${d}`;
    $('#set-shot').value = String(S.settings.shotYd);
    $('#set-radius').value = String(S.settings.radiusYd);
    $('#set-key').value = S.apiKey; $('#set-model').value = S.model;
    $('#up-ai').checked = !!S.apiKey;
  }
  function bindSettings() {
    $('#set-rut').onchange = async (e) => { if (!e.target.value) return; S.settings.rutPeak = e.target.value.slice(5); await Store.setSetting('rutPeak', S.settings.rutPeak); dataChanged(true); };
    $('#set-shot').onchange = async (e) => { S.settings.shotYd = Number(e.target.value); await Store.setSetting('shotYd', S.settings.shotYd); dataChanged(true); };
    $('#set-radius').onchange = async (e) => { S.settings.radiusYd = Number(e.target.value); await Store.setSetting('radiusYd', S.settings.radiusYd); dataChanged(true); };
    $('#set-key').onchange = (e) => { S.apiKey = e.target.value.trim(); try { localStorage.setItem('dw.apiKey', S.apiKey); } catch { /* ignore */ } $('#up-ai').checked = !!S.apiKey; toast(S.apiKey ? 'API key saved on this device' : 'API key removed'); };
    $('#set-model').onchange = (e) => { S.model = e.target.value.trim() || AI.DEFAULT_MODEL; try { localStorage.setItem('dw.model', S.model); } catch { /* ignore */ } };
    $('#export').onclick = async () => {
      const data = await Store.exportAll();
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      a.download = `deer-whisperer-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    };
    $('#import').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (!confirm('Replace everything on this device with this backup?')) return;
      try { await Store.importAll(JSON.parse(await f.text())); await boot(true); toast('Backup restored'); } catch (err) { toast('Import failed: ' + err.message, 5000); }
    };
    $('#wipe').onclick = async () => {
      if (!confirm('Erase all cameras, stands, bucks and photos on this device?')) return;
      for (const s of ['cameras', 'stands', 'bucks', 'photos', 'settings']) await Store.clear(s);
      await boot(true); toast('All data erased');
    };
    $('#demo').onclick = async () => {
      if ((S.cameras.length || S.photos.length) && !confirm('Add the demo property alongside your data? (You can erase it later.)')) return;
      await Demo.load(); await boot(true); showTab('plan'); toast('Demo property loaded');
    };
  }

  // ---------- boot ----------
  async function boot(reload) {
    await loadAll();
    if (reload && map) { const c = center(); if (c) map.setView([c.lat, c.lng], 16); }
    renderSettings();
    await ensureWeather();
    S.recs = S.cameras.length ? Engine.recommendStands({ cameras: S.cameras, stands: S.stands, sightings: sightings(), weather: S.weather, settings: S.settings }) : [];
    renderMarkers(); renderPlan(); renderPhotos(); renderBucks();
  }

  function bind() {
    $$('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
    $('#add-camera').onclick = () => { placing = 'camera'; $('#map-hint').textContent = 'Tap the map where the camera is.'; };
    $('#add-stand').onclick = () => { placing = 'stand'; $('#map-hint').textContent = 'Tap the map where the stand is.'; };
    $('#locate-me').onclick = () => {
      if (!navigator.geolocation) return toast('Location not available');
      navigator.geolocation.getCurrentPosition((pos) => {
        map.setView([pos.coords.latitude, pos.coords.longitude], 17);
        S.settings.center = { lat: pos.coords.latitude, lng: pos.coords.longitude }; Store.setSetting('center', S.settings.center);
      }, () => toast('Could not get your location'));
    };
    $('#up-files').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) handleUpload(fs); };
    $('#ph-move-go').onclick = async () => {
      const to = $('#ph-move').value, list = S.shownPhotos || [];
      if (!to || !list.length) return;
      if (!confirm(`Move ${list.length} photo${list.length > 1 ? 's' : ''} to ${camName(to)}?`)) return;
      for (const p of list) { p.cameraId = to; await Store.put('photos', p); }
      toast(`Moved ${list.length} photo${list.length > 1 ? 's' : ''} to ${camName(to)}`); renderPhotos(); dataChanged(true);
    };
    $('#ph-filter-cam').onchange = renderPhotos; $('#ph-filter-kind').onchange = renderPhotos;
    $('#plan-target').onchange = (e) => { S.target = e.target.value; renderPlan(); };
    $('#plan-refresh').onclick = async () => { $('#plan-status').textContent = 'Loading weather…'; await ensureWeather(true); dataChanged(true); };
    $('#up-batch').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importBatch(f); };
    $('#export-roster').onclick = exportRoster;
    $('#add-buck').onclick = async () => {
      const name = prompt('Buck name'); if (!name) return;
      const b = { id: Store.uid(), name, points: '', description: '', refPhotoId: '', created: Date.now() };
      await Store.put('bucks', b); S.bucks.push(b); renderBucks();
    };
    bindSettings();
  }

  window.addEventListener('DOMContentLoaded', async () => {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
    bind();
    await boot();
    let tab = 'plan'; try { tab = localStorage.getItem('dw.tab') || 'plan'; } catch { /* ignore */ }
    showTab(tab);
  });
})();
