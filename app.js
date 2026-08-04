// app.js — runs in the browser. No API keys live here except the
// restricted, referrer-locked Maps JavaScript key loaded via <script> tag.

let map;
let markers = [];
let markersById = new Map();
let userLocation = null;
let notableRestaurants = [];
let searchAreaBtn;

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

document.querySelectorAll(".mascot-pig").forEach((pig) => {
  pig.addEventListener("click", (e) => {
    const wrap = pig.closest(".mascot-wrap");
    const bubble = wrap?.querySelector(".oink-bubble");
    if (!wrap || !bubble) return;

    const rect = wrap.getBoundingClientRect();
    bubble.style.left = `${e.clientX - rect.left}px`;
    bubble.style.top = `${e.clientY - rect.top}px`;

    bubble.classList.remove("show");
    // Force reflow so re-adding the class restarts the animation on rapid clicks.
    void bubble.offsetWidth;
    bubble.classList.add("show");
    clearTimeout(bubble._oinkTimeout);
    bubble._oinkTimeout = setTimeout(() => bubble.classList.remove("show"), 900);
  });
});

// Called by the Google Maps script tag once it loads.
function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 40.7128, lng: -74.006 }, // fallback: NYC, replaced once we get real location
    zoom: 15,
    mapTypeControl: false,
    zoomControl: false,
    streetViewControl: false,
    fullscreenControl: false,
  });

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

  // Default to the user's location automatically on load.
  attemptLocate();

  map.addListener("click", (e) => {
    userLocation = { lat: e.latLng.lat(), lng: e.latLng.lng() };
    hideLocationButton();
    runSearch();
  });

  // Only offer to re-search once the user has actually panned away from
  // wherever the current results are centered on.
  map.addListener("dragend", () => {
    if (!userLocation || !searchAreaBtn) return;
    const center = map.getCenter();
    const moved = milesBetween(userLocation, { lat: center.lat(), lng: center.lng() });
    searchAreaBtn.hidden = moved < 0.3;
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

  searchAreaBtn = document.createElement("button");
  searchAreaBtn.type = "button";
  searchAreaBtn.className = "search-area-btn";
  searchAreaBtn.textContent = "Search this area";
  searchAreaBtn.hidden = true;
  searchAreaBtn.addEventListener("click", () => {
    const center = map.getCenter();
    userLocation = { lat: center.lat(), lng: center.lng() };
    hideLocationButton();
    runSearch();
  });
  map.controls[google.maps.ControlPosition.TOP_CENTER].push(searchAreaBtn);
}

function clearFilters() {
  document.getElementById("radius").value = "805";
  document.getElementById("minRating").value = "4";
  document.getElementById("openNow").checked = true;
  document.getElementById("zipInput").value = "";
  if (userLocation) runSearch();
}

function locateUser() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject({ code: 0 });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setCenter(userLocation);
        resolve();
      },
      (err) => reject(err),
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
      userLocation = loc;
      map.setCenter(loc);
      map.setZoom(14);
      setStatus("");
      runSearch();
    })
    .catch(() => {
      setStatus("Couldn't find that zip code — check it and try again.");
    });
}

// Asks for location access (the browser shows its own permission prompt) and
// uses the result once granted. Falls back to a retry button if access is
// denied or unavailable, so the user isn't stuck without a way to opt back in.
function attemptLocate() {
  hideLocationButton();
  setStatus("Finding your location…");
  return locateUser()
    .then(() => {
      setStatus("");
      runSearch();
    })
    .catch((err) => {
      if (err && err.code === 1) {
        setStatus("Location access denied — enable it for this site, then try again, or enter a zip code below.");
      } else if (err && err.code === 3) {
        setStatus("Location took too long to find — try again, or enter a zip code below.");
      } else {
        setStatus("Couldn't get your location — click the map to drop a pin, or enter a zip code below.");
      }
      showLocationButton();
    });
}

function showLocationButton() {
  document.getElementById("enableLocationBtn").hidden = false;
}

