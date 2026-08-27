// app.js — runs in the browser. No API keys live here except the
// restricted, referrer-locked Maps JavaScript key loaded via <script> tag.

let map;
let markers = [];
let markersById = new Map();
let userLocation = null;
let notableRestaurants = [];
let lastResults = [];
// Zoom level as of the last search — lets the auto-search-on-move listener
// tell "user zoomed, area shown no longer matches what's loaded" apart from
// "map center barely nudged," even when the center itself hasn't moved.
let lastSearchZoom = null;
let autoSearchTimer = null;
// Set around programmatic camera moves (fitBounds, focusing a result) so the
// dragend/zoom_changed listeners below can tell those apart from the user
// actually panning/zooming by hand — only the latter should surface
// "Search this area".
let suppressSearchAreaPrompt = false;
// Flipped true the moment real user interaction (drag/zoom, not one of our
// own programmatic moves) is detected after a search cycle starts. Checked
// by fitMapToResults() right before it would otherwise snap the camera to
// that search's results — without this, a slow-to-resolve search (e.g. the
// widen-radius fallback on page load) could finish after the user has
// already scrolled/zoomed elsewhere and yank the view back to stale
// results, undoing what they just did. Reset at the start of each fresh
// "new location, start searching" entry point (initial locate, map click,
// zip search) — not inside runSearch() itself, since a single search cycle
// (e.g. the widen-radius fallback) can call runSearch() more than once and
// an interruption partway through needs to survive across all of them.
let searchInterruptedByUser = false;

// Wraps a programmatic camera move (fitBounds, panTo, setZoom/setCenter) so
// it doesn't get mistaken for the user dragging/zooming by hand.
// suppressSearchAreaPrompt normally clears itself on the next "idle" event
// once the move settles — but in testing, that "idle" occasionally didn't
// fire promptly after some fitBounds + zoom-cap combinations, which left
// the flag stuck true and silently broke auto-search-on-scroll and zoom
// persistence until some unrelated later map event happened to trigger it.
// The timeout is a backstop for that: whichever fires first, idle or the
// timeout, clears it — safe either way since clearing twice is a no-op.
function withSuppressedInteraction(moveFn) {
  suppressSearchAreaPrompt = true;
  moveFn();
  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    suppressSearchAreaPrompt = false;
  };
  google.maps.event.addListenerOnce(map, "idle", clear);
  setTimeout(clear, 1500);
}

// Curated Michelin/James Beard restaurants (data/notable-restaurants.json).
// Ones that also turn up in the live Places search always show (matched by
// id, regardless of distance); beyond that, only ones already inside the
// current map viewport get added — see the "idle" handler in runSearch —
// so a single far-off Michelin pin can't force the whole map to zoom out.

// A chubby, soft-edged 5-point star (quadratic curves through the inner
// points) — reads as an award/seal rather than a sharp asterisk. Shared by
// the map marker and the list badge so both look identical.
const STAR_PATH =
  "M20,2 Q27.05,10.29 37.12,14.44 Q31.41,23.71 30.58,34.56 Q20,32 9.42,34.56 " +
  "Q8.59,23.71 2.88,14.44 Q12.95,10.29 20,2 Z";

fetch("data/notable-restaurants.json")
  .then((res) => res.json())
  .then((data) => { notableRestaurants = data; })
  .catch(() => { notableRestaurants = []; });

// Remembers the last successful geolocation fix so a refresh that hits a
// transient geolocation failure (denied, timed out, browser having a bad
// day) falls back to "wherever you were" instead of the hardcoded NYC
// default — that hardcoded fallback is why a refresh can suddenly show
// Manhattan to someone who's never been there.
const LAST_LOCATION_KEY = "hungrypig:lastLocation";

function loadCachedLocation() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_LOCATION_KEY));
    if (parsed && typeof parsed.lat === "number" && typeof parsed.lng === "number") {
      return parsed;
    }
  } catch (_err) {
    // Ignore — corrupt/blocked storage just means no cached fallback.
  }
  return null;
}

function cacheLocation(loc) {
  try {
    localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ lat: loc.lat, lng: loc.lng }));
  } catch (_err) {
    // Ignore — private browsing / storage blocked, just skip caching.
  }
}

// Remembers radius/openNow/zoom across a refresh — without this, "Open now"
// resets to checked and the map resets to a computed fit-to-results zoom
// every single load, ignoring whatever the user actually had it set to.
const SETTINGS_KEY = "hungrypig:settings";

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (parsed && typeof parsed === "object") return parsed;
  } catch (_err) {
    // Ignore — corrupt/blocked storage just means defaults apply.
  }
  return {};
}

