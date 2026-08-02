# HungryMap — MVP

A map-based tool: give it your location, it shows genuinely good, open-now
restaurants nearby, ranked by a weighted score (not just raw star rating) so
a place with 3 five-star reviews doesn't outrank one with 4.6★ and 3,000
reviews.

## What's in here

- `index.html` / `style.css` / `app.js` — the frontend. Plain JS, no framework.
- `netlify/functions/search-restaurants.js` — the backend. Runs server-side
  on Netlify, holds your secret Google API key, calls the Places API, ranks
  results, returns JSON. This is the ONLY place your paid API key lives.
- `netlify.toml` — tells Netlify where the functions live.

## 1. Get your Google API keys

Go to console.cloud.google.com → create a project → APIs & Services →
enable **"Places API (New)"** and **"Maps JavaScript API"** → Credentials →
Create Credentials → API Key. You need **two separate keys**:

**Key A — server-side (secret)**
- Used only inside `search-restaurants.js`.
- Under "API restrictions," restrict it to just "Places API (New)."
- Do NOT restrict by HTTP referrer (it's not called from a browser).
- Never commit this key to your repo — it goes in Netlify's environment
  variables (step 3).

**Key B — client-side (public, but locked down)**
- Used in `index.html`'s Google Maps script tag.
- Under "Application restrictions," choose "Websites" and add your domain
  (e.g. `yourdomain.com/*`, plus `localhost` while testing).
- Under "API restrictions," restrict it to "Maps JavaScript API" only.
- This one is safe to expose in the browser because it's locked to your
  domain — nobody else can use it even if they see it in your page source.
- Paste it into `index.html`, replacing `YOUR_CLIENT_SIDE_KEY`.

## 2. Push this to GitHub

```
cd hungrymap
git init
git add .
git commit -m "Initial MVP"
```
Create a new repo on GitHub and push to it.

## 3. Deploy on Netlify

1. netlify.com → "Add new site" → "Import an existing project" → connect
   your GitHub repo.
2. Build settings: leave "Build command" empty, "Publish directory" as `.`
   (netlify.toml already specifies this).
3. Before or after the first deploy, go to **Site settings → Environment
   variables** and add:
   - `GOOGLE_PLACES_API_KEY` = your server-side key from step 1.
4. Redeploy if needed (Netlify → Deploys → Trigger deploy).

## 4. Test it

Visit your `*.netlify.app` URL, allow location access, and you should see a
ranked list of nearby restaurants with markers on the map.

## 5. Custom domain + AdSense

- Buy a domain (Namecheap, etc.), add it under Netlify → Domain settings,
  follow their DNS instructions.
- Add your `/*` domain to Key B's referrer restriction (step 1).
- `privacy.html` and the commented-out AdSense loader/ad unit in
  `index.html` are already scaffolded — once the site's live on the real
  domain, apply for Google AdSense and uncomment those blocks with your
  approved publisher/ad-slot IDs (see the inline TODOs).

## Known limitations to fix next (not needed for MVP)

- Ranking currently compares each place only against the *other results in
  the same search*, not a true citywide average — good enough to start,
  worth refining later.
- No real caching layer yet (the `Cache-Control` header helps at the CDN
  edge, but a proper cache — Netlify Blobs or similar — would cut Places
  API costs further as traffic grows).
- Yelp/Michelin/press data are intentionally not included yet — see the
  earlier discussion on why those need separate, mostly manual handling.
