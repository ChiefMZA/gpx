"use strict";

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const EARTH_RADIUS_METERS = 6371008.8;
const EXACT_OPTIMIZATION_LIMIT = 14;

const elements = {
  parkName: document.querySelector("#park-name"),
  coordinates: document.querySelector("#coordinates"),
  lookupButton: document.querySelector("#lookup-button"),
  lookupNote: document.querySelector("#lookup-note"),
  importButton: document.querySelector("#import-button"),
  fileInput: document.querySelector("#file-input"),
  importNote: document.querySelector("#import-note"),
  clearButton: document.querySelector("#clear-button"),
  buildButton: document.querySelector("#build-button"),
  gpxButton: document.querySelector("#gpx-button"),
  imageButton: document.querySelector("#image-button"),
  mapAddButton: document.querySelector("#map-add-button"),
  mapAddHint: document.querySelector("#map-add-hint"),
  actions: document.querySelector("#actions"),
  status: document.querySelector("#status"),
  statusText: document.querySelector("#status-text"),
  emptyMap: document.querySelector("#empty-map"),
  footerName: document.querySelector("#footer-name"),
  footerLabel: document.querySelector("#footer-label"),
  footerPoints: document.querySelector("#footer-points"),
  footerDistance: document.querySelector("#footer-distance"),
};

let currentRoute = [];
let routeLayer = null;
let markerLayer = null;
let lookupTimer = null;
let lastLookupSignature = "";
let lookupRequestId = 0;
let mapAddMode = false;
let pendingMapPoints = [];

const map = L.map("map", { zoomControl: true, attributionControl: true }).setView([20, 0], 2);
L.tileLayer(TILE_URL, {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
  crossOrigin: true,
}).addTo(map);
const pendingMarkerLayer = L.layerGroup().addTo(map);

function parseCoordinates(text) {
  const points = [];
  const seen = new Set();
  let duplicates = 0;

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length !== 2 || parts.some((part) => part === "")) {
      throw new Error(`Line ${index + 1} must use latitude,longitude format.`);
    }
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`Line ${index + 1} contains a non-numeric value.`);
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error(`Line ${index + 1} is outside the valid latitude/longitude range.`);
    }
    const key = `${lat},${lon}`;
    if (seen.has(key)) {
      duplicates += 1;
      return;
    }
    seen.add(key);
    points.push({ lat, lon });
  });

  if (!points.length) throw new Error("Enter at least one coordinate.");
  return { points, duplicates };
}

function parseImportedFile(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("The selected file is empty.");

  if (trimmed.startsWith("<") || /<(?:\w+:)?gpx\b/i.test(trimmed)) {
    const documentNode = new DOMParser().parseFromString(trimmed, "application/xml");
    if (documentNode.querySelector("parsererror")) throw new Error("The file contains invalid GPX/XML.");
    const allElements = Array.from(documentNode.getElementsByTagName("*"));
    const pointElements = allElements.filter((element) => ["wpt", "rtept", "trkpt"].includes(element.localName));
    if (!pointElements.length) throw new Error("No GPX waypoints or track points were found.");
    const coordinateText = pointElements.map((element) => `${element.getAttribute("lat")},${element.getAttribute("lon")}`).join("\n");
    const parsed = parseCoordinates(coordinateText);
    const metadata = allElements.find((element) => element.localName === "metadata");
    const metadataName = metadata
      ? Array.from(metadata.children).find((element) => element.localName === "name")?.textContent?.trim() || ""
      : "";
    return { ...parsed, metadataName, kind: "GPX" };
  }

  return { ...parseCoordinates(trimmed), metadataName: "", kind: "TXT" };
}

function haversineMeters(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const dLat = lat2 - lat1;
  const dLon = radians(b.lon - a.lon);
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(value)));
}

function routeDistance(route) {
  let total = 0;
  for (let index = 1; index < route.length; index += 1) {
    total += haversineMeters(route[index - 1], route[index]);
  }
  return total;
}

function distanceMatrix(points) {
  return points.map((a) => points.map((b) => haversineMeters(a, b)));
}

