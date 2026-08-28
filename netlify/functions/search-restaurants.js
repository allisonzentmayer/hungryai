// netlify/functions/search-restaurants.js
//
// This runs on the server, not in the browser — it's the only place
// SUPABASE_ANON_KEY (and, only behind the escape hatch below,
// GOOGLE_PLACES_API_KEY) is ever used, so they never get exposed.
//
// Frontend calls: /.netlify/functions/search-restaurants?lat=..&lng=..&radius=..
//
// The request path is deliberately just ONE Supabase read (plus a cache
// layer). Everything that used to hit Google live on every search — a
// Nearby Search plus up to a dozen Place Details round trips, all uncached,
// times five when the radius-widen fallback fired — now happens OFFLINE, in
// the hungrydb repo's `enrich_restaurants.py` (scheduled a few times a
// day), which writes rating / review count / price / opening hours /
// business status straight onto the `restaurants` rows. Here we just read
// those columns and compute "open now" locally from the stored hours.
//
// SHOW_UNCURATED_GOOGLE_RESULTS still brings back the old "everything
// nearby, boosted if press-mentioned" behavior — but now it's the ONLY
// thing that makes a live Google call, and it's off by default.

const SHOW_UNCURATED_GOOGLE_RESULTS = false;

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchNearby";
const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.currentOpeningHours.openNow",
  "places.primaryTypeDisplayName",
  "places.googleMapsUri",
  "places.businessStatus",
].join(",");

// Radius tiers (meters) the server walks outward through when the requested
// radius comes up empty — press-mentioned spots are sparse enough that the
// default radius often finds nothing outside a covered metro. This used to
// be done by the browser firing ~5 separate function invocations in
// parallel (5 cold starts, 5x the work); now it's one invocation looping
// over cached reads. Google's own cap is 50km.
const WIDEN_TIERS_METERS = [4828, 16093, 50000];

// Cap the payload so a 50km search in a dense, well-covered metro doesn't
// return hundreds of rows.
const MAX_RESULTS = 60;

// --- caching --------------------------------------------------------------
// L1: module scope — survives across warm invocations of the same container
// (the keep-warm scheduled function keeps one alive), costs nothing.
// L2: Netlify Blobs — shared across containers, survives cold starts. Loaded
// lazily and defensively: if the package/runtime isn't available the whole
// thing just degrades to L1 + a live Supabase read, no hard failure.
const CACHE_TTL_MS = 30 * 60 * 1000;
const memCache = new Map(); // key -> { rows, expires }

// @netlify/blobs is ESM-only, so it's pulled in via a dynamic import (works
// from this CommonJS function) the first time the cache is touched, and
// memoized. If the package or the Blobs runtime isn't available the whole
// L2 layer just no-ops — L1 memory cache + a live Supabase read still work.
let getStorePromise;
function loadGetStore() {
  if (getStorePromise === undefined) {
    getStorePromise = import("@netlify/blobs")
      .then((mod) => mod.getStore)
      .catch(() => null);
  }
  return getStorePromise;
}

async function blobStore() {
  const getStore = await loadGetStore();
  if (!getStore) return null;
  try {
    return getStore("search-cache");
  } catch (_err) {
    return null;
  }
}

// Snap coordinates to a ~110m grid so nearby searches share a cache entry.
function snap(n) {
  return Math.round(n * 1000) / 1000;
}

function cacheKey(lat, lng, radiusMeters) {
  return `press:${snap(lat)}:${snap(lng)}:${radiusMeters}`;
}

async function readCache(key) {
  const hit = memCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.rows;

  const store = await blobStore();
  if (store) {
    try {
      const blob = await store.get(key, { type: "json" });
      if (blob && blob.expires > Date.now()) {
        memCache.set(key, blob);
        return blob.rows;
      }
    } catch (_err) {
      // Blobs unavailable / transient error — fall through to a live read.
    }
  }
  return null;
}

async function writeCache(key, rows) {
  const entry = { rows, expires: Date.now() + CACHE_TTL_MS };
  memCache.set(key, entry);
  const store = await blobStore();
  if (store) {
    try {
      await store.setJSON(key, entry);
    } catch (_err) {
      // Best effort — a missed cache write just means the next request
      // does the Supabase read again.
    }
  }
}

