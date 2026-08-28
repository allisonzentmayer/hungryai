// app.js — runs in the browser. No API keys live here except the
// restricted, referrer-locked Maps JavaScript key loaded via <script> tag.

let map;
let markers = [];
let markersById = new Map();
// The mobile pin-tap preview card (built once in addMapControls, shown/
// hidden via the pin-preview-card--hidden CLASS, not the `hidden`
// attribute — Maps only measures a pushed control's width once, at push
// time, to center it for BOTTOM_CENTER. A `hidden` (display:none) element
// measures as 0px wide, so Maps centers it as a point and never re-centers
// once it later expands to its real width — the card ends up with its
// LEFT edge at the horizontal center instead of being centered, hanging
// off the right side of the map. visibility:hidden keeps its real width
// intact for that one-time measurement while still being invisible/
// non-interactive. Desktop never shows it — gated behind isMobileLayout().
let previewCardEl = null;
let previewCardBodyEl = null;
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
// The full result set from the last fetch, BEFORE the "Open now" filter is
// applied. That filter now runs in the browser (the server returns every
// place with an openNow flag), so toggling the checkbox re-filters this
// list instantly instead of round-tripping to the function again.
let lastFetchedResults = [];
// Where lastFetchedResults was fetched for — lets the geolocation flow skip
// re-searching when the real fix lands basically on top of the location we
// already prefetched against (see initMap / attemptLocate).
let lastSearchedLocation = null;

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
  wireLocationRecoveryUI();
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

  // Mobile-only map/list view toggle (no-op on desktop, where CSS shows
  // both panes side by side regardless of data-mobile-view).
  document.querySelectorAll(".view-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMobileView(btn.dataset.view));
  });

  // Filters apply live — there's no separate "go" button for them (searchBtn
  // is hidden in favor of the header CTA). Radius changes the area we ask
  // the server about, so it re-fetches; "Open now" is purely a filter over
  // results we already have, so it just re-renders (no round trip).
  document.getElementById("radius").addEventListener("change", () => {
    saveSettings({ radius: Number(document.getElementById("radius").value) });
    if (!userLocation) return;
    searchInterruptedByUser = false;
    runSearch();
  });
  document.getElementById("openNow").addEventListener("change", () => {
    saveSettings({ openNow: document.getElementById("openNow").checked });
    if (!userLocation) return;
    renderCurrentResults({ fit: false });
  });

  // Return visitor? Start a search against their last known location right
  // now, in parallel with geolocation — pins land almost immediately
  // instead of only after the geolocation round trip (and any permission
  // prompt) resolves. If the real fix comes back somewhere meaningfully
  // different, the locate flow re-runs the search; if it's basically the
  // same spot, that re-run is skipped (see attemptLocate).
  if (cachedLocation) {
    userLocation = cachedLocation;
    runInitialSearch();
  }

  // Default to the user's location automatically on load.
  initLocationOnLoad(Boolean(cachedLocation));

  map.addListener("click", (e) => {
    searchInterruptedByUser = false;
    userLocation = { lat: e.latLng.lat(), lng: e.latLng.lng() };
    clearLocationUI();
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

  // Mobile pin-tap preview card — built once and pushed as a real map
  // control (same pattern as everything else in this function) so Maps
  // positions it for us, then just toggled via .hidden afterward. Desktop
  // never triggers showPreviewCard() in the first place (see
  // isMobileLayout()), so this sits inert there.
  previewCardEl = document.createElement("div");
  previewCardEl.className = "pin-preview-card pin-preview-card--hidden";
  previewCardEl.innerHTML = `
    <button type="button" class="pin-preview-close" aria-label="Close">×</button>
    <div class="pin-preview-body"></div>
  `;
  previewCardEl.querySelector(".pin-preview-close").addEventListener("click", hidePreviewCard);
  previewCardBodyEl = previewCardEl.querySelector(".pin-preview-body");
  map.controls[google.maps.ControlPosition.BOTTOM_CENTER].push(previewCardEl);
}

// Matches the 900px breakpoint in style.css exactly — desktop shows the
// list sidebar permanently, so pin taps there scroll to the card instead
// of opening this card (see the marker click handler in renderResults).
function isMobileLayout() {
  return window.matchMedia("(max-width: 900px)").matches;
}

// Driven by an attribute on <body> rather than component state so the CSS
// that hides whichever pane isn't active lives entirely in the mobile
// media query — this just flips the attribute and keeps the toggle
// buttons' visual state in sync with it. Used both by the toggle buttons
// themselves and by each card's "show on map" button.
function setMobileView(view) {
  document.body.dataset.mobileView = view;
  document.querySelectorAll(".view-toggle-btn").forEach((b) => {
    const active = b.dataset.view === view;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  // The preview card only makes sense while looking at the map — leaving
  // it open underneath a now-hidden map would just be stale state.
  if (view !== "map") hidePreviewCard();
}

function showPreviewCard(place) {
  if (!previewCardEl) return;
  previewCardBodyEl.innerHTML =
    buildResultInfoHTML(place) +
    (place.mapsUrl
      ? `<button type="button" class="open-external-btn pin-preview-external-btn" title="Open in Google Maps" aria-label="Open in Google Maps">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
         </button>`
      : "");
  const externalBtn = previewCardBodyEl.querySelector(".pin-preview-external-btn");
  if (externalBtn) {
    externalBtn.addEventListener("click", () => window.open(place.mapsUrl, "_blank"));
  }
  previewCardEl.classList.remove("pin-preview-card--hidden");
}

function hidePreviewCard() {
  if (!previewCardEl) return;
  previewCardEl.classList.add("pin-preview-card--hidden");
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

// Resolves with a { lat, lng } fix. Deliberately side-effect-free — it does
// NOT touch userLocation / the map / the cache. Each caller decides what to
// do with a fix: the foreground locate recenters and searches; the silent
// background refine only recenters if the fix actually moved.
function locateUser() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject({ code: 0 });

    // Belt-and-suspenders timeout: the PositionOptions.timeout below is
    // supposed to guarantee the error callback fires even on total failure,
    // but some mobile browsers don't honor it while a permission prompt is
    // still pending/unanswered — neither callback fires at all, and the UI
    // is stuck on "Finding your location…" forever. This settles the promise
    // ourselves a beat past the PositionOptions timeout regardless of what
    // the browser does internally.
    let settled = false;
    const fallbackTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject({ code: 3 });
    }, 10000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);
        reject(err);
      },
      // enableHighAccuracy: false (the default, but explicit) — a wifi/cell
      // fix is both much faster and far less likely to fail than waiting on
      // GPS, and block-level precision doesn't matter for "food near me."
      // The generous maximumAge lets the browser hand back a recent cached
      // fix instantly instead of forcing a fresh lookup on every load.
      { timeout: 9000, maximumAge: 10 * 60 * 1000, enableHighAccuracy: false }
    );
  });
}

