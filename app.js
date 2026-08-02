// app.js — runs in the browser. No API keys live here except the
// restricted, referrer-locked Maps JavaScript key loaded via <script> tag.

let map;
let markers = [];
let userLocation = null;

// Called by the Google Maps script tag once it loads.
function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 40.7128, lng: -74.006 }, // fallback: NYC, replaced once we get real location
    zoom: 14,
  });

  document.getElementById("searchBtn").addEventListener("click", runSearch);

  // Try to get the user's location automatically on load.
  locateUser().then(() => runSearch()).catch(() => {
    setStatus("Couldn't get your location — click the map to drop a pin, or allow location access.");
  });

  map.addListener("click", (e) => {
    userLocation = { lat: e.latLng.lat(), lng: e.latLng.lng() };
    runSearch();
  });
}

function locateUser() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setCenter(userLocation);
        resolve();
      },
      () => reject(),
      { timeout: 8000 }
    );
  });
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

  const url = `/.netlify/functions/search-restaurants?lat=${userLocation.lat}&lng=${userLocation.lng}&radius=${radius}&minRating=${minRating}&openNow=${openNow}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      setStatus(`Something went wrong: ${data.error || "unknown error"}`);
      return;
    }

    renderResults(data.results || []);
    setStatus(`${data.results.length} places found.`);
  } catch (err) {
    setStatus("Network error — try again.");
  } finally {
    document.getElementById("searchBtn").disabled = false;
  }
}

function clearMarkers() {
  markers.forEach((m) => m.setMap(null));
  markers = [];
}

function renderResults(results) {
  clearMarkers();
  const list = document.getElementById("resultsList");
  list.innerHTML = "";

  results.forEach((place, i) => {
    // Marker
    const marker = new google.maps.Marker({
      position: { lat: place.lat, lng: place.lng },
      map,
      label: String(i + 1),
      title: place.name,
    });
    markers.push(marker);

    // List card
    const li = document.createElement("li");
    li.className = "result-card";
    const priceStr = place.priceLevel ? "$".repeat(priceLevelToNumber(place.priceLevel)) : "";
    const openStr =
      place.openNow === true
        ? '<span class="open-badge">Open now</span>'
        : place.openNow === false
        ? '<span class="closed-badge">Closed</span>'
        : "";

    li.innerHTML = `
      <h3>${i + 1}. ${escapeHtml(place.name)}</h3>
      <div class="result-meta">
        <span class="rating">★ ${place.rating.toFixed(1)}</span>
        <span>(${place.reviewCount} reviews)</span>
        ${priceStr ? `<span>${priceStr}</span>` : ""}
        ${place.cuisine ? `<span>${escapeHtml(place.cuisine)}</span>` : ""}
        ${openStr}
      </div>
    `;
    li.addEventListener("click", () => {
      map.panTo({ lat: place.lat, lng: place.lng });
      map.setZoom(17);
      window.open(place.mapsUrl, "_blank");
    });
    list.appendChild(li);
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