function saveSettings(patch) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch }));
  } catch (_err) {
    // Ignore — private browsing / storage blocked, just skip saving.
  }
}

// Pig mascot click behavior (the "Oink!" bubble) lives in mascot-oink.js,
// loaded alongside this file — shared with about.html, which doesn't load
// the rest of this map/search-specific script.

// Called by the Google Maps script tag once it loads.
function initMap() {
  // Prefer wherever the user was last time over the hardcoded NYC fallback
  // — avoids a jarring flash-to-Manhattan on every load while geolocation
  // is still resolving (or if it fails).
  const cachedLocation = loadCachedLocation();
  const savedSettings = loadSettings();
  map = new google.maps.Map(document.getElementById("map"), {
    center: cachedLocation || { lat: 40.7128, lng: -74.006 }, // fallback: NYC, replaced once we get real location
    zoom: savedSettings.zoom ?? 15,
    mapTypeControl: false,
    zoomControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });

  // Applied before the first search fires below, so that search (and its
  // fit-to-results zoom) already reflects what the user had last time
  // instead of resetting to "Open now" checked / the default radius.
  if (savedSettings.radius) document.getElementById("radius").value = String(savedSettings.radius);
  if (typeof savedSettings.openNow === "boolean") document.getElementById("openNow").checked = savedSettings.openNow;

  addMapControls();

  document.getElementById("searchBtn").addEventListener("click", runSearch);
  // Already on the map page — re-locate instead of following the link to "/".
  document.getElementById("ctaLocateBtn").addEventListener("click", (e) => {
    e.preventDefault();
    attemptLocate();
  });
  document.getElementById("enableLocationBtn").addEventListener("click", attemptLocate);
  document.getElementById("zipBtn").addEventListener("click", attemptZipSearch);
  document.getElementById("zipInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      attemptZipSearch();
    }
  });
  document.getElementById("clearFiltersBtn").addEventListener("click", clearFilters);
  document.getElementById("chooseForMeBtn").addEventListener("click", chooseForMe);

  // Mobile-only accordion toggle for the search criteria panel (no-op on
  // desktop, where CSS keeps it permanently expanded regardless of this
  // attribute).
  const controlsToggle = document.getElementById("controlsToggle");
  controlsToggle.addEventListener("click", () => {
    const expanded = controlsToggle.getAttribute("aria-expanded") === "true";
    controlsToggle.setAttribute("aria-expanded", String(!expanded));
  });

  // Filters re-run the search live — there's no separate "go" button for
  // them (searchBtn is hidden in favor of the header CTA), so without this
  // changing radius/open-now wouldn't do anything until the next unrelated
  // search trigger.
  ["radius", "openNow"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      saveSettings({
        radius: Number(document.getElementById("radius").value),
        openNow: document.getElementById("openNow").checked,
      });
      if (!userLocation) return;
      searchInterruptedByUser = false;
      runSearch();
    });
  });

  // Default to the user's location automatically on load.
  initLocationOnLoad();

  map.addListener("click", (e) => {
    searchInterruptedByUser = false;
    userLocation = { lat: e.latLng.lat(), lng: e.latLng.lng() };
    hideLocationButton();
    runSearch();
  });

  // Catches real user interaction as early as possible (the moment a drag
  // or zoom begins, not once it settles) so a slow in-flight search knows
  // to back off before it finishes — see searchInterruptedByUser above.
  map.addListener("dragstart", () => {
    if (!suppressSearchAreaPrompt) searchInterruptedByUser = true;
  });
  map.addListener("zoom_changed", () => {
    if (suppressSearchAreaPrompt) return;
    searchInterruptedByUser = true;
    // Saved immediately here rather than waiting for "idle" — a user could
    // refresh within a second of zooming, sooner than idle (or its timeout
    // backstop) would otherwise get around to it.
    saveSettings({ zoom: map.getZoom() });
  });

  // Auto re-search once the map settles somewhere that no longer matches
  // what's loaded — either panned far enough away, or zoomed to a
  // different level (same center, different-sized area). "idle" fires once
  // per gesture (drag, scroll-zoom, pinch, keyboard pan) after it settles,
  // rather than firing repeatedly mid-gesture. suppressSearchAreaPrompt
  // tells our own programmatic moves (fitBounds, panTo a result, zip
  // recenter) apart from the user actually moving the map by hand — only
  // the latter should trigger a re-search.
  map.addListener("idle", () => {
    if (!userLocation || suppressSearchAreaPrompt) return;
    const center = map.getCenter();
    const moved = milesBetween(userLocation, { lat: center.lat(), lng: center.lng() });
    const zoomChanged = lastSearchZoom !== null && map.getZoom() !== lastSearchZoom;
    if (moved < 0.3 && !zoomChanged) return;

    clearTimeout(autoSearchTimer);
    autoSearchTimer = setTimeout(() => {
      userLocation = { lat: center.lat(), lng: center.lng() };
      hideLocationButton();
      // Search exactly what's currently visible — the radius dropdown is
      // ignored here — and don't let the search re-fit/zoom the map
      // afterward, since the whole point was to search this specific view.
      runSearch({ radiusOverrideMeters: currentViewportRadiusMeters(), fit: false });
    }, 500);
  });
}