function routeDistanceIndexes(route, distances) {
  let total = 0;
  for (let index = 1; index < route.length; index += 1) {
    total += distances[route[index - 1]][route[index]];
  }
  return total;
}

function exactOpenRoute(distances) {
  const count = distances.length;
  const stateCount = 1 << count;
  const costs = new Float64Array(stateCount * count);
  costs.fill(Infinity);
  const parents = new Int16Array(stateCount * count);
  parents.fill(-2);

  for (let point = 0; point < count; point += 1) {
    const offset = (1 << point) * count + point;
    costs[offset] = 0;
    parents[offset] = -1;
  }

  for (let mask = 1; mask < stateCount; mask += 1) {
    for (let last = 0; last < count; last += 1) {
      const currentCost = costs[mask * count + last];
      if (!Number.isFinite(currentCost)) continue;
      for (let next = 0; next < count; next += 1) {
        const bit = 1 << next;
        if (mask & bit) continue;
        const nextMask = mask | bit;
        const newCost = currentCost + distances[last][next];
        const offset = nextMask * count + next;
        if (newCost < costs[offset]) {
          costs[offset] = newCost;
          parents[offset] = last;
        }
      }
    }
  }

  const fullMask = stateCount - 1;
  let last = 0;
  for (let point = 1; point < count; point += 1) {
    if (costs[fullMask * count + point] < costs[fullMask * count + last]) last = point;
  }
  const reversed = [];
  let mask = fullMask;
  while (last !== -1) {
    reversed.push(last);
    const previous = parents[mask * count + last];
    mask ^= 1 << last;
    last = previous;
  }
  return reversed.reverse();
}

function nearestNeighbor(distances, startIndex) {
  const remaining = new Set(distances.map((_, index) => index));
  remaining.delete(startIndex);
  const route = [startIndex];
  while (remaining.size) {
    const last = route[route.length - 1];
    let next = null;
    let best = Infinity;
    remaining.forEach((candidate) => {
      const distance = distances[last][candidate];
      if (distance < best) {
        best = distance;
        next = candidate;
      }
    });
    route.push(next);
    remaining.delete(next);
  }
  return route;
}

function cheapestInsertion(distances, startIndex, farthestFirst) {
  const remaining = new Set(distances.map((_, index) => index));
  remaining.delete(startIndex);
  let first = null;
  remaining.forEach((candidate) => {
    if (first === null || (farthestFirst
      ? distances[startIndex][candidate] > distances[startIndex][first]
      : distances[startIndex][candidate] < distances[startIndex][first])) first = candidate;
  });
  const route = [startIndex, first];
  remaining.delete(first);
  while (remaining.size) {
    let best = null;
    remaining.forEach((point) => {
      for (let after = 0; after < route.length; after += 1) {
        let delta = distances[route[after]][point];
        if (after + 1 < route.length) {
          delta += distances[point][route[after + 1]] - distances[route[after]][route[after + 1]];
        }
        if (!best || delta < best.delta) best = { delta, point, after };
      }
    });
    route.splice(best.after + 1, 0, best.point);
    remaining.delete(best.point);
  }
  return route;
}

function improveTwoOpt(route, distances) {
  let anyChange = false;
  let improved = true;
  while (improved) {
    improved = false;
    for (let first = 0; first < route.length - 1; first += 1) {
      for (let last = first + 1; last < route.length; last += 1) {
        let oldDistance = 0;
        let newDistance = 0;
        if (first > 0) {
          oldDistance += distances[route[first - 1]][route[first]];
          newDistance += distances[route[first - 1]][route[last]];
        }
        if (last + 1 < route.length) {
          oldDistance += distances[route[last]][route[last + 1]];
          newDistance += distances[route[first]][route[last + 1]];
        }
        if (newDistance + 0.000001 < oldDistance) {
          route.splice(first, last - first + 1, ...route.slice(first, last + 1).reverse());
          improved = true;
          anyChange = true;
        }
      }
    }
  }
  return anyChange;
}

