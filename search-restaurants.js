// netlify/functions/search-restaurants.js
//
// This runs on the server, not in the browser — it's the only place
// GOOGLE_PLACES_API_KEY is ever used, so it never gets exposed.
//
// Frontend calls: /.netlify/functions/search-restaurants?lat=..&lng=..&radius=..&openNow=true&minPrice=1&maxPrice=4

const PLACES_URL = "https://places.googleapis.com/v1/places:searchNearby";

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

    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(requestBody),
    });

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
      }))
      .filter((p) => p.rating >= minRating);

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