function hideLocationButton() {
  document.getElementById("enableLocationBtn").hidden = true;
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

async function runSearch() {
  if (!userLocation) {
    setStatus("Set a location first — allow location access or click the map.");
    return;
  }

  const radius = document.getElementById("radius").value;
  const minRating = document.getElementById("minRating").value;
  const openNow = document.getElementById("openNow").checked;

  setStatus("Finding good places…");
  document.getElementById("searchBtn").disabled = true;
  if (searchAreaBtn) searchAreaBtn.hidden = true;

  const url = `/.netlify/functions/search-restaurants?lat=${userLocation.lat}&lng=${userLocation.lng}&radius=${radius}&minRating=${minRating}&openNow=${openNow}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      setStatus(`Something went wrong: ${data.error || "unknown error"}`);
      return;
    }

    const matched = combineResults(data.results || [], userLocation);
    renderResults(matched, { fit: true });
    setStatus("");
    document.getElementById("resultsCount").textContent = `${matched.length} places found`;

    // Once the map settles on that view, layer in any curated notable spots
    // that happen to already be on screen — never ones outside it, so they
    // can't drag the zoom out wider than the actual search results need.
    google.maps.event.addListenerOnce(map, "idle", () => {
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
    });
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
    return { ...place, distance, isNotable: Boolean(notable), awards: notable ? notable.awards : [] };
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

function pinMarkerIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38">
    <path d="M15 0C6.716 0 0 6.716 0 15c0 10.5 15 23 15 23s15-12.5 15-23C30 6.716 23.284 0 15 0z" fill="#d1477a"/>
    <circle cx="15" cy="15" r="6.5" fill="#fff"/>
  </svg>`;
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(30, 38),
    anchor: new google.maps.Point(15, 38),
    labelOrigin: new google.maps.Point(15, 15),
  };
}

// Michelin/James Beard restaurants get a gold star instead of the standard
// pink pin, so they're unmistakable on the map at a glance.
function notableMarkerIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
    <path d="${STAR_PATH}" fill="#f0a020" stroke="#c97f0a" stroke-width="1.2" stroke-linejoin="round"/>
  </svg>`;
  return {
    url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(40, 40),
    anchor: new google.maps.Point(20, 20),
    labelOrigin: new google.maps.Point(20, 20),
  };
}

function awardBadgeText(award) {
  return award.type === "michelin"
    ? `MICHELIN ${"★".repeat(award.stars)}`
    : `JAMES BEARD · ${award.category} (${award.year})`;
}

function highlightMarker(id) {
  const marker = markersById.get(id);
  if (!marker) return;
  marker.setAnimation(google.maps.Animation.BOUNCE);
  setTimeout(() => marker.setAnimation(null), 700);
}

function renderResults(results, { fit = true } = {}) {
  clearMarkers();
  const list = document.getElementById("resultsList");
  list.innerHTML = "";

  results.forEach((place, i) => {
    // Marker
    const marker = new google.maps.Marker({
      position: { lat: place.lat, lng: place.lng },
      map,
      icon: place.isNotable ? notableMarkerIcon() : pinMarkerIcon(),
      label: {
        text: String(i + 1),
        color: place.isNotable ? "#3a2233" : "#d1477a",
        fontSize: "11px",
        fontWeight: "700",
      },
      title: place.name,
      zIndex: place.isNotable ? 999 : 1,
    });
    marker.addListener("click", () => scrollToCard(place.id));
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
    const badges = (place.awards || [])
      .map((a) => `<span class="award-badge">${escapeHtml(awardBadgeText(a))}</span>`)
      .join("");

    const badgeContent = place.isNotable
      ? `<svg class="badge-star" viewBox="0 0 40 40" aria-hidden="true"><path d="${STAR_PATH}" fill="currentColor"/></svg><span class="badge-num">${i + 1}</span>`
      : `${i + 1}`;

    li.innerHTML = `
      <span class="result-badge">${badgeContent}</span>
      <div class="result-body">
        <h3>${escapeHtml(place.name)}</h3>
        <div class="result-meta">
          <span>${place.distance.toFixed(1)} mi</span>
          ${place.rating != null ? `<span>· <span class="rating">★ ${place.rating.toFixed(1)}</span></span>` : ""}
          ${place.reviewCount != null ? `<span>(${place.reviewCount})</span>` : ""}
        </div>
        <div class="result-sub">
          ${priceStr ? `${priceStr} · ` : ""}${place.cuisine ? `${escapeHtml(place.cuisine)}` : ""}${place.cuisine && openStr ? " · " : ""}${openStr}
        </div>
        ${badges ? `<div class="award-badges">${badges}</div>` : ""}
      </div>
      ${place.mapsUrl ? `<button type="button" class="open-external-btn" title="Open in Google Maps" aria-label="Open in Google Maps">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </button>` : ""}
    `;
    li.addEventListener("click", () => {
      map.panTo({ lat: place.lat, lng: place.lng });
      map.setZoom(17);
      highlightMarker(place.id);
    });
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
  const bounds = new google.maps.LatLngBounds();
  if (userLocation) bounds.extend(userLocation);
  results.forEach((r) => bounds.extend({ lat: r.lat, lng: r.lng }));
  if (bounds.isEmpty()) return;

  map.fitBounds(bounds, 48);
  // fitBounds can over-zoom when everything is clustered close together
  // (or there's only one result) — cap it so we don't end up street-level.
  google.maps.event.addListenerOnce(map, "bounds_changed", () => {
    if (map.getZoom() > 17) map.setZoom(17);
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