function relocatePoints(route, distances) {
  let anyChange = false;
  while (true) {
    let bestDelta = 0;
    let bestMove = null;
    for (let index = 0; index < route.length; index += 1) {
      const point = route[index];
      const reduced = route.slice(0, index).concat(route.slice(index + 1));
      let removalDelta;
      if (index === 0) removalDelta = -distances[point][route[1]];
      else if (index + 1 === route.length) removalDelta = -distances[route[index - 1]][point];
      else {
        removalDelta = distances[route[index - 1]][route[index + 1]]
          - distances[route[index - 1]][point] - distances[point][route[index + 1]];
      }
      for (let slot = 0; slot <= reduced.length; slot += 1) {
        let insertionDelta;
        if (slot === 0) insertionDelta = distances[point][reduced[0]];
        else if (slot === reduced.length) insertionDelta = distances[reduced[reduced.length - 1]][point];
        else {
          insertionDelta = distances[reduced[slot - 1]][point] + distances[point][reduced[slot]]
            - distances[reduced[slot - 1]][reduced[slot]];
        }
        const delta = removalDelta + insertionDelta;
        if (delta + 1e-9 < bestDelta) {
          bestDelta = delta;
          bestMove = { index, slot };
        }
      }
    }
    if (!bestMove) return anyChange;
    const [point] = route.splice(bestMove.index, 1);
    route.splice(bestMove.slot, 0, point);
    anyChange = true;
  }
}

function improveRoute(candidate, distances) {
  const route = [...candidate];
  while (true) {
    improveTwoOpt(route, distances);
    if (!relocatePoints(route, distances)) return route;
  }
}

function bestHeuristicOpenRoute(distances) {
  const nearest = distances.map((_, start) => nearestNeighbor(distances, start));
  nearest.sort((a, b) => routeDistanceIndexes(a, distances) - routeDistanceIndexes(b, distances));
  const candidates = nearest.slice(0, Math.min(24, nearest.length));
  const starts = [];
  candidates.slice(0, 8).forEach((route) => {
    [route[0], route[route.length - 1]].forEach((point) => {
      if (!starts.includes(point)) starts.push(point);
    });
  });
  starts.forEach((start) => {
    candidates.push(cheapestInsertion(distances, start, false));
    candidates.push(cheapestInsertion(distances, start, true));
  });
  const improved = candidates.map((route) => improveRoute(route, distances));
  return improved.reduce((best, route) => routeDistanceIndexes(route, distances) < routeDistanceIndexes(best, distances) ? route : best);
}

function optimizeRoute(points) {
  if (points.length < 3) return [...points];
  const distances = distanceMatrix(points);
  const indexes = points.length <= EXACT_OPTIMIZATION_LIMIT
    ? exactOpenRoute(distances)
    : bestHeuristicOpenRoute(distances);
  return indexes.map((index) => points[index]);
}

function showStatus(message, error = false) {
  elements.statusText.textContent = message;
  elements.status.classList.toggle("error", error);
}

function getInputPoints() {
  try {
    return parseCoordinates(elements.coordinates.value);
  } catch (error) {
    showStatus(error.message, true);
    throw error;
  }
}

function updateFooter() {
  elements.footerName.textContent = elements.parkName.value.trim() || "Unnamed route";
  elements.footerPoints.textContent = String(currentRoute.length);
  elements.footerDistance.textContent = (routeDistance(currentRoute) / 1000).toFixed(2);
}

function setMapAddMode(active) {
  mapAddMode = active && !elements.mapAddButton.hidden;
  elements.mapAddButton.classList.toggle("is-active", mapAddMode);
  elements.mapAddButton.textContent = mapAddMode ? "✓ Finish adding" : "＋ Add points";
  map.getContainer().classList.toggle("map-add-active", mapAddMode);
  elements.mapAddHint.hidden = !mapAddMode;
  if (mapAddMode) showStatus("Click anywhere on the map to add one or more points.");
}