// --- ranking helpers -----------------------------------------------------
function weightedScore(rating, reviewCount, neighborhoodAvg, minReviews = 30) {
  if (!rating || !reviewCount) return 0;
  const v = reviewCount;
  const m = minReviews;
  return (v / (v + m)) * rating + (m / (v + m)) * neighborhoodAvg;
}

function pressBoost(mentionCount) {
  return Math.min(mentionCount, 3) * 0.15;
}

function isOperational(status) {
  return !status || status === "OPERATIONAL";
}

const MAX_PRESS_TAGS = 3;
function pressTags(mentions) {
  const seen = new Set();
  const tags = [];
  for (const m of mentions) {
    for (const tag of m.tags || []) {
      const key = tag.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag.trim());
      if (tags.length >= MAX_PRESS_TAGS) return tags;
    }
  }
  return tags;
}

const MAX_TOP_DISHES = 3;
function topDishes(dishes) {
  return [...(dishes || [])]
    .sort((a, b) => b.mention_count - a.mention_count)
    .slice(0, MAX_TOP_DISHES)
    .map((d) => ({ name: d.name, count: d.mention_count }));
}

// --- "open now" from stored regular hours -------------------------------
// Google's regularOpeningHours.periods are in the place's LOCAL time, with
// day 0 = Sunday. We store utcOffsetMinutes alongside them (from Place
// Details) so we can reconstruct the place's local clock here without a
// timezone database. Returns true / false / null (null = no hours on file,
// e.g. a curated spot the enrichment job hasn't reached yet — the frontend
// treats null as "show it," only hiding places that are definitively
// closed).
function isOpenNow(hours, utcOffsetMinutes) {
  if (!hours || !Array.isArray(hours.periods) || hours.periods.length === 0) return null;
  if (utcOffsetMinutes === null || utcOffsetMinutes === undefined) return null;

  const local = new Date(Date.now() + utcOffsetMinutes * 60000);
  const nowMark = local.getUTCDay() * 1440 + local.getUTCHours() * 60 + local.getUTCMinutes();
  const WEEK = 7 * 1440;

  for (const p of hours.periods) {
    if (!p.open) continue;
    const openMark = p.open.day * 1440 + (p.open.hour || 0) * 60 + (p.open.minute || 0);
    if (!p.close) return true; // open with no close = 24 hours

    let closeMark = p.close.day * 1440 + (p.close.hour || 0) * 60 + (p.close.minute || 0);
    if (closeMark <= openMark) closeMark += WEEK; // overnight / wraps past Saturday

    let mark = nowMark;
    if (mark < openMark) mark += WEEK; // handle now being "before" an overnight open
    if (mark >= openMark && mark < closeMark) return true;
  }
  return false;
}

// --- Supabase: press-mentioned restaurants in a rough bounding box ------
// Rough lat/lng box, not true geo-radius — fine at this scale. Best effort:
// missing config or a Supabase blip returns [] rather than erroring out.
const ENRICHED_SELECT =
  "place_id,name,address,lat,lng,business_status,rating,review_count,price_level," +
  "primary_type,google_maps_uri,regular_opening_hours,utc_offset_minutes," +
  "mentions(source_name,source_url,reason,tags),dishes(name,mention_count)";
const LEGACY_SELECT =
  "place_id,name,lat,lng,business_status," +
  "mentions(source_name,source_url,reason,tags),dishes(name,mention_count)";

async function fetchPressRestaurants(lat, lng, radiusMeters) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return [];

  const latDelta = radiusMeters / 111320;
  const lngDelta = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));
  const box =
    `&lat=gte.${lat - latDelta}&lat=lte.${lat + latDelta}` +
    `&lng=gte.${lng - lngDelta}&lng=lte.${lng + lngDelta}` +
    `&business_status=not.eq.CLOSED_PERMANENTLY`;
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

  const run = (select) =>
    fetch(`${supabaseUrl}/rest/v1/restaurants?select=${select}${box}`, { headers });

  let res = await run(ENRICHED_SELECT);
  if (!res.ok) {
    // Most likely the enrichment columns don't exist yet (migration not
    // run). Fall back to the pre-enrichment shape so search still works —
    // openNow/rating just come back null until the migration + job run.
    console.error("Supabase enriched select failed, retrying legacy:", await res.text());
    res = await run(LEGACY_SELECT);
    if (!res.ok) {
      console.error("Supabase legacy select also failed:", await res.text());
      return [];
    }
  }
  try {
    return await res.json();
  } catch (_err) {
    return [];
  }
}

