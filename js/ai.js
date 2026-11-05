/*
 * Optional AI buck identification with Claude (vision). Uses YOUR Anthropic API key, stored only in
 * this browser. Without a key, everything still works — you just tag bucks by hand.
 *
 * The photo plus reference shots of your already-named bucks are sent to Claude, which returns
 * structured JSON: which buck (if any) it matches, antler description, travel direction in the frame,
 * and the date/time/temperature printed on the trail-cam overlay.
 */
(function () {
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
  const DEFAULT_MODEL = 'claude-opus-5-5';
  let sdkPromise;
  const loadSdk = () => (sdkPromise = sdkPromise || import(SDK_URL).then((m) => m.default || m.Anthropic));

  /** Downscale an image blob to a JPEG base64 string (keeps requests small and cheap). */
  async function toBase64Jpeg(blob, maxSide) {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }

  const SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['deer_present', 'animals', 'overlay_datetime', 'overlay_temperature_f', 'notes'],
    properties: {
      deer_present: { type: 'boolean' },
      animals: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['kind', 'match_buck_id', 'match_confidence', 'est_points', 'antler_description', 'distinguishing_features', 'suggested_name', 'movement_in_frame'],
          properties: {
            kind: { type: 'string', enum: ['buck', 'doe', 'fawn', 'unknown_deer', 'other_animal'] },
            match_buck_id: { type: 'string', description: 'id of the matching known buck, or "none"' },
            match_confidence: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
            est_points: { type: 'integer', description: 'estimated total antler points, 0 if not a buck or not visible' },
            antler_description: { type: 'string' },
            distinguishing_features: { type: 'string' },
            suggested_name: { type: 'string', description: 'for a new buck, a distinctive 1-3 word hunting-camp name drawn from his rack, body or habits; else ""' },
            movement_in_frame: { type: 'string', enum: ['L2R', 'R2L', 'toward', 'away', 'stationary', 'unknown'] },
          },
        },
      },
      overlay_datetime: { type: 'string', description: 'date/time printed on the image as ISO 8601 local time (YYYY-MM-DDTHH:MM), or "" if none' },
      overlay_temperature_f: { type: 'number', description: 'temperature printed on the image in °F, or -999 if none' },
      notes: { type: 'string' },
    },
  };

  const SYSTEM = `You are an expert whitetail deer biologist helping a hunter catalogue trail-camera photos.
For each photo, identify every deer. For bucks, compare carefully against the reference bucks provided
(antler frame shape, tine count and length, brow tines, spread, kickers/stickers, drop tines, body size, scars, ear notches).
Only report a match when the antler/body evidence actually supports it; otherwise use match_buck_id "none" and propose a suggested_name.
Antlers drop in winter and regrow each year, so between seasons rely on body features and say so in notes.
movement_in_frame is the direction the deer is walking as seen in the image (L2R = walking from the left side of the image toward the right).
Read the camera's info strip for date/time and temperature if present.
Naming new bucks: give a distinctive, memorable name of one to three words that comes from what sets THIS buck apart — his rack (shape, mass, a sticker, drop tine, split brow, kicker, lopsided side), body (color, scars, ear notch, giant neck) or habits (night-only, the terrain he uses).
Style examples: Crowbar (heavy beams), Pitchfork (tall straight tines), Switchblade (one long sticker), Chandelier (drop tines), Notch (torn ear), Moonshiner (nocturnal), Gunsmoke, Copperhead, Tripwire, Ironside.
Never use generic or overused names (Big Ten, Big Eight, Mr. Big, Tank, Stud, Old Mossy, Kicker, Wide Eight, Brutus, Bullwinkle, Bambi, Monster, a bare number) or any name already in the roster.`;

  async function identify({ apiKey, model, photoBlob, knownBucks }) {
    if (!apiKey) throw new Error('Add your Anthropic API key in Settings to use AI identification.');
    const Anthropic = await loadSdk();
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const content = [];
    const refs = knownBucks.filter((b) => b.refBlob).slice(0, 8);
    for (const b of refs) {
      content.push({ type: 'text', text: `Reference buck id="${b.id}" name="${b.name}". Notes: ${b.description || 'n/a'}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await toBase64Jpeg(b.refBlob, 640) } });
    }
    const noRef = knownBucks.filter((b) => !b.refBlob);
    if (noRef.length) content.push({ type: 'text', text: 'Known bucks without reference photos (match only on description): ' + noRef.map((b) => `id="${b.id}" name="${b.name}" — ${b.description || 'no notes'}`).join('; ') });
    if (!knownBucks.length) content.push({ type: 'text', text: 'No bucks have been catalogued yet.' });
    content.push({ type: 'text', text: 'New trail-camera photo to identify:' });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await toBase64Jpeg(photoBlob, 1400) } });

    const res = await client.beta.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content }],
    });
    if (res.stop_reason === 'refusal') throw new Error('The model declined to analyse this image.');
    if (res.stop_reason === 'max_tokens') throw new Error('The response was cut off; try again.');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  }

  window.AI = { identify, DEFAULT_MODEL };
})();