function drawPendingMapPoints() {
  pendingMarkerLayer.clearLayers();
  pendingMapPoints.forEach((point, index) => {
    const formatted = `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`;
    const marker = L.circleMarker([point.lat, point.lon], {
      radius: 8,
      color: "#20202a",
      weight: 2,
      fillColor: "#c9f75d",
      fillOpacity: 1,
      bubblingMouseEvents: false,
    }).bindTooltip(`New point ${index + 1}<br>${formatted}<br>Click to remove`);
    marker.on("click", () => {
      if (mapAddMode) showRemovePointPopup(point);
    });
    marker.addTo(pendingMarkerLayer);
  });
}

function clearPendingMapPoints() {
  pendingMapPoints = [];
  pendingMarkerLayer.clearLayers();
}

function showRemovePointPopup(point) {
  if (!mapAddMode) return;
  const content = document.createElement("div");
  content.className = "remove-point-popup";
  const label = document.createElement("span");
  label.textContent = `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "× Remove point";
  button.addEventListener("click", () => removeCoordinatePoint(point));
  content.append(label, button);
  L.popup({ closeButton: true, offset: [0, -8] })
    .setLatLng([point.lat, point.lon])
    .setContent(content)
    .openOn(map);
}

function removeCoordinatePoint(point) {
  let parsed;
  try {
    parsed = parseCoordinates(elements.coordinates.value);
  } catch (_) {
    return;
  }
  const removeIndex = parsed.points.findIndex((existing) => haversineMeters(existing, point) < 1);
  if (removeIndex < 0) return;
  if (parsed.points.length === 1) {
    showStatus("Keep at least one point in the route.", true);
    return;
  }
  parsed.points.splice(removeIndex, 1);
  elements.coordinates.value = parsed.points.map((item) => `${formatNumber(item.lat)},${formatNumber(item.lon)}`).join("\n");
  pendingMapPoints = pendingMapPoints.filter((item) => haversineMeters(item, point) >= 1);
  currentRoute = currentRoute.filter((item) => haversineMeters(item, point) >= 1);
  drawPendingMapPoints();
  if (currentRoute.length) drawRoute();
  map.closePopup();
  elements.actions.hidden = true;
  elements.footerLabel.textContent = "REBUILD NEEDED";
  elements.footerPoints.textContent = String(parsed.points.length);
  elements.footerDistance.textContent = "—";
  showStatus("Point removed. Finish adding to rebuild the optimized route.");
}

function addPointFromMap(event) {
  if (!mapAddMode || !currentRoute.length) return;
  const point = { lat: event.latlng.lat, lon: event.latlng.lng };
  let parsed;
  try {
    parsed = parseCoordinates(elements.coordinates.value);
  } catch (_) {
    return;
  }
  if (parsed.points.some((existing) => haversineMeters(existing, point) < 1)) {
    showStatus("That point is already in the coordinate list.");
    return;
  }

  const formatted = `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`;
  elements.coordinates.value = `${elements.coordinates.value.trim()}\n${formatted}`.trim();
  pendingMapPoints.push(point);
  drawPendingMapPoints();

  elements.actions.hidden = true;
  elements.footerLabel.textContent = "REBUILD NEEDED";
  elements.footerPoints.textContent = String(parsed.points.length + 1);
  elements.footerDistance.textContent = "—";
  showStatus(`${pendingMapPoints.length} map point${pendingMapPoints.length === 1 ? "" : "s"} added. Rebuild to optimize the full route.`);
}

function invalidateRoute(message = "") {
  const hadBuiltRoute = currentRoute.length > 0 || !elements.actions.hidden;
  currentRoute = [];
  elements.actions.hidden = true;
  setMapAddMode(false);
  elements.mapAddButton.hidden = true;
  clearPendingMapPoints();
  if (routeLayer) routeLayer.remove();
  if (markerLayer) markerLayer.remove();
  routeLayer = null;
  markerLayer = null;
  elements.emptyMap.hidden = false;
  elements.footerLabel.textContent = "ROUTE READY";
  updateFooter();
  if (message && hadBuiltRoute) showStatus(message);
}

function drawRoute() {
  if (routeLayer) routeLayer.remove();
  if (markerLayer) markerLayer.remove();

  const latLngs = currentRoute.map((point) => [point.lat, point.lon]);
  routeLayer = L.polyline(latLngs, { color: "#f24a2e", weight: 5, opacity: 0.95 }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  const icon = L.divIcon({
    className: "route-marker",
    html: '<div class="route-pin"></div>',
    iconSize: [22, 29],
    iconAnchor: [11, 27],
  });
  currentRoute.forEach((point, index) => {
    const marker = L.marker([point.lat, point.lon], { icon, bubblingMouseEvents: false })
      .bindTooltip(`Point ${index + 1}<br>${point.lat}, ${point.lon}${mapAddMode ? "<br>Click to remove" : ""}`);
    marker.on("click", () => {
      if (mapAddMode) showRemovePointPopup(point);
    });
    marker.addTo(markerLayer);
  });
  if (currentRoute.length === 1) map.setView(latLngs[0], 17);
  else map.fitBounds(routeLayer.getBounds(), { padding: [45, 45], maxZoom: 17 });
  elements.emptyMap.hidden = true;
  setTimeout(() => map.invalidateSize(), 0);
}

function buildRoute() {
  let parsed;
  try {
    parsed = getInputPoints();
  } catch (_) {
    return;
  }
  currentRoute = optimizeRoute(parsed.points);
  clearPendingMapPoints();
  drawRoute();
  updateFooter();
  elements.footerLabel.textContent = "ROUTE READY";
  elements.actions.hidden = false;
  elements.mapAddButton.hidden = false;
  setMapAddMode(false);
  const duplicateText = parsed.duplicates ? ` ${parsed.duplicates} duplicate(s) removed.` : "";
  showStatus(`Route ready: ${currentRoute.length} points, ${(routeDistance(currentRoute) / 1000).toFixed(2)} km.${duplicateText}`);
}

function parkNameFromResult(result) {
  const address = result.address || {};
  const parkName = [
    address.park, address.nature_reserve, address.garden, address.recreation_ground,
    address.leisure, result.name, result.namedetails?.name,
    address.neighbourhood, address.suburb, address.city_district,
  ].find(Boolean);
  if (!parkName) return "";

  const state = address.state || address.province || address.region || "";
  const city = address.city || address.town || address.municipality || address.village || "";
  const isTokyo = /(^|[\s,])tokyo([\s,]|$)/i.test(`${state},${result.display_name || ""}`);
  const parts = [parkName];
  if (isTokyo) parts.push(/tokyo/i.test(state) ? state : "Tokyo");
  else {
    if (state) parts.push(state);
    else if (city) parts.push(city);
  }
  if (address.country) parts.push(address.country);
  return parts.filter((part, index) => parts.findIndex((value) => value.toLowerCase() === part.toLowerCase()) === index).join(", ");
}

async function lookupParkName(force = false, suppliedPoints = null) {
  let points;
  if (suppliedPoints) points = suppliedPoints;
  else {
    try {
      ({ points } = getInputPoints());
    } catch (_) {
      return;
    }
  }
  const signature = points.map((point) => `${point.lat},${point.lon}`).join("|");
  if (!force && signature === lastLookupSignature) return;
  lastLookupSignature = signature;
  const requestId = ++lookupRequestId;
  const center = points.reduce((sum, point) => ({ lat: sum.lat + point.lat, lon: sum.lon + point.lon }), { lat: 0, lon: 0 });
  center.lat /= points.length;
  center.lon /= points.length;
  const nearest = points.reduce((best, point) => haversineMeters(point, center) < haversineMeters(best, center) ? point : best);

  elements.lookupButton.disabled = true;
  elements.lookupButton.textContent = "…";
  elements.lookupNote.classList.remove("error");
  elements.lookupNote.textContent = "Checking OpenStreetMap near the middle of the route…";
  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.search = new URLSearchParams({
      format: "jsonv2",
      lat: String(nearest.lat),
      lon: String(nearest.lon),
      zoom: "17",
      addressdetails: "1",
      namedetails: "1",
      "accept-language": "en",
    });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Lookup failed (${response.status}).`);
    const result = await response.json();
    if (requestId !== lookupRequestId) return;
    const suggestedName = parkNameFromResult(result);
    if (!suggestedName) throw new Error("No named place was found near these coordinates.");
    elements.parkName.value = suggestedName;
    updateFooter();
    elements.lookupNote.textContent = `Suggested from OpenStreetMap: ${suggestedName}. Edit it if needed.`;
  } catch (error) {
    if (requestId === lookupRequestId) {
      elements.lookupNote.textContent = `${error.message} You can enter the park name manually.`;
      elements.lookupNote.classList.add("error");
    }
  } finally {
    if (requestId === lookupRequestId) {
      elements.lookupButton.disabled = false;
      elements.lookupButton.textContent = "↻";
    }
  }
}