// Custom-styled map chrome (Map/Satellite toggle, recenter, zoom) — the
// default Google controls don't match the app's look, so those are disabled
// above and replaced with plain buttons added via map.controls[].
function addMapControls() {
  const toggle = document.createElement("div");
  toggle.className = "map-toggle";
  toggle.innerHTML = `<button type="button" class="active" data-type="roadmap">Map</button><button type="button" data-type="satellite">Satellite</button>`;
  toggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      map.setMapTypeId(btn.dataset.type);
      toggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  map.controls[google.maps.ControlPosition.TOP_LEFT].push(toggle);

  const locateBtn = document.createElement("button");
  locateBtn.type = "button";
  locateBtn.className = "map-round-btn";
  locateBtn.title = "Use my location";
  locateBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`;
  locateBtn.addEventListener("click", attemptLocate);
  map.controls[google.maps.ControlPosition.TOP_RIGHT].push(locateBtn);

  const zoomStack = document.createElement("div");
  zoomStack.className = "zoom-stack";
  const zoomIn = document.createElement("button");
  zoomIn.type = "button";
  zoomIn.className = "map-round-btn";
  zoomIn.title = "Zoom in";
  zoomIn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  zoomIn.addEventListener("click", () => map.setZoom(map.getZoom() + 1));
  const zoomOut = document.createElement("button");
  zoomOut.type = "button";
  zoomOut.className = "map-round-btn";
  zoomOut.title = "Zoom out";
  zoomOut.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
  zoomOut.addEventListener("click", () => map.setZoom(map.getZoom() - 1));
  zoomStack.append(zoomIn, zoomOut);
  map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(zoomStack);
}

function clearFilters() {
  document.getElementById("radius").value = "1609";
  document.getElementById("openNow").checked = true;
  document.getElementById("zipInput").value = "";
  saveSettings({ radius: 1609, openNow: true });
  if (!userLocation) return;
  searchInterruptedByUser = false;
  runSearch();
}

// Picks a random place from whatever's currently on screen and opens it in
// Google Maps, same as tapping a card's external-link button would.
function chooseForMe() {
  if (lastResults.length === 0) {
    setStatus("Search first, then let the pig pick for you.");
    return;
  }
  const pick = lastResults[Math.floor(Math.random() * lastResults.length)];
  scrollToCard(pick.id);
  highlightMarker(pick.id);
  if (pick.mapsUrl) window.open(pick.mapsUrl, "_blank");
}

function locateUser() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject({ code: 0 });

    // Belt-and-suspenders timeout: the PositionOptions.timeout below is
    // supposed to guarantee the error callback fires within 15s even on
    // total failure, but some mobile browsers don't honor it while a
    // permission prompt is still pending/unanswered — neither callback
    // fires at all, and the UI is stuck on "Finding your location…"
    // forever. This settles the promise ourselves a beat later regardless
    // of what the browser does internally.
    let settled = false;
    const fallbackTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject({ code: 3 });
    }, 16000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setCenter(userLocation);
        cacheLocation(userLocation);
        resolve();
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);
        reject(err);
      },
      // maximumAge lets the browser hand back a recent cached fix instead of
      // forcing a fresh (slower, more failure-prone) lookup on every load.
      { timeout: 15000, maximumAge: 5 * 60 * 1000 }
    );
  });
}

function geocodeZip(zip) {
  return new Promise((resolve, reject) => {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: zip }, (results, status) => {
      if (status === "OK" && results[0]) {
        const loc = results[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng() });
      } else {
        reject(status);
      }
    });
  });
}

function attemptZipSearch() {
  const zip = document.getElementById("zipInput").value.trim();
  if (!zip) {
    setStatus("Enter a zip code first.");
    return;
  }

  hideLocationButton();
  setStatus("Looking up that zip code…");
  geocodeZip(zip)
    .then((loc) => {
      searchInterruptedByUser = false;
      userLocation = loc;
      withSuppressedInteraction(() => {
        map.setCenter(loc);
        map.setZoom(14);
      });
      setStatus("");
      runSearch();
    })
    .catch(() => {
      setStatus("Couldn't find that zip code — check it and try again.");
    });
}

// Tried gating the automatic attempt on navigator.permissions.query()'s
// reported state (only auto-locate when already "granted"), to dodge
// browsers that silently ignore a gesture-less getCurrentPosition() call on
// a first visit. That backfired — support for querying the "geolocation"
// permission is inconsistent across browsers (notably Safari), so it made
// the very first attempt flaky in a *different* way instead of fixing it.
// Simpler and more robust: always attempt automatically, and show the
// fallback button immediately rather than waiting for a failure — so
// there's always a guaranteed one-tap path available up front, regardless
// of whether the silent automatic attempt works, fails, or never resolves.
function initLocationOnLoad() {
  showLocationButton();
  attemptLocate();
}

// Asks for location access (the browser shows its own permission prompt) and
// uses the result once granted. The fallback button is left visible for the
// duration of the attempt (not just after a failure) and only hidden on an
// actual successful fix, so a silently-stuck attempt never leaves the user
// with nothing to click.
function attemptLocate() {
  setStatus("Finding your location…");
  return locateUser()
    .then(() => {
      setStatus("");
      hideLocationButton();
      runInitialSearch();
    })
    .catch((err) => {
      // A fresh fix failed — fall back to wherever we found them last time
      // rather than leaving the map on the hardcoded NYC default. The
      // location button stays visible either way, since this wasn't an
      // actual successful fix.
      const cachedLocation = loadCachedLocation();
      if (cachedLocation) {
        userLocation = cachedLocation;
        map.setCenter(cachedLocation);
        setStatus("Couldn't get a fresh location — showing your last known area.");
        runInitialSearch();
        // We do have somewhere to show them, so "enable location access"
        // would be a confusing ask — offer a fresh, precise fix instead.
        showLocationButton("Update my location");
        return;
      } else if (err && err.code === 1) {
        setStatus("Location access denied — enable it for this site, then try again, or enter a zip code below.");
      } else if (err && err.code === 3) {
        setStatus("Location took too long to find — try again, or enter a zip code below.");
      } else {
        setStatus("Couldn't get your location — click the map to drop a pin, or enter a zip code below.");
      }
      showLocationButton();
    });
}

// Radius options (meters) offered in the dropdown, ascending — plus a final,
// not-selectable-in-the-UI regional-scale ceiling to try before giving up.
// Google's own cap is 50km (see search-restaurants.js); no point trying past it.
const RADIUS_OPTIONS_METERS = [402, 805, 1609, 4828];
const MAX_SEARCH_RADIUS_METERS = 50000;

// The initial "where am I" search on page load. Press-mentioned restaurants
// are sparse enough that the default radius can easily come up empty
// outside a covered metro — rather than showing "0 places found" to a new
// user, silently widen behind the scenes (no flashing empty states) until
// something turns up.
//
// The remaining radius tiers are fetched IN PARALLEL, not one at a time —
// an earlier version tried them sequentially and that could take 15+
// seconds (each tier waiting on the previous one's full round trip before
// even starting), most noticeable on a refresh where geolocation resolves
// instantly from cache and has no delay of its own to mask the wait. Firing
// them all at once bounds the wait to roughly one round trip, and whichever
// tier wins is rendered straight from its own response — no redundant
// re-fetch at the winning radius afterward.
async function runInitialSearch() {
  searchInterruptedByUser = false;
  await runInitialSearchAttempts();

  // fitMapToResults() just computed its own "fit everything in" zoom — but
  // if the user has a remembered zoom preference, that should win over the
  // computed one, same as it does for radius/openNow. Skipped if they've
  // already taken over the map themselves in the meantime (in which case
  // wherever they've navigated to takes priority, not a remembered zoom
  // from before).
  const savedZoom = loadSettings().zoom;
  if (savedZoom != null && !searchInterruptedByUser) {
    withSuppressedInteraction(() => map.setZoom(savedZoom));
  }
}

async function runInitialSearchAttempts() {
  await runSearch();
  if (lastResults.length > 0) return;

  const radiusSelect = document.getElementById("radius");
  const startRadius = Number(radiusSelect.value);
  const openNow = document.getElementById("openNow").checked;
  const candidates = [...RADIUS_OPTIONS_METERS.filter((r) => r > startRadius), MAX_SEARCH_RADIUS_METERS];

  const attempts = await Promise.all(
    candidates.map(async (radius) => {
      try {
        const url = `/.netlify/functions/search-restaurants?lat=${userLocation.lat}&lng=${userLocation.lng}&radius=${radius}&openNow=${openNow}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        return { radius, results: data.results || [] };
      } catch (_err) {
        return null;
      }
    })
  );

  const winner = attempts
    .filter((a) => a && a.results.length > 0)
    .sort((a, b) => a.radius - b.radius)[0];
  if (!winner) return; // genuinely nothing within the cap — leave the empty result as-is

  if (RADIUS_OPTIONS_METERS.includes(winner.radius)) radiusSelect.value = String(winner.radius);
  await runSearch({ radiusOverrideMeters: winner.radius, resultsOverride: winner.results });
}

