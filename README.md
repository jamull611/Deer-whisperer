# 🦌 Deer Whisperer

A trail-camera buck tracker and stand planner that runs in your browser. Log your cameras and stands on a
satellite map, drop in trail-cam photos, name your bucks, and it tells you **which stand to hunt, and when**,
based on wind, weather, moon and where your deer are moving.

No server, no account, no build step. Your data stays on your device.

## What it does

| | |
|---|---|
| **Map** | Satellite/topo map. Place cameras (with the direction the lens faces) and stands. Drag to move. |
| **Photos** | Batch-upload photos per camera. The date/time is read from EXIF. Tag each one buck/doe/fawn, which buck, and which way it's walking in the frame. |
| **Direction of travel** | Camera facing + "left → right / toward / away" in the photo = a compass heading (e.g. camera faces E, deer walks left→right → heading **S**). |
| **Bucks** | A card for each named buck with a pattern summary: cameras, timing (AM/midday/PM/night), travel direction, and the winds he has shown up on in daylight. |
| **Plan** | Scores every morning and evening sit, at every stand, for the next ~16 days (0–100), with the reasons. Pick a buck to plan just for him. |
| **Suggested stands** | For cameras with deer activity and no stand within 150 yds, it suggests a spot at your shooting distance, downwind of the travel route, and lists the winds it works on. |
| **AI ID (optional)** | With your own Anthropic API key, Claude looks at each photo, matches bucks against your reference photos, estimates points, reads the date/temperature strip, and guesses travel direction. You confirm or correct it. |

## Buck ID inside Claude (no API credits)

`artifact/buck-id.html` is a companion page published as a Claude artifact. It runs AI identification on your **Claude plan** instead of API credits:

1. Open the Buck ID page in the Claude app or on claude.ai. Add the photos from one camera, then tap **Identify all**.
2. Check each result and add new bucks to the roster. The roster is saved with the page in your Claude account.
3. Tap **Save batch file**. In this app go to Photos, pick the camera, then tap **Import from Buck ID**.

To send bucks you've already named in the app, use Bucks → **Send roster to Buck ID**, then **Import roster from app** on the Buck ID page.

## How a sit is scored

The model is rule-based so you can see *why* it says what it says:

- **Activity:** sightings at cameras within the influence radius of the stand (default 500 yds). Recent ones count more (21-day half-life), bucks more than does, and sightings at the same time of day (morning vs evening) count most.
- **Wind:** the app works out where the deer are and which way they come from (camera location plus the direction they came from). If the forecast wind puts your scent cone (±50°) over them, the sit is capped low. If you already know a stand's good winds, tick them on the stand and they override the calculation.
- **Wind speed:** 2–14 mph is best. Calm air swirls, and 20+ mph shuts movement down.
- **Weather:** a cold snap compared with the past 3 days, rising pressure after a front, or falling pressure ahead of one all raise the score. Heavy rain lowers it.
- **Moon:** solunar major periods (moon overhead or underfoot) and minor periods (moonrise or moonset) during the sit. Dark moons favor dawn and dusk. Full moons favor more night feeding.
- **Rut:** a boost around the rut peak date you set in Settings.
- **Target buck:** an extra boost if the forecast wind matches winds he has already shown up on in daylight.

- **Learned weather patterns:** every photo stores the conditions at that hour (wind, temperature change against the 3-day average, 12-hour pressure trend, rain, wind speed, moon). Each buck's and each stand's daylight visits are compared with how often those conditions occurred across all daylight hours. A condition only counts when an exact binomial test (corrected for the ~17 conditions tested) says it is far more, or less, common than chance would explain. Under 5 daylight visits: nothing is used. 5–11 visits: only very strong signals. 12+ visits: fuller analysis, including the best two-condition combination. All photos of a deer from one morning, midday or evening count as one visit. In testing on random data this flags a false pattern in roughly 1–5% of cases.

Weather comes from [Open-Meteo](https://open-meteo.com) (free, no key): a 16-day forecast plus 92 days of history, and the archive API for photos older than that (up to 2 years).

## Run it

Any static file host works. The easiest options:

- **GitHub Pages:** in the repo, go to Settings → Pages → Deploy from branch, and pick the branch and `/ (root)`. Then open the URL on your phone and "Add to Home Screen".
- **Locally:** `python3 -m http.server` in this folder, then open http://localhost:8000.

Try **Settings → Load demo property** to see it working with made-up data before you add your own.

## Data and privacy

Everything (photos included) is stored in your browser's IndexedDB. Use **Settings → Export backup** to save a
JSON file or move your data to another device. The only things that leave your device are:
- the map location sent to Open-Meteo for the forecast, and map tile requests;
- photos sent to Anthropic, and only if you enter an API key and use AI ID.

## Project layout

```
index.html        UI shell
css/styles.css
js/geo.js         distances, bearings, travel-heading math
js/astro.js       sunrise/sunset, moon phase, solunar periods
js/weather.js     Open-Meteo client (cached, works offline with the last forecast)
js/engine.js      buck patterns, sit scoring, stand recommendations
js/patterns.js    learned weather patterns (baseline, binomial tests, sit matching)
js/ai.js          optional Claude vision buck ID
js/store.js       IndexedDB storage + backup/restore
js/demo.js        demo property generator
sw.js             service worker (installable app, opens offline)
js/app.js         UI wiring
vendor/           Leaflet 1.9.4, exifr 7.1.3 (bundled so the app loads with poor signal)
```

## Ideas for later

- Auto-sync between phone and computer (a small backend or a cloud drive)
- Cellular trail-cam integrations (Tactacam, Spypoint, etc.) to pull photos automatically
- Bedding and food-source markers, plus terrain (thermals, funnels) in the wind model
- Learn each stand's real success rate from your hunt logs