async function importCoordinateFile(file) {
  clearTimeout(lookupTimer);
  lookupRequestId += 1;
  elements.lookupButton.disabled = false;
  elements.lookupButton.textContent = "↻";
  elements.importNote.classList.remove("error");
  elements.importNote.textContent = `Reading ${file.name}…`;
  try {
    const imported = parseImportedFile(await file.text());
    const filenameName = parkNameFromFilename(file.name);
    const importedName = imported.metadataName || filenameName;
    elements.coordinates.value = imported.points.map((point) => `${point.lat},${point.lon}`).join("\n");
    elements.parkName.value = importedName;
    lastLookupSignature = "";
    invalidateRoute();
    updateFooter();
    const duplicateText = imported.duplicates ? ` ${imported.duplicates} duplicate(s) removed.` : "";
    elements.importNote.textContent = `${imported.kind} imported: ${imported.points.length} coordinates.${duplicateText}`;
    showStatus(`${file.name} is ready. Build the route.`);
    if (importedName) {
      elements.lookupNote.classList.remove("error");
      elements.lookupNote.textContent = imported.metadataName
        ? `Name imported from GPX metadata: ${importedName}.`
        : `Name inferred from the file: ${importedName}.`;
    } else {
      elements.lookupNote.textContent = "Finding a name near the imported coordinates…";
      lookupParkName(false, imported.points);
    }
  } catch (error) {
    elements.importNote.textContent = error.message;
    elements.importNote.classList.add("error");
    showStatus("Could not import that file.", true);
  } finally {
    elements.fileInput.value = "";
  }
}