// navigator.permissions.query for "geolocation" — used ONLY as an
// optimization: when it reliably reports "denied" we can skip a
// getCurrentPosition() call that we know will just burn its full timeout and
// fail, and show the recovery UI immediately instead. Never the sole gate —
// support is patchy (older Safari especially), so null / a throw here just
// means "proceed as normal and let getCurrentPosition sort it out."
// Returns "granted" | "prompt" | "denied" | null.
async function queryGeoPermission() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return null;
    const status = await navigator.permissions.query({ name: "geolocation" });
    return status.state;
  } catch (_err) {
    return null;
  }
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

// Geocode a zip string and search there. Resolves true on success, false on
// a bad/empty zip (so callers like the recovery modal know whether to close
// themselves). Shared by the sidebar zip field and the "couldn't find you"
// modal.
function runZipSearch(rawZip) {
  const zip = (rawZip || "").trim();
  if (!zip) {
    setStatus("Enter a zip code first.");
    return Promise.resolve(false);
  }

  setStatus("Looking up that zip code…");
  return geocodeZip(zip)
    .then((loc) => {
      searchInterruptedByUser = false;
      userLocation = loc;
      clearLocationUI();
      hideLocationButton();
      withSuppressedInteraction(() => {
        map.setCenter(loc);
        map.setZoom(14);
      });
      setStatus("");
      runSearch();
      return true;
    })
    .catch(() => {
      setStatus("Couldn't find that zip code — check it and try again.");
      return false;
    });
}

