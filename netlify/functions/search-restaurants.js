// netlify/functions/search-restaurants.js
//
// This runs on the server, not in the browser — it's the only place
// GOOGLE_PLACES_API_KEY / YELP_API_KEY are ever used, so they never get exposed.
//
// Frontend calls: /.netlify/functions/search-restaurants?lat=..&lng=..&radius=..&openNow=true&minPrice=1&maxPrice=4

const PLACES_URL = "https://places.googleapis.com/v1/places:searchNearby";
const YELP_URL = "https://api.yelp.com/v3/businesses/search";

// If a place matches a Yelp listing but Yelp's own rating is below this,
// treat it as a red flag (inflated/fake Google reviews) and drop it. Places
// Yelp simply doesn't have a listing for are left alone — Yelp's coverage
// isn't complete, so no match shouldn't be held against a place.
const YELP_MIN_RATING = 3.5;
const YELP_MATCH_RADIUS_METERS = 150;

// Fields we ask Google for. Note: requesting "rating" / "userRatingCount"
// pushes the call into a pricier SKU tier on Google's side — that's expected
// and necessary, since ranking is the whole point of this app.
const FIELD_MASK = [
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

// Weighted (Bayesian) rating: pulls low-review-count places toward the
// neighborhood average instead of letting 1 five-star review win.
function weightedScore(rating, reviewCount, neighborhoodAvg, minReviews = 30) {
  if (!rating || !reviewCount) return 0;
  const v = reviewCount;
  const m = minReviews;
  return (v / (v + m)) * rating + (m / (v + m)) * neighborhoodAvg;
}

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function metersBetween(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// Yelp has no shared id with Google Places, so places are matched by
// proximity + normalized-name overlap. Picks the closest plausible match
// within YELP_MATCH_RADIUS_METERS, or null if nothing lines up.
function matchYelpBusiness(place, yelpBusinesses) {
  const placeName = normalizeName(place.name);
  let best = null;
  let bestDistance = Infinity;

  for (const yb of yelpBusinesses) {
    if (!yb.coordinates?.latitude || !yb.coordinates?.longitude) continue;
    const distance = metersBetween(
      { lat: place.lat, lng: place.lng },
      { lat: yb.coordinates.latitude, lng: yb.coordinates.longitude }
    );
    if (distance > YELP_MATCH_RADIUS_METERS) continue;

    const ybName = normalizeName(yb.name);
    const namesOverlap = ybName === placeName || ybName.includes(placeName) || placeName.includes(ybName);
    if (namesOverlap && distance < bestDistance) {
      best = yb;
      bestDistance = distance;
    }
  }
  return best;
}

// Best-effort — a Yelp outage or missing/invalid key shouldn't break search,
// it just means results fall back to Google-only ranking.
async function fetchYelpBusinesses(lat, lng, radius, apiKey) {
  if (!apiKey) return [];
  try {
    const url = `${YELP_URL}?latitude=${lat}&longitude=${lng}&radius=${Math.min(radius, 40000)}&categories=restaurants&limit=50&sort_by=best_match`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.businesses || [];
  } catch (_err) {
    return [];
  }
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
    const requestBody = {
      includedTypes: ["restaurant"],
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: radius,
        },
      },
    };

    // Fired in parallel — Yelp doesn't depend on Google's response, and it's
    // best-effort anyway (fetchYelpBusinesses swallows its own errors).
    const [res, yelpBusinesses] = await Promise.all([
      fetch(PLACES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(requestBody),
      }),
      fetchYelpBusinesses(lat, lng, radius, process.env.YELP_API_KEY),
    ]);

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: res.status, body: JSON.stringify({ error: errText }) };
    }

    const data = await res.json();
    const places = data.places || [];

    // Neighborhood average rating, used as the "pull toward" baseline
    const ratedPlaces = places.filter((p) => p.rating);
    const neighborhoodAvg =
      ratedPlaces.reduce((sum, p) => sum + p.rating, 0) / (ratedPlaces.length || 1);

    let results = places
      .filter((p) => p.rating && p.userRatingCount)
      .map((p) => {
        const base = {
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
          yelpRating: null,
          yelpReviewCount: null,
        };

        const yelpMatch = yelpBusinesses.length ? matchYelpBusiness(base, yelpBusinesses) : null;
        let score = weightedScore(p.rating, p.userRatingCount, neighborhoodAvg);
        if (yelpMatch) {
          base.yelpRating = yelpMatch.rating;
          base.yelpReviewCount = yelpMatch.review_count;
          // Average with Yelp's own weighted score so one platform's puffed-up
          // ratings can't dominate the ranking on their own.
          const yelpScore = weightedScore(yelpMatch.rating, yelpMatch.review_count, neighborhoodAvg);
          score = (score + yelpScore) / 2;
        }

        return { ...base, score };
      })
      .filter((p) => p.rating >= minRating)
      // A Yelp match with a mediocre Yelp rating is a red flag even if Google
      // looks great; no Yelp listing at all isn't held against a place.
      .filter((p) => p.yelpRating == null || p.yelpRating >= YELP_MIN_RATING);

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
