// netlify/functions/search-restaurants.js
//
// This runs on the server, not in the browser — it's the only place
// GOOGLE_PLACES_API_KEY / SUPABASE_ANON_KEY are ever used, so they never get
// exposed.
//
// Frontend calls: /.netlify/functions/search-restaurants?lat=..&lng=..&radius=..&openNow=true&minPrice=1&maxPrice=4
//
// Two data sources get combined here:
//   1. Google Places — live "is it open, what's the address" data
//   2. Supabase (hungrydb) — press-mentioned restaurants written by the
//      standalone ingestion pipeline in the hungrydb repo.
//
// Right now only Supabase-sourced (press-mentioned) restaurants are
// returned — Google is used to enrich them with live hours/address/rating,
// not to contribute its own uncurated nearby-search results. See
// SHOW_UNCURATED_GOOGLE_RESULTS below to bring the old merged behavior
// back.

// For now, only press-mentioned (Supabase) restaurants are shown — generic
// Google nearby-search results are fetched (to compute neighborhoodAvg and
// to cheaply enrich press-mentioned places that Google also happens to
// return) but filtered out of the final list below. Flip this back to true
// to restore the old "everything nearby, boosted if press-mentioned"
// behavior; nothing else needs to change.
const SHOW_UNCURATED_GOOGLE_RESULTS = false;

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchNearby";
const PLACES_DETAILS_URL = "https://places.googleapis.com/v1/places";

// Fields we ask Google for. Note: requesting "rating" / "userRatingCount"
// pushes the call into a pricier SKU tier on Google's side — that's expected
// and necessary, since ranking is the whole point of this app.
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
].join(",");

const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "rating",
  "userRatingCount",
  "priceLevel",
  "currentOpeningHours.openNow",
  "primaryTypeDisplayName",
  "googleMapsUri",
].join(",");

// Weighted (Bayesian) rating: pulls low-review-count places toward the
// neighborhood average instead of letting 1 five-star review win.
function weightedScore(rating, reviewCount, neighborhoodAvg, minReviews = 30) {
  if (!rating || !reviewCount) return 0;
  const v = reviewCount;
  const m = minReviews;
  return (v / (v + m)) * rating + (m / (v + m)) * neighborhoodAvg;
}

// Flat bonus per independent press mention, capped so 10 mentions doesn't
// completely swamp actual quality — this is the "repetition = consensus"
// signal, made numeric.
function pressBoost(mentionCount) {
  return Math.min(mentionCount, 3) * 0.15;
}

// Rough distance in meters — good enough for ranking "which missing
// press-mentioned places are closest," not for anything precision-sensitive.
function approxDistanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// Short "known for" pills (signature dish, atmosphere, named accolade, etc.)
// pulled from mentions.tags — capped and deduped here so the frontend can
// render them straight through without risking a card stretched tall by a
// long tag list or near-duplicate phrasing across sources.
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

function placeToResult(p, neighborhoodAvg) {
  return {
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
  };
}

// --- Supabase: fetch press-mentioned restaurants in a rough bounding box ---
// Rough lat/lng box instead of true geo-radius math — good enough at this
// scale, worth upgrading to a real PostGIS radius query once there's enough
// data for it to matter. Best-effort: missing config or a Supabase outage
// shouldn't break search, it just means results fall back to Google-only
// ranking.
async function fetchPressMentions(lat, lng, radiusMeters) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return new Map();

  const latDelta = radiusMeters / 111320;
  const lngDelta = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));

  // Built by hand rather than via URLSearchParams, since PostgREST needs
  // repeated/compound filter keys (e.g. two "lat=" params) that
  // URLSearchParams doesn't handle cleanly.
  const url =
    `${supabaseUrl}/rest/v1/restaurants` +
    `?select=place_id,name,lat,lng,business_status,mentions(source_name,source_url,reason,tags)` +
    `&lat=gte.${lat - latDelta}&lat=lte.${lat + latDelta}` +
    `&lng=gte.${lng - lngDelta}&lng=lte.${lng + lngDelta}` +
    `&business_status=not.eq.CLOSED_PERMANENTLY`;

  try {
    const res = await fetch(url, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });
    if (!res.ok) {
      console.error("Supabase fetch failed:", await res.text());
      return new Map();
    }

    const rows = await res.json();
    const map = new Map();
    for (const row of rows) {
      map.set(row.place_id, {
        name: row.name,
        lat: row.lat,
        lng: row.lng,
        mentions: row.mentions || [],
      });
    }
    return map;
  } catch (_err) {
    return new Map();
  }
}