function showLocationButton(label = "Enable location access") {
  const btn = document.getElementById("enableLocationBtn");
  btn.textContent = label;
  btn.hidden = false;
}

function hideLocationButton() {
  document.getElementById("enableLocationBtn").hidden = true;
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

// resultsOverride skips the fetch entirely and renders already-fetched
// results straight through — used by runInitialSearch() when it's already
// fetched the winning radius's data itself (via its own parallel probing)
// and re-fetching the same thing here would just be a redundant round trip.
async function runSearch({ radiusOverrideMeters, fit = true, resultsOverride } = {}) {
  if (!userLocation) {
    setStatus("Set a location first — allow location access or click the map.");
    return;
  }

  const radius = radiusOverrideMeters ?? document.getElementById("radius").value;
  const openNow = document.getElementById("openNow").checked;
  lastSearchZoom = map.getZoom();

  setStatus("Finding good places…");
  document.getElementById("searchBtn").disabled = true;

  try {
    let results;
    if (resultsOverride) {
      results = resultsOverride;
    } else {
      // No minRating param — we're leaning on the press-mention boost +
      // weighted score to surface quality instead of a hard rating cutoff.
      const url = `/.netlify/functions/search-restaurants?lat=${userLocation.lat}&lng=${userLocation.lng}&radius=${radius}&openNow=${openNow}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!res.ok) {
        setStatus(`Something went wrong: ${data.error || "unknown error"}`);
        return;
      }
      results = data.results || [];
    }

    const matched = combineResults(results, userLocation);
    renderResults(matched, { fit });
    setStatus("");
    document.getElementById("resultsCount").textContent = `${matched.length} places found`;
    // On mobile this collapses the search-criteria accordion back down so
    // the map/results are visible instead of the filter panel; harmless on
    // desktop, where CSS ignores this attribute and keeps it expanded.
    document.getElementById("controlsToggle").setAttribute("aria-expanded", "false");

    // Layer in curated notable spots that happen to already be on screen —
    // never ones outside it, so they can't drag the zoom out wider than the
    // actual search results need. When we're about to fit/re-zoom (fit:
    // true), wait for that to settle before reading bounds; when we're not
    // moving the map at all (fit: false), current bounds are already final,
    // so do it immediately — waiting for "idle" here would mean waiting for
    // some future, unrelated map interaction, since nothing is changing.
    const layerInExtras = () => {
      const bounds = map.getBounds();
      if (!bounds) return;
      const shownIds = new Set(matched.map((r) => r.id));
      const extras = notableRestaurants
        .filter((n) => !shownIds.has(n.id) && bounds.contains({ lat: n.lat, lng: n.lng }))
        .map((n) => notableAsResult(n, userLocation));
      if (extras.length === 0) return;

      const full = [...matched, ...extras].sort((a, b) => a.distance - b.distance);
      renderResults(full, { fit: false });
      document.getElementById("resultsCount").textContent = `${full.length} places found`;
    };
    if (fit) {
      google.maps.event.addListenerOnce(map, "idle", layerInExtras);
    } else {
      layerInExtras();
    }
  } catch (err) {
    setStatus("Network error — try again.");
  } finally {
    document.getElementById("searchBtn").disabled = false;
  }
}

// Tags live Places API results with curated Michelin/James Beard award data
// where the same place (matched by Google place id) shows up in both.
function combineResults(regularResults, center) {
  const notableById = new Map(notableRestaurants.map((r) => [r.id, r]));

  const combined = regularResults.map((place) => {
    const distance = milesBetween(center, place);
    const notable = notableById.get(place.id);
    return {
      ...place,
      distance,
      isNotable: Boolean(notable),
      awards: notable ? notable.awards : [],
      tags: notable ? notable.tags || [] : [],
    };
  });

  combined.sort((a, b) => a.distance - b.distance);
  return combined;
}

// Formats a curated-only notable restaurant (not already in the live
// results) into the same shape renderResults/combineResults items use.
function notableAsResult(n, center) {
  return {
    id: n.id,
    name: n.name,
    lat: n.lat,
    lng: n.lng,
    distance: milesBetween(center, n),
    isNotable: true,
    awards: n.awards,
    tags: n.tags || [],
    mapsUrl: `https://www.google.com/maps/place/?q=place_id:${n.id}`,
    rating: null,
    reviewCount: null,
    openNow: null,
    priceLevel: null,
    cuisine: null,
  };
}

function clearMarkers() {
  markers.forEach((m) => m.setMap(null));
  markers = [];
  markersById.clear();
}

function scrollToCard(id) {
  const list = document.getElementById("resultsList");
  const card = Array.from(list.children).find((li) => li.dataset.id === id);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("highlighted");
  setTimeout(() => card.classList.remove("highlighted"), 1500);
}

function milesBetween(a, b) {
  const R = 3958.8; // Earth radius in miles
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// Radius (meters) of the largest circle that fits entirely inside the
// current visible map area — used so "Search this area" searches only what's
// actually on screen, not an arbitrary fixed distance from the dropdown.
function currentViewportRadiusMeters() {
  const bounds = map.getBounds();
  if (!bounds) return null;
  const center = map.getCenter();
  const centerPoint = { lat: center.lat(), lng: center.lng() };
  const ne = bounds.getNorthEast();
  const halfHeightMiles = milesBetween(centerPoint, { lat: ne.lat(), lng: centerPoint.lng });
  const halfWidthMiles = milesBetween(centerPoint, { lat: centerPoint.lat, lng: ne.lng() });
  return Math.round(Math.min(halfHeightMiles, halfWidthMiles) * 1609.34);
}

// The marker number is baked into the icon's own SVG (rather than set via
// Marker's separate `label` option) so it's one image, not two overlapping
// elements — Maps' BOUNCE animation on setAnimation() only transforms the
// icon, so a separate label would sit still while the icon jumped. Same
// reasoning is why the hover-grown version below scales via scaledSize
// (same path/viewBox, just rendered bigger) rather than redrawing — and why
// the anchor scales proportionally too, so the pin's bottom tip stays
// planted on the exact same point instead of the icon visibly jumping.
function pinMarkerIcon(labelText, { hovered = false } = {}) {
  const fill = hovered ? "#f291b3" : "#d1477a"; // lighter pink on hover
  // Little pig ears peeking above the head (on-brand for HungryPig) plus a
  // glossy highlight, instead of a plain flat teardrop — same numbering,
  // friendlier package. White circle sized to comfortably fit 2-digit
  // numbers, since a list of 10+ results is common.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38">
    <circle cx="5.5" cy="5" r="4.3" fill="${fill}"/>
    <circle cx="24.5" cy="5" r="4.3" fill="${fill}"/>
    <circle cx="5.5" cy="5.8" r="1.9" fill="#fbd7e1"/>
    <circle cx="24.5" cy="5.8" r="1.9" fill="#fbd7e1"/>
    <path d="M15 0C6.716 0 0 6.716 0 15c0 10.5 15 23 15 23s15-12.5 15-23C30 6.716 23.284 0 15 0z" fill="${fill}"/>
    <ellipse cx="10.5" cy="9" rx="5" ry="3.5" fill="#fff" opacity="0.25"/>
    <circle cx="15" cy="15" r="8" fill="#fff"/>
    <text x="15" y="15" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="9.5" font-weight="700" letter-spacing="-0.3" fill="${fill}">${labelText}</text>
  </svg>`;
  const scale = hovered ? 1.35 : 1;
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(30 * scale, 38 * scale),
    anchor: new google.maps.Point(15 * scale, 38 * scale),
  };
}

// Michelin/James Beard restaurants get a gold star instead of the standard
// pink pin, so they're unmistakable on the map at a glance.
function notableMarkerIcon(labelText, { hovered = false } = {}) {
  const fill = hovered ? "#f6c15c" : "#f0a020"; // lighter gold on hover — stays in its own color family rather than shifting to pink
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
    <path d="${STAR_PATH}" fill="${fill}" stroke="#c97f0a" stroke-width="1.2" stroke-linejoin="round"/>
    <ellipse cx="15" cy="12" rx="5" ry="3" fill="#fff" opacity="0.3"/>
    <text x="20" y="21" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="9.5" font-weight="700" letter-spacing="-0.3" fill="#3a2233">${labelText}</text>
  </svg>`;
  const scale = hovered ? 1.3 : 1;
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(40 * scale, 40 * scale),
    anchor: new google.maps.Point(20 * scale, 20 * scale),
  };
}

function awardBadgeText(award) {
  return award.type === "michelin"
    ? `MICHELIN ${"★".repeat(award.stars)}`
    : `JAMES BEARD · ${award.category} (${award.year})`;
}

// Toggles a marker's "here's this one" look — grown + lightened icon and a
// higher z-index so it doesn't get lost behind neighbors. Needs the
// result's index (for its label number) and isNotable (pin vs star), found
// by matching id against the currently-rendered results. Numbers always
// match the list's current top-to-bottom order (distance/relevance), not a
// stable per-restaurant identity — deliberate choice: a restaurant's number
// can shift when you pan/zoom and it re-ranks, in exchange for the list
// never showing badges out of order (e.g. 8, 10, 6) the way a persistent
// numbering scheme would once results re-sort by distance from the (moved)
// map center.
function setMarkerEmphasized(id, emphasized) {
  const marker = markersById.get(id);
  if (!marker) return;
  const idx = lastResults.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const place = lastResults[idx];
  const labelText = String(idx + 1);
  const iconFn = place.isNotable ? notableMarkerIcon : pinMarkerIcon;
  marker.setIcon(iconFn(labelText, { hovered: emphasized }));
  marker.setZIndex(emphasized ? 9999 : place.isNotable ? 999 : 1);
}

// Grows + lightens a marker and gives it a quick bounce — the shared
// "here's this one" cue for clicking a result, whether that's its card, its
// map pin, or "Choose for me". Hovering a card uses the same emphasis (via
// setMarkerEmphasized) but toggles off directly on mouseleave instead of
// waiting for this timeout, since hover has a natural "off" signal a click
// doesn't.
function highlightMarker(id) {
  setMarkerEmphasized(id, true);
  const marker = markersById.get(id);
  if (!marker) return;
  marker.setAnimation(google.maps.Animation.BOUNCE);
  setTimeout(() => {
    marker.setAnimation(null);
    setMarkerEmphasized(id, false);
  }, 700);
}

function renderResults(results, { fit = true } = {}) {
  clearMarkers();
  lastResults = results;
  const list = document.getElementById("resultsList");
  list.innerHTML = "";

  results.forEach((place, i) => {
    const num = i + 1;

    // Marker
    const marker = new google.maps.Marker({
      position: { lat: place.lat, lng: place.lng },
      map,
      icon: place.isNotable ? notableMarkerIcon(String(num)) : pinMarkerIcon(String(num)),
      title: place.name,
      zIndex: place.isNotable ? 999 : 1,
    });
    marker.addListener("click", () => {
      scrollToCard(place.id);
      highlightMarker(place.id);
    });
    markers.push(marker);
    markersById.set(place.id, marker);

    // List card
    const li = document.createElement("li");
    li.className = "result-card" + (place.isNotable ? " notable-card" : "");
    li.dataset.id = place.id;

    const priceStr = place.priceLevel ? "$".repeat(priceLevelToNumber(place.priceLevel)) : "";
    const openStr =
      place.openNow === true
        ? '<span class="open-status">Open now</span>'
        : place.openNow === false
        ? '<span class="closed-status">Closed</span>'
        : "";

    // Plain facts — distance, price, cuisine. Quiet supporting metadata,
    // not the point of the card.
    const metaParts = [`${place.distance.toFixed(1)} mi`];
    if (priceStr) metaParts.push(priceStr);
    if (place.cuisine) metaParts.push(escapeHtml(place.cuisine));

    // Rating only, no review count — kept visually separate from
    // HungryPig's own curation (the endorsement badge + "why it's here"
    // line below) so the two don't blur into one undifferentiated wall of
    // pills.
    const ratingParts = [];
    if (place.rating != null) ratingParts.push(`<span class="rating">★ ${place.rating.toFixed(1)}</span>`);
    if (openStr) ratingParts.push(openStr);

    // One shared badge style for anything actually being vouched for — a
    // Michelin star, a James Beard nod, or a press pick — instead of a
    // different pill per source (that stacking to 6 pills was the bug).
    const endorsements = (place.awards || []).map(
      (a) => `<span class="endorsement-badge">${escapeHtml(awardBadgeText(a))}</span>`
    );
    // PIG PICK is reserved for actual cross-source consensus — showing up
    // in more than one independent write-up, not just one (mirrors the
    // same "repetition = consensus" logic the backend already uses for
    // score boosting). A single mention doesn't get a badge at all rather
    // than a softer fallback — it still feeds the score boost and the "why
    // it's here" line, just not this stamp. Never names the source itself
    // — the methodology is part of the brand, not a citation trail.
    const pressMentions = place.pressMentions || [];
    const pressSources = new Set(pressMentions.map((m) => m.source_name || "the press"));
    if (pressSources.size >= 2) {
      endorsements.push(`<span class="endorsement-badge">🐽 PIG PICK</span>`);
    }

    // Press tags win when a restaurant has both — they're pulled from a
    // specific, current article, while the curated Michelin/JBF tags are a
    // static fallback. Rendered as plain text, not pills — this is
    // HungryPig's own editorial voice, a sentence, not more metadata chips.
    const traitSource = place.pressTags && place.pressTags.length > 0 ? place.pressTags : place.tags || [];
    const whyHere = traitSource.map((t) => escapeHtml(t)).join(" · ");

    // "What to order" — specific dishes press mentions call out, ranked by
    // how many separate sources name the same dish (dishes.mention_count
    // from hungrydb). Only shown once a dish has actually been extracted;
    // most restaurants without press coverage simply won't have any.
    const topDishes = place.topDishes || [];
    const whatToOrder =
      topDishes.length > 0
        ? `<div class="what-to-order">
             <span class="wto-label">What to order</span>
             <div class="dish-pill-row">${topDishes
               .map(
                 (d) =>
                   `<span class="dish-pill">${escapeHtml(d.name)}${
                     d.count > 1 ? ` <span class="dish-count">×${d.count}</span>` : ""
                   }</span>`
               )
               .join("")}</div>
           </div>`
        : "";

    const badgeContent = place.isNotable
      ? `<svg class="badge-star" viewBox="0 0 40 40" aria-hidden="true"><path d="${STAR_PATH}" fill="currentColor"/></svg><span class="badge-num">${num}</span>`
      : `${num}`;

    li.innerHTML = `
      <span class="result-badge">${badgeContent}</span>
      <div class="result-body">
        <h3>${escapeHtml(place.name)}</h3>
        <div class="result-meta">${metaParts.join(" · ")}</div>
        ${ratingParts.length > 0 ? `<div class="result-rating">${ratingParts.join(" · ")}</div>` : ""}
        ${endorsements.length > 0 ? `<div class="endorsement-badges">${endorsements.join("")}</div>` : ""}
        ${whatToOrder}
        ${whyHere ? `<div class="why-here">${whyHere}</div>` : ""}
      </div>
      ${place.mapsUrl ? `<button type="button" class="open-external-btn" title="Open in Google Maps" aria-label="Open in Google Maps">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </button>` : ""}
    `;
    li.addEventListener("click", () => {
      // Pan to the result but leave zoom alone — clicking shouldn't change
      // how far in/out the map is, only Google's native double-click does.
      // Focusing one result also isn't "I want to search a new area" —
      // don't pop the search-area button just because we panned.
      withSuppressedInteraction(() => map.panTo({ lat: place.lat, lng: place.lng }));
      highlightMarker(place.id);
    });
    // Hovering a card triggers the same emphasis clicking it (or its map
    // pin) does, so scrolling the list gives an obvious "here's where that
    // one is" cue on the map without panning it while you're just
    // browsing. mouseleave reverts immediately rather than waiting on
    // highlightMarker's own timeout, since hover has a natural "off" signal
    // a click doesn't.
    li.addEventListener("mouseenter", () => highlightMarker(place.id));
    li.addEventListener("mouseleave", () => setMarkerEmphasized(place.id, false));
    const externalBtn = li.querySelector(".open-external-btn");
    if (externalBtn) {
      externalBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.open(place.mapsUrl, "_blank");
      });
    }
    list.appendChild(li);
  });

  if (fit) fitMapToResults(results);
}

// Zooms/pans so every marker (plus the searched-from point) is actually
// visible, instead of leaving pins scattered outside the current viewport.
function fitMapToResults(results) {
  // The user already moved on (dragged/zoomed) while this search was still
  // in flight — respect wherever they are now instead of yanking the
  // camera back to stale results. The idle listener above will pick up
  // their new position and search it once they settle.
  if (searchInterruptedByUser) return;

  const bounds = new google.maps.LatLngBounds();
  if (userLocation) bounds.extend(userLocation);
  results.forEach((r) => bounds.extend({ lat: r.lat, lng: r.lng }));
  if (bounds.isEmpty()) return;

  withSuppressedInteraction(() => {
    map.fitBounds(bounds, 48);
    // fitBounds can over-zoom when everything is clustered close together
    // (or there's only one result, e.g. right on page load) — cap it well
    // short of street-level so it still reads as "here's the neighborhood,"
    // not a jarring zoom into one block.
    google.maps.event.addListenerOnce(map, "bounds_changed", () => {
      if (map.getZoom() > 15) map.setZoom(15);
    });
  });
}

function priceLevelToNumber(priceLevel) {
  const map = {
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4,
  };
  return map[priceLevel] || 1;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