async function getPressRows(lat, lng, radiusMeters) {
  const key = cacheKey(lat, lng, radiusMeters);
  const cached = await readCache(key);
  if (cached) return cached;
  const rows = await fetchPressRestaurants(lat, lng, radiusMeters);
  await writeCache(key, rows);
  return rows;
}

// --- escape hatch: live uncurated Google Nearby Search ------------------
async function fetchGoogleNearby(lat, lng, radius, neighborhoodAvg, seenIds) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];
  const res = await fetch(PLACES_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": SEARCH_FIELD_MASK,
    },
    body: JSON.stringify({
      includedTypes: ["restaurant"],
      maxResultCount: 20,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.places || [])
    .filter(
      (p) =>
        isOperational(p.businessStatus) &&
        p.rating &&
        p.userRatingCount &&
        !seenIds.has(p.id)
    )
    .map((p) => ({
      id: p.id,
      name: p.displayName?.text,
      address: p.formattedAddress,
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      rating: p.rating,
      reviewCount: p.userRatingCount,
      priceLevel: p.priceLevel || null,
      openNow: p.currentOpeningHours?.openNow ?? null,
      cuisine: p.primaryTypeDisplayName?.text || null,
      mapsUrl: p.googleMapsUri,
      score: weightedScore(p.rating, p.userRatingCount, neighborhoodAvg),
      pressMentions: [],
      pressTags: [],
      topDishes: [],
    }));
}

// --- handler -----------------------------------------------------------
exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const lat = parseFloat(params.lat);
  const lng = parseFloat(params.lng);
  const reqRadius = Math.min(parseFloat(params.radius) || 1609, 50000);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return { statusCode: 400, body: JSON.stringify({ error: "lat and lng are required" }) };
  }

  try {
    // Walk outward through the radius tiers until something turns up (or we
    // hit the cap). Each read is cached, so a repeat search anywhere near
    // here — including the keep-warm ping — is essentially free.
    const tiers = [reqRadius, ...WIDEN_TIERS_METERS.filter((r) => r > reqRadius)];
    let rows = [];
    let usedRadius = reqRadius;
    for (const tier of tiers) {
      rows = await getPressRows(lat, lng, tier);
      usedRadius = tier;
      if (rows.length > 0) break;
    }

    // Neighborhood average for the weighted (Bayesian) rating. We only have
    // press-mentioned places here, not a full nearby sample, so fall back to
    // a sane constant when there's too little to average.
    const rated = rows.filter((r) => r.rating && r.review_count);
    const neighborhoodAvg =
      rated.length >= 5
        ? rated.reduce((sum, r) => sum + r.rating, 0) / rated.length
        : 4.2;

    let results = rows
      .filter((r) => isOperational(r.business_status))
      .map((r) => {
        const mentions = r.mentions || [];
        let score = weightedScore(r.rating, r.review_count, neighborhoodAvg);
        score += pressBoost(mentions.length);
        return {
          id: r.place_id,
          name: r.name,
          address: r.address || null,
          lat: r.lat,
          lng: r.lng,
          rating: r.rating ?? null,
          reviewCount: r.review_count ?? null,
          priceLevel: r.price_level || null,
          openNow: isOpenNow(r.regular_opening_hours, r.utc_offset_minutes),
          cuisine: r.primary_type || null,
          mapsUrl:
            r.google_maps_uri ||
            `https://www.google.com/maps/place/?q=place_id:${r.place_id}`,
          score,
          pressMentions: mentions,
          pressTags: pressTags(mentions),
          topDishes: topDishes(r.dishes || []),
        };
      });

    if (!SHOW_UNCURATED_GOOGLE_RESULTS) {
      results = results.filter((r) => r.pressMentions.length > 0);
    } else {
      const seen = new Set(results.map((r) => r.id));
      const extra = await fetchGoogleNearby(lat, lng, usedRadius, neighborhoodAvg, seen);
      results = results.concat(extra);
    }

    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, MAX_RESULTS);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // Short edge cache keyed on the (snapped) query string. openNow is
        // baked into the response and only recomputed each request, so keep
        // this brief — but stale-while-revalidate lets a repeat hit serve
        // instantly while the refresh happens in the background.
        "Cache-Control": "public, max-age=120, stale-while-revalidate=600",
      },
      body: JSON.stringify({ results, radius: usedRadius }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