async function fetchPlaceDetails(placeId, apiKey) {
  const res = await fetch(`${PLACES_DETAILS_URL}/${placeId}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": DETAILS_FIELD_MASK,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const lat = parseFloat(params.lat);
  const lng = parseFloat(params.lng);
  const radius = Math.min(parseFloat(params.radius) || 1500, 50000); // meters, Google's cap is 50km
  const openNow = params.openNow === "true";
  const minRating = parseFloat(params.minRating) || 0;

  if (!lat || !lng) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "lat and lng are required" }),
    };
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server misconfigured: missing API key" }),
    };
  }

  try {
    // --- 1. Live Google Places nearby search + Supabase press mentions,
    // fired in parallel — Supabase doesn't depend on Google's response, and
    // it's best-effort anyway (fetchPressMentions swallows its own errors).
    const requestBody = {
      includedTypes: ["restaurant"],
      maxResultCount: 20,
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lng }, radius },
      },
    };

    const [placesRes, pressMap] = await Promise.all([
      fetch(PLACES_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": SEARCH_FIELD_MASK,
        },
        body: JSON.stringify(requestBody),
      }),
      fetchPressMentions(lat, lng, radius),
    ]);

    if (!placesRes.ok) {
      const errText = await placesRes.text();
      return { statusCode: placesRes.status, body: JSON.stringify({ error: errText }) };
    }

    const placesData = await placesRes.json();
    const places = placesData.places || [];

    const ratedPlaces = places.filter((p) => p.rating);
    const neighborhoodAvg =
      ratedPlaces.reduce((sum, p) => sum + p.rating, 0) / (ratedPlaces.length || 1);

    let results = places
      .filter((p) => p.rating && p.userRatingCount)
      .map((p) => placeToResult(p, neighborhoodAvg));

    // --- 2. Press-mentioned restaurants from hungrydb ------------------
    const seenIds = new Set(results.map((r) => r.id));

    // Boost anything Google already returned that's also press-mentioned
    for (const r of results) {
      if (pressMap.has(r.id)) {
        const info = pressMap.get(r.id);
        r.pressMentions = info.mentions;
        r.pressTags = pressTags(info.mentions);
        r.score += pressBoost(info.mentions.length);
      }
    }

    // Fetch details for press-mentioned places Google's nearby search
    // didn't happen to return, so they don't get lost. Capped and
    // closest-first: a wide-radius search (the "keep widening until
    // something shows up" fallback can go all the way to 50km) could
    // otherwise mean dozens of individual Google Place Details round trips
    // in one request — each one is a real outbound HTTPS call, and that was
    // measurably adding several seconds of real-world latency that a local
    // dev-server test doesn't reproduce.
    const MAX_MISSING_DETAIL_LOOKUPS = 12;
    const missing = [...pressMap.entries()]
      .filter(([id]) => !seenIds.has(id))
      .sort(([, a], [, b]) => approxDistanceMeters({ lat, lng }, a) - approxDistanceMeters({ lat, lng }, b))
      .slice(0, MAX_MISSING_DETAIL_LOOKUPS);
    const detailFetches = await Promise.all(
      missing.map(([id]) => fetchPlaceDetails(id, apiKey))
    );

    detailFetches.forEach((p, i) => {
      if (!p || !p.rating || !p.userRatingCount) return; // skip if no live data available
      const [, info] = missing[i];
      const result = placeToResult(p, neighborhoodAvg);
      result.pressMentions = info.mentions;
      result.pressTags = pressTags(info.mentions);
      result.score += pressBoost(info.mentions.length);
      results.push(result);
    });

    // --- 3. Filter + sort ------------------------------------------------
    if (!SHOW_UNCURATED_GOOGLE_RESULTS) {
      results = results.filter((p) => p.pressMentions.length > 0);
    }
    results = results.filter((p) => p.rating >= minRating);
    if (openNow) {
      results = results.filter((p) => p.openNow === true);
    }
    results.sort((a, b) => b.score - a.score);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // Cache identical requests at the CDN edge for 10 min — cuts down
        // on repeat Places API charges for the same area/filters.
        "Cache-Control": "public, max-age=600",
      },
      body: JSON.stringify({ results }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