function attemptZipSearch() {
  return runZipSearch(document.getElementById("zipInput").value);
}

// Runs on page load. Two entry states:
//   - Return visitor (initMap already kicked off a search against their
//     cached location): quietly refine in the background, and only disrupt
//     the screen if the fresh fix is somewhere genuinely different.
//   - First-time visitor: a normal foreground locate, with "Finding your
//     location…" shown.
// Either way, if the browser already firmly reports permission as "denied",
// skip straight to the recovery UI — a getCurrentPosition() call there would
// just sit burning its timeout before failing.
async function initLocationOnLoad(haveCached) {
  const perm = await queryGeoPermission();

  if (perm === "denied") {
    if (haveCached) {
      // Results are already loading from the cached area — just flag that
      // location is off and offer to turn it on.
      showLocationBanner();
      showLocationButton("Turn on location");
    } else {
      openLocationModal("denied");
    }
    return;
  }

  if (haveCached) {
    refineLocationInBackground();
  } else {
    showLocationButton();
    attemptLocate();
  }
}

// A search already covers this spot if we've fetched for somewhere within
// ~0.4 mi of it — used to skip a redundant re-search when geolocation
// resolves right on top of the location we already prefetched against on
// load.
function alreadySearchedNear(loc) {
  return lastSearchedLocation != null && milesBetween(lastSearchedLocation, loc) < 0.4;
}

// Foreground "where am I" — the browser shows its own permission prompt.
// Used by the initial load (no cached location), the header CTA, the map
// locate button, and every "Try again" in the recovery UI.
function attemptLocate() {
  setStatus("Finding your location…");
  return locateUser()
    .then((fix) => {
      searchInterruptedByUser = false;
      userLocation = fix;
      cacheLocation(fix);
      withSuppressedInteraction(() => map.setCenter(fix));
      setStatus("");
      clearLocationUI();
      hideLocationButton();
      if (alreadySearchedNear(fix)) return;
      runInitialSearch();
    })
    .catch((err) => {
      // A fresh fix failed. If we know where they were last time, fall back
      // to that rather than the hardcoded NYC default, and just flag that
      // location is off — don't block the screen with a modal when we have
      // something useful to show.
      const cachedLocation = loadCachedLocation();
      if (cachedLocation) {
        userLocation = cachedLocation;
        withSuppressedInteraction(() => map.setCenter(cachedLocation));
        setStatus("");
        if (!alreadySearchedNear(cachedLocation)) runInitialSearch();
        showLocationButton(err && err.code === 1 ? "Turn on location" : "Update my location");
        showLocationBanner();
        return;
      }
      // Nothing to show. code 1 = permission denied (fixable — explain how);
      // anything else (timeout, position unavailable, no geolocation API) =
      // transient/unknown, so lead with the zip-code path instead.
      setStatus("");
      openLocationModal(err && err.code === 1 ? "denied" : "unavailable");
      showLocationButton(err && err.code === 1 ? "Turn on location" : "Enable location access");
    });
}

// Silent counterpart to attemptLocate() for return visitors — cached-area
// results are already on screen (see initMap), so this must not flash a
// status message, yank the map, or pop a modal on failure. It only steps in
// when the fresh fix is far enough from the cached one to matter.
function refineLocationInBackground() {
  return locateUser()
    .then((fix) => {
      cacheLocation(fix);
      clearLocationUI();
      hideLocationButton();
      // The user started driving the map while we were resolving — the idle
      // handler has already searched wherever they went. Leave it be.
      if (searchInterruptedByUser) return;
      const moved = !userLocation || milesBetween(userLocation, fix) > 0.4;
      userLocation = fix;
      if (!moved || alreadySearchedNear(fix)) return;
      searchInterruptedByUser = false;
      withSuppressedInteraction(() => map.setCenter(fix));
      runInitialSearch();
    })
    .catch((err) => {
      // Denied since last visit → surface the (dismissible) banner. A
      // timeout or unavailable position stays completely silent; the
      // cached-area results are a fine place to be.
      if (err && err.code === 1) {
        showLocationBanner();
        showLocationButton("Turn on location");
      }
    });
}