function parkNameFromFilename(filename) {
  const base = filename.replace(/\.(?:gpx|txt)$/i, "").trim();
  const parts = base.split(/__+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return "";
  const park = parts[0];
  const country = parts[parts.length - 1];
  const locationParts = parts.slice(1, -1).join(", ").split(",").map((part) => part.trim()).filter(Boolean);
  let region = locationParts[locationParts.length - 1] || "";
  if (/^canada$/i.test(country)) {
    region = ({
      AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
      NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories",
      NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec",
      SK: "Saskatchewan", YT: "Yukon",
    })[region.toUpperCase()] || region;
  }
  return [park, region, country].filter(Boolean).join(", ");
}

function escapeXml(value) {
  return value.replace(/[<>&'\"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  })[character]);
}

function safeFilename(value, extension) {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/[. ]+$/, "");
  return `${cleaned || "route"}.${extension}`;
}

function formatNumber(value) {
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function createGpx(name, route) {
  const safeName = escapeXml(name);
  const waypoints = route.map((point) => `<wpt lat="${formatNumber(point.lat)}" lon="${formatNumber(point.lon)}"></wpt>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<gpx version="1.1" creator="https://discord.gg/GdAaWg4" xmlns="http://www.topografix.com/GPX/1/1">
<metadata>
    <name>${safeName}</name>
    <author>
        <name>Pokehub</name>
        <link href="https://discord.gg/GdAaWg4"></link>
    </author>
</metadata>
${waypoints}
</gpx>
`;
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function downloadGpx() {
  if (!currentRoute.length) return;
  const name = elements.parkName.value.trim() || "Unnamed route";
  downloadBlob(new Blob([createGpx(name, currentRoute)], { type: "application/gpx+xml" }), safeFilename(name, "gpx"));
  showStatus("GPX downloaded.");
}

function worldPoint(point, zoom) {
  const scale = 256 * 2 ** zoom;
  const sinLat = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, point.lat)) * Math.PI / 180);
  return {
    x: (point.lon + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  };
}

function exportView(route, width, height) {
  const footerHeight = 104;
  const mapHeight = height - footerHeight;
  const padding = 42;
  const base = route.map((point) => worldPoint(point, 0));
  const minX = Math.min(...base.map((point) => point.x));
  const maxX = Math.max(...base.map((point) => point.x));
  const minY = Math.min(...base.map((point) => point.y));
  const maxY = Math.max(...base.map((point) => point.y));
  const routeWidth = maxX - minX;
  const routeHeight = maxY - minY;
  const scale = routeWidth < 0.000001 && routeHeight < 0.000001
    ? 2 ** 17
    : Math.min((width - padding * 2) / Math.max(routeWidth, 0.000001), (mapHeight - padding * 2) / Math.max(routeHeight, 0.000001));
  const zoom = Math.max(1, Math.min(18, Math.log2(scale)));
  const zoomScale = 2 ** zoom;
  return {
    zoom,
    centerX: (minX + maxX) / 2 * zoomScale,
    centerY: (minY + maxY) / 2 * zoomScale,
    mapHeight,
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

async function drawTiles(context, view, width) {
  const left = view.centerX - width / 2;
  const top = view.centerY - view.mapHeight / 2;
  const tileZoom = Math.floor(view.zoom);
  const tileScale = 2 ** (view.zoom - tileZoom);
  const tileSize = 256 * tileScale;
  const firstX = Math.floor(left / tileSize);
  const lastX = Math.floor((left + width) / tileSize);
  const firstY = Math.floor(top / tileSize);
  const lastY = Math.floor((top + view.mapHeight) / tileSize);
  const tileCount = 2 ** tileZoom;
  const jobs = [];
  for (let tileY = firstY; tileY <= lastY; tileY += 1) {
    for (let tileX = firstX; tileX <= lastX; tileX += 1) {
      if (tileY < 0 || tileY >= tileCount) continue;
      const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
      const url = TILE_URL.replace("{z}", tileZoom).replace("{x}", wrappedX).replace("{y}", tileY);
      jobs.push(loadImage(url).then((image) => {
        context.drawImage(image, tileX * tileSize - left, tileY * tileSize - top, tileSize, tileSize);
      }));
    }
  }
  await Promise.all(jobs);
}

function drawPin(context, x, y) {
  context.save();
  context.translate(x, y);
  context.beginPath();
  context.arc(0, -10, 10, Math.PI * 0.12, Math.PI * 0.88, true);
  context.lineTo(0, 8);
  context.closePath();
  context.fillStyle = "#2eacd2";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#ffffff";
  context.stroke();
  context.beginPath();
  context.arc(0, -10, 3.5, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.restore();
}

async function downloadMapImage() {
  if (!currentRoute.length) return;
  const name = elements.parkName.value.trim() || "Unnamed route";
  const width = 1200;
  const height = 800;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const view = exportView(currentRoute, width, height);
  elements.imageButton.disabled = true;
  elements.imageButton.textContent = "Rendering…";
  showStatus("Rendering map image…");
  try {
    context.fillStyle = "#e6ece8";
    context.fillRect(0, 0, width, view.mapHeight);
    await drawTiles(context, view, width);
    const left = view.centerX - width / 2;
    const top = view.centerY - view.mapHeight / 2;
    const canvasPoints = currentRoute.map((point) => {
      const projected = worldPoint(point, view.zoom);
      return { x: projected.x - left, y: projected.y - top };
    });

    if (canvasPoints.length > 1) {
      context.beginPath();
      canvasPoints.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      context.lineJoin = "round";
      context.lineCap = "round";
      context.strokeStyle = "rgba(255,255,255,.9)";
      context.lineWidth = 11;
      context.stroke();
      context.strokeStyle = "#f24a2e";
      context.lineWidth = 6;
      context.stroke();
    }
    canvasPoints.forEach((point) => drawPin(context, point.x, point.y));

    context.fillStyle = "#14212b";
    context.fillRect(0, view.mapHeight, width, height - view.mapHeight);
    context.fillStyle = "#c9f75d";
    context.font = "800 13px system-ui, sans-serif";
    context.fillText("PARK / ROUTE", 36, view.mapHeight + 31);
    context.fillStyle = "#ffffff";
    context.font = "700 25px system-ui, sans-serif";
    context.save();
    context.beginPath();
    context.rect(36, view.mapHeight + 38, 700, 42);
    context.clip();
    context.fillText(name, 36, view.mapHeight + 70);
    context.restore();
    context.textAlign = "right";
    context.font = "700 25px system-ui, sans-serif";
    context.fillText(`${currentRoute.length} points   •   ${(routeDistance(currentRoute) / 1000).toFixed(2)} km`, width - 36, view.mapHeight + 57);
    context.font = '800 14px "Arial Rounded MT Bold", system-ui, sans-serif';
    const credit = "Tool created by chiefmza";
    const creditWidth = context.measureText(credit).width + 20;
    const creditX = width - 36 - creditWidth;
    context.beginPath();
    context.roundRect(creditX, view.mapHeight + 65, creditWidth, 27, [9, 9, 3, 9]);
    context.fillStyle = "#c9f75d";
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = "#20202a";
    context.stroke();
    context.fillStyle = "#20202a";
    context.fillText(credit, width - 46, view.mapHeight + 84);
    context.textAlign = "left";
    context.fillStyle = "#fffefb";
    context.font = "11px system-ui, sans-serif";
    context.fillText("Map © OpenStreetMap contributors", 36, view.mapHeight + 89);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The browser could not create the PNG.");
    downloadBlob(blob, safeFilename(name, "png"));
    showStatus("Map PNG downloaded.");
  } catch (error) {
    showStatus(`${error.message} Try again, or check the internet connection.`, true);
  } finally {
    elements.imageButton.disabled = false;
    elements.imageButton.textContent = "Download map PNG";
  }
}

elements.buildButton.addEventListener("click", buildRoute);
elements.mapAddButton.addEventListener("click", () => {
  if (mapAddMode) {
    setMapAddMode(false);
    buildRoute();
  } else {
    setMapAddMode(true);
  }
});
map.on("click", addPointFromMap);
elements.lookupButton.addEventListener("click", () => lookupParkName(true));
elements.importButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
  const [file] = elements.fileInput.files;
  if (file) importCoordinateFile(file);
});
elements.gpxButton.addEventListener("click", downloadGpx);
elements.imageButton.addEventListener("click", downloadMapImage);
elements.parkName.addEventListener("input", updateFooter);
elements.coordinates.addEventListener("input", () => {
  invalidateRoute("Coordinates changed. Build the route again.");
  elements.parkName.value = "";
  updateFooter();
  lastLookupSignature = "";
  elements.importNote.classList.remove("error");
  elements.importNote.innerHTML = "Paste <code>lat,lon</code> lines or import a GPX/TXT file.";
  elements.lookupNote.classList.remove("error");
  elements.lookupNote.textContent = "Waiting for a valid coordinate list…";
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(() => {
    try {
      const { points } = parseCoordinates(elements.coordinates.value);
      lookupParkName(false, points);
    } catch (_) {}
  }, 650);
});
elements.clearButton.addEventListener("click", () => {
  elements.coordinates.value = "";
  elements.parkName.value = "";
  lastLookupSignature = "";
  invalidateRoute("Coordinates cleared. Add new points to continue.");
  elements.importNote.innerHTML = "Paste <code>lat,lon</code> lines or import a GPX/TXT file.";
  elements.lookupNote.textContent = "The suggested name stays editable.";
  elements.coordinates.focus();
  showStatus("Coordinates cleared.");
});

window.GpxRouteCreator = {
  parseCoordinates, parseImportedFile, haversineMeters, routeDistance, optimizeRoute,
  parkNameFromResult, safeFilename, createGpx, exportView,
};