// The initial "where am I" search on page load. Radius widening (press
// spots are sparse enough that the default radius often comes up empty
// outside a covered metro) now happens server-side in a single request —
// the function walks its own radius tiers outward over cached reads — so
// this is just one runSearch() call.
async function runInitialSearch() {
  searchInterruptedByUser = false;
  await runSearch();

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

// ---- Location recovery UI (modal + banner) -------------------------------
// Shown when geolocation can't give us a usable position and we can't
// silently fall back to a cached area. A real dialog (backdrop, Esc, focus
// pulled in and trapped) rather than an inline note, because "we don't know
// where you are" blocks the entire app. Two modes:
//   "denied"      — permission is blocked: show how to switch it back on
//                   (browsers expose no API to open OS/site settings for us,
//                   so this is written steps + a Try again button)
//   "unavailable" — timed out / position unavailable / no geolocation API:
//                   lead with a zip-code box, offer to retry location

let restoreFocusEl = null;

// Per-platform written steps for re-granting location. Best-effort — the
// wording won't match every browser version exactly, but it points at the
// right place. There is deliberately no "open settings" button: no web API
// can do that on any platform.
function locationHelpSteps() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return [
      "Open the Settings app → Privacy & Security → Location Services, and check it's on.",
      "Find your browser (Safari or Chrome) in that list, tap it, and choose “While Using the App”.",
      "Come back here and tap Try again.",
    ];
  }
  if (/Android/i.test(ua)) {
    return [
      "Tap your browser's ⋮ menu → Settings → Site settings → Location.",
      "Turn Location on, and remove this site from the Blocked list if it's there.",
      "Reload this page and tap Try again.",
    ];
  }
  return [
    "Click the lock (or “Site information”) icon at the left of the address bar.",
    "Set Location to Allow.",
    "Reload this page and click Try again.",
  ];
}

function renderLocationModal(mode) {
  const body = document.getElementById("locModalBody");
  if (mode === "unavailable") {
    body.innerHTML = `
      <h2 id="locModalTitle">We couldn't find your location</h2>
      <p>No problem — tell us roughly where to look.</p>
      <div class="loc-modal-zip">
        <input type="text" id="locModalZip" inputmode="numeric" autocomplete="postal-code" placeholder="Enter a zip code" aria-label="Zip code" />
        <button type="button" class="cta-btn" data-loc-act="zipgo">Go</button>
      </div>
      <p class="loc-modal-alt"><button type="button" class="linklike" data-loc-act="retry">Try my location again</button></p>
    `;
  } else {
    body.innerHTML = `
      <h2 id="locModalTitle">Location is switched off</h2>
      <p>HungryPig uses your location to find good food nearby, and your browser is blocking it right now. Here's how to switch it back on:</p>
      <ol class="loc-modal-steps">${locationHelpSteps().map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
      <button type="button" class="cta-btn loc-modal-primary" data-loc-act="retry">Try again</button>
      <p class="loc-modal-alt">Rather not? <button type="button" class="linklike" data-loc-act="zip">Search by zip code instead</button></p>
    `;
  }
}

function openLocationModal(mode = "denied") {
  renderLocationModal(mode);
  const backdrop = document.getElementById("locationModal");
  if (!backdrop.hidden) return; // already open — just re-rendered contents
  restoreFocusEl = document.activeElement;
  backdrop.hidden = false;
  const zip = document.getElementById("locModalZip");
  (zip || backdrop.querySelector(".loc-modal")).focus();
}

function closeLocationModal() {
  const backdrop = document.getElementById("locationModal");
  if (backdrop.hidden) return;
  backdrop.hidden = true;
  if (restoreFocusEl && typeof restoreFocusEl.focus === "function") restoreFocusEl.focus();
  restoreFocusEl = null;
}

function showLocationBanner() {
  const banner = document.getElementById("locationBanner");
  if (banner.dataset.dismissed === "true") return;
  banner.hidden = false;
}

function hideLocationBanner() {
  document.getElementById("locationBanner").hidden = true;
}

// Called the instant we get any usable location (fresh fix, cached fallback
// that the user accepted via retry, or a zip search) — nothing in the
// recovery UI should linger once we know where to look.
function clearLocationUI() {
  closeLocationModal();
  hideLocationBanner();
}

// Open the sidebar criteria panel (a collapsed accordion on mobile) and put
// the cursor in its zip field — the "search by zip instead" escape hatch
// from the denied modal.
function focusSidebarZip() {
  const toggle = document.getElementById("controlsToggle");
  if (toggle && toggle.getAttribute("aria-expanded") !== "true") {
    toggle.setAttribute("aria-expanded", "true");
  }
  const input = document.getElementById("zipInput");
  input.scrollIntoView({ behavior: "smooth", block: "center" });
  input.focus();
}

function wireLocationRecoveryUI() {
  const backdrop = document.getElementById("locationModal");
  const body = document.getElementById("locModalBody");

  backdrop.querySelector(".loc-modal-close").addEventListener("click", closeLocationModal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeLocationModal();
  });

  document.addEventListener("keydown", (e) => {
    if (backdrop.hidden) return;
    if (e.key === "Escape") {
      closeLocationModal();
      return;
    }
    if (e.key !== "Tab") return;
    // Minimal focus trap — keep Tab inside the dialog while it's open.
    const focusable = backdrop.querySelectorAll("button, input, a[href]");
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  const runModalZip = () => {
    const input = document.getElementById("locModalZip");
    runZipSearch(input ? input.value : "").then((ok) => {
      if (ok) closeLocationModal();
    });
  };

  body.addEventListener("click", (e) => {
    const act = e.target.closest("[data-loc-act]");
    if (!act) return;
    if (act.dataset.locAct === "retry") {
      closeLocationModal();
      attemptLocate();
    } else if (act.dataset.locAct === "zip") {
      closeLocationModal();
      focusSidebarZip();
    } else if (act.dataset.locAct === "zipgo") {
      runModalZip();
    }
  });
  body.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "locModalZip") {
      e.preventDefault();
      runModalZip();
    }
  });

  const banner = document.getElementById("locationBanner");
  banner.querySelector(".loc-banner-btn").addEventListener("click", attemptLocate);
  banner.querySelector(".loc-banner-close").addEventListener("click", () => {
    banner.dataset.dismissed = "true";
    hideLocationBanner();
  });
}

// Snap coordinates to a ~110m grid before putting them in the request URL.
// Raw geolocation fixes are full-precision floats that never match each
// other exactly, so before this the function's edge cache (and the server's
// own grid cache) effectively never got a repeat hit. 3 decimal places is
// ~110m — far inside any search radius.
function snapCoord(n) {
  return Math.round(n * 1000) / 1000;
}

function searchUrl(loc, radius) {
  // No openNow param — the server returns every place with an openNow flag
  // and the browser filters, so toggling "Open now" never needs a refetch
  // and the cache key doesn't split on a value that changes every minute.
  return `/.netlify/functions/search-restaurants?lat=${snapCoord(loc.lat)}&lng=${snapCoord(loc.lng)}&radius=${radius}`;
}

// "Open now" is applied here, over the last fetched set. Unknown hours
// (openNow == null — e.g. a curated spot the enrichment job hasn't reached)
// stay visible; only places that are definitively closed get hidden.
function applyOpenNowFilter(results) {
  if (!document.getElementById("openNow").checked) return results;
  return results.filter((r) => r.openNow !== false);
}

async function runSearch({ radiusOverrideMeters, fit = true } = {}) {
  if (!userLocation) {
    setStatus("Set a location first — allow location access or click the map.");
    return;
  }

  const radius = radiusOverrideMeters ?? document.getElementById("radius").value;
  lastSearchZoom = map.getZoom();

  setStatus("Finding good places…");
  document.getElementById("searchBtn").disabled = true;

  try {
    const res = await fetch(searchUrl(userLocation, radius));
    const data = await res.json();

    if (!res.ok) {
      setStatus(`Something went wrong: ${data.error || "unknown error"}`);
      return;
    }

    lastFetchedResults = data.results || [];
    lastSearchedLocation = { ...userLocation };
    renderCurrentResults({ fit });
    setStatus("");
  } catch (err) {
    setStatus("Network error — try again.");
  } finally {
    document.getElementById("searchBtn").disabled = false;
  }
}

// Render whatever's currently in lastFetchedResults, applying the live
// "Open now" filter and layering in curated notable spots. Split out from
// runSearch so the "Open now" checkbox can re-render without refetching.
function renderCurrentResults({ fit = true } = {}) {
  if (!userLocation) return;

  const matched = combineResults(applyOpenNowFilter(lastFetchedResults), userLocation);
  renderResults(matched, { fit });
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
  // Ears match the mascot SVG in index.html exactly (light pink outer
  // ellipse + darker pink inner ellipse, not plain circles) so the pin
  // reads as "the same pig" as the logo/mascot rather than a generic
  // rounded-blob approximation. White circle sized to comfortably fit
  // 2-digit numbers, since a list of 10+ results is common.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38">
    <ellipse cx="5" cy="5.5" rx="4.4" ry="5.4" fill="#f6a8c0"/>
    <ellipse cx="25" cy="5.5" rx="4.4" ry="5.4" fill="#f6a8c0"/>
    <ellipse cx="5" cy="6" rx="2.2" ry="2.8" fill="#e37da0"/>
    <ellipse cx="25" cy="6" rx="2.2" ry="2.8" fill="#e37da0"/>
    <path d="M15 0C6.716 0 0 6.716 0 15c0 10.5 15 23 15 23s15-12.5 15-23C30 6.716 23.284 0 15 0z" fill="${fill}"/>
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

// The info body (name, meta, rating, endorsements, "what to order",
// "why here") shared between a sidebar list card and the mobile pin-tap
// preview card — factored out so "same info as the list" is enforced by
// both calling this, not by keeping two hand-written copies in sync.
function buildResultInfoHTML(place) {
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

  return `
    <h3>${escapeHtml(place.name)}</h3>
    <div class="result-meta">${metaParts.join(" · ")}</div>
    ${ratingParts.length > 0 ? `<div class="result-rating">${ratingParts.join(" · ")}</div>` : ""}
    ${endorsements.length > 0 ? `<div class="endorsement-badges">${endorsements.join("")}</div>` : ""}
    ${whatToOrder}
    ${whyHere ? `<div class="why-here">${whyHere}</div>` : ""}
  `;
}

function renderResults(results, { fit = true } = {}) {
  clearMarkers();
  hidePreviewCard();
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
      // On mobile, the sidebar list isn't visible while looking at the map
      // — tapping a pin opens its info in a small card over the map
      // instead of scrolling to a list item the user can't see.
      if (isMobileLayout()) {
        showPreviewCard(place);
      } else {
        scrollToCard(place.id);
      }
      highlightMarker(place.id);
    });
    markers.push(marker);
    markersById.set(place.id, marker);

    // List card
    const li = document.createElement("li");
    li.className = "result-card" + (place.isNotable ? " notable-card" : "");
    li.dataset.id = place.id;

    const badgeContent = place.isNotable
      ? `<svg class="badge-star" viewBox="0 0 40 40" aria-hidden="true"><path d="${STAR_PATH}" fill="currentColor"/></svg><span class="badge-num">${num}</span>`
      : `${num}`;

    li.innerHTML = `
      <span class="result-badge">${badgeContent}</span>
      <div class="result-body">${buildResultInfoHTML(place)}</div>
      ${place.mapsUrl ? `<button type="button" class="open-external-btn" title="Open in Google Maps" aria-label="Open in Google Maps">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </button>` : ""}
      <button type="button" class="show-on-map-btn" title="Show on map" aria-label="Show on map">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 1114 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.3"/></svg>
      </button>
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
    // Mobile only (CSS-hidden on desktop, where the map is already visible
    // alongside the list) — jumps to map view centered on this result with
    // its preview card open, since a plain tap on a list card (above)
    // deliberately does NOT switch views on its own.
    li.querySelector(".show-on-map-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      setMobileView("map");
      withSuppressedInteraction(() => map.panTo({ lat: place.lat, lng: place.lng }));
      highlightMarker(place.id);
      showPreviewCard(place);
    });
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
