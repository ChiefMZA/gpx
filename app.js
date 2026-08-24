"use strict";

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const EARTH_RADIUS_METERS = 6371008.8;
const EXACT_OPTIMIZATION_LIMIT = 14;
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const elements = {
  parkName: document.querySelector("#park-name"),
  coordinates: document.querySelector("#coordinates"),
  lookupButton: document.querySelector("#lookup-button"),
  lookupNote: document.querySelector("#lookup-note"),
  importButton: document.querySelector("#import-button"),
  fileInput: document.querySelector("#file-input"),
  importNote: document.querySelector("#import-note"),
  clearButton: document.querySelector("#clear-button"),
  boundaryTools: document.querySelector("#boundary-tools"),
  editOsmBoundary: document.querySelector("#edit-osm-boundary"),
  resetOsmBoundary: document.querySelector("#reset-osm-boundary"),
  buildButton: document.querySelector("#build-button"),
  gpxButton: document.querySelector("#gpx-button"),
  txtButton: document.querySelector("#txt-button"),
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
let inputMarkerLayer = null;
let inputPreviewPoints = [];
let lookupTimer = null;
let lastLookupSignature = "";
let lookupRequestId = 0;
let mapAddMode = false;
let pendingMapPoints = [];
let osmBoundaryOriginal = [];
let osmBoundaryPolygons = [];
let osmBoundaryLayer = null;
let osmBoundaryHandleLayer = null;
let osmBoundaryEditMode = false;
let osmBoundaryEdited = false;
let osmBoundaryMetadata = null;
const containingParkCache = new Map();

const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([20, 0], 2);
L.control.zoom({ position: "bottomleft" }).addTo(map);
L.tileLayer(TILE_URL, {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
  crossOrigin: true,
}).addTo(map);
const pendingMarkerLayer = L.layerGroup().addTo(map);

function pointInsidePolygon(point, vertices) {
  let inside = false;
  for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index, index += 1) {
    const a = vertices[index];
    const b = vertices[previous];
    const crosses = ((a.lat > point.lat) !== (b.lat > point.lat))
      && point.lon < (b.lon - a.lon) * (point.lat - a.lat) / (b.lat - a.lat) + a.lon;
    if (crosses) inside = !inside;
  }
  return inside;
}

function geoJsonToBoundaryPolygons(geometry) {
  if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) return [];
  const source = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return source.map((polygon) => polygon.map((ring) => ring
    .map((coordinate) => ({ lon: Number(coordinate[0]), lat: Number(coordinate[1]) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon)))
    .filter((ring) => ring.length >= 4)).filter((polygon) => polygon.length);
}

function cloneBoundaryPolygons(polygons) {
  return polygons.map((polygon) => polygon.map((ring) => ring.map((point) => ({ ...point }))));
}

function flattenBoundaryPoints(polygons = osmBoundaryPolygons) {
  return polygons.flatMap((polygon) => polygon.flatMap((ring) => ring));
}

function pointInsideBoundary(point, polygons = osmBoundaryPolygons) {
  return polygons.some((polygon) => {
    if (!polygon.length || !pointInsidePolygon(point, polygon[0])) return false;
    return !polygon.slice(1).some((hole) => pointInsidePolygon(point, hole));
  });
}

function boundaryBounds(polygons) {
  const points = flattenBoundaryPoints(polygons);
  if (!points.length) return null;
  return {
    minLat: Math.min(...points.map((point) => point.lat)),
    maxLat: Math.max(...points.map((point) => point.lat)),
    minLon: Math.min(...points.map((point) => point.lon)),
    maxLon: Math.max(...points.map((point) => point.lon)),
  };
}

function boundaryToGeoJson(polygons = osmBoundaryPolygons) {
  const coordinates = polygons.map((polygon) => polygon.map((ring) => ring.map((point) => [point.lon, point.lat])));
  return polygons.length === 1
    ? { type: "Polygon", coordinates: coordinates[0] }
    : { type: "MultiPolygon", coordinates };
}

function removeOsmBoundaryHandles() {
  if (osmBoundaryHandleLayer) osmBoundaryHandleLayer.remove();
  osmBoundaryHandleLayer = null;
}

function updateOsmBoundaryControls() {
  const available = osmBoundaryPolygons.length > 0;
  elements.boundaryTools.hidden = !available;
  elements.editOsmBoundary.textContent = osmBoundaryEditMode ? "✓ Finish editing" : "Edit OSM boundary";
  elements.resetOsmBoundary.hidden = !available || !osmBoundaryEdited || osmBoundaryEditMode;
}

function drawOsmBoundary() {
  if (osmBoundaryLayer) osmBoundaryLayer.remove();
  osmBoundaryLayer = null;
  if (!osmBoundaryPolygons.length) return;
  osmBoundaryLayer = L.geoJSON(boundaryToGeoJson(), {
    interactive: false,
    style: { color: "#5b52ff", weight: 4, opacity: 0.95, fillColor: "#6c63ff", fillOpacity: 0.09 },
  }).addTo(map);
  if (routeLayer) routeLayer.bringToFront();
  if (markerLayer) markerLayer.eachLayer((layer) => layer.bringToFront?.());
}

function finishOsmBoundaryEditing() {
  if (!osmBoundaryEditMode) return;
  osmBoundaryEditMode = false;
  removeOsmBoundaryHandles();
  map.getContainer().classList.remove("osm-boundary-edit-active");
  elements.mapAddHint.hidden = true;
  updateOsmBoundaryControls();
  showStatus("Boundary editing finished. The adjusted boundary will be used in the PNG.");
}

function setOsmBoundary(polygons, metadata = null) {
  finishOsmBoundaryEditing();
  osmBoundaryOriginal = cloneBoundaryPolygons(polygons);
  osmBoundaryPolygons = cloneBoundaryPolygons(polygons);
  osmBoundaryEdited = false;
  osmBoundaryMetadata = metadata;
  drawOsmBoundary();
  updateOsmBoundaryControls();
}

function clearOsmBoundary() {
  finishOsmBoundaryEditing();
  osmBoundaryOriginal = [];
  osmBoundaryPolygons = [];
  osmBoundaryEdited = false;
  osmBoundaryMetadata = null;
  if (osmBoundaryLayer) osmBoundaryLayer.remove();
  osmBoundaryLayer = null;
  updateOsmBoundaryControls();
}

function drawOsmBoundaryHandles() {
  removeOsmBoundaryHandles();
  osmBoundaryHandleLayer = L.layerGroup().addTo(map);
  osmBoundaryPolygons.forEach((polygon) => polygon.forEach((ring) => {
    const lastIsClosure = ring.length > 1
      && ring[0].lat === ring[ring.length - 1].lat && ring[0].lon === ring[ring.length - 1].lon;
    const editableLength = lastIsClosure ? ring.length - 1 : ring.length;
    for (let vertexIndex = 0; vertexIndex < editableLength; vertexIndex += 1) {
      const point = ring[vertexIndex];
      const marker = L.marker([point.lat, point.lon], {
        icon: L.divIcon({ className: "osm-boundary-handle", html: "<span></span>", iconSize: [11, 11], iconAnchor: [5.5, 5.5] }),
        draggable: true, autoPan: true, bubblingMouseEvents: false, zIndexOffset: 2000,
      });
      const updateVertex = (event) => {
        const latLng = event.target.getLatLng();
        ring[vertexIndex] = { lat: latLng.lat, lon: latLng.lng };
        if (lastIsClosure && vertexIndex === 0) ring[ring.length - 1] = { ...ring[0] };
        osmBoundaryEdited = true;
        drawOsmBoundary();
      };
      marker.on("drag", updateVertex);
      marker.on("dragend", updateVertex);
      marker.addTo(osmBoundaryHandleLayer);
    }
  }));
}

function startOsmBoundaryEditing() {
  if (!osmBoundaryPolygons.length) return;
  setMapAddMode(false);
  osmBoundaryEditMode = true;
  map.getContainer().classList.add("osm-boundary-edit-active");
  elements.mapAddHint.hidden = false;
  elements.mapAddHint.textContent = "Drag the purple boundary handles · then Finish editing";
  drawOsmBoundaryHandles();
  updateOsmBoundaryControls();
  showStatus("Drag any purple vertex to adjust the OSM boundary.");
}

function resetOsmBoundary() {
  if (!osmBoundaryOriginal.length) return;
  finishOsmBoundaryEditing();
  osmBoundaryPolygons = cloneBoundaryPolygons(osmBoundaryOriginal);
  osmBoundaryEdited = false;
  drawOsmBoundary();
  updateOsmBoundaryControls();
  showStatus("The original OSM boundary was restored.");
}

function parseCoordinates(text) {
  const trimmedText = text.trim();
  if (looksLikeXmlCoordinates(trimmedText)) {
    return parseGpxXml(trimmedText);
  }

  const points = [];
  const seen = new Set();
  let duplicates = 0;

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const unwrapped = line.replace(/^[\[(]\s*/, "").replace(/\s*[\])]$/, "");
    const parts = unwrapped.split(/\s*(?:,|;|\t)\s*|\s+/).filter(Boolean);
    if (parts.length !== 2 || parts.some((part) => part === "")) {
      throw new Error(`Line ${index + 1} must contain one latitude/longitude pair.`);
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

function looksLikeXmlCoordinates(text) {
  return /^\s*</.test(text) || /<(?:\w+:)?(?:gpx|wpt|rtept|trkpt)\b/i.test(text);
}

function parseGpxXml(text) {
  const documentNode = new DOMParser().parseFromString(text, "application/xml");
  if (documentNode.querySelector("parsererror")) throw new Error("The file contains invalid GPX/XML.");

  const allElements = Array.from(documentNode.getElementsByTagName("*"));
  const pointElements = allElements.filter((element) =>
    ["wpt", "rtept", "trkpt"].includes((element.localName || element.nodeName).toLowerCase())
  );
  if (!pointElements.length) throw new Error("No GPX waypoints, route points, or track points were found.");

  const coordinateText = pointElements.map((element) => {
    const lat = element.getAttribute("lat");
    const lon = element.getAttribute("lon");
    if (lat === null || lon === null) throw new Error("A GPX point is missing its lat or lon attribute.");
    return `${lat},${lon}`;
  }).join("\n");
  const parsed = parseCoordinates(coordinateText);

  const namedContainer = allElements.find((element) =>
    ["metadata", "trk", "rte"].includes((element.localName || element.nodeName).toLowerCase())
    && Array.from(element.children).some((child) => (child.localName || child.nodeName).toLowerCase() === "name")
  );
  const metadataName = namedContainer
    ? Array.from(namedContainer.children).find((element) => (element.localName || element.nodeName).toLowerCase() === "name")?.textContent?.trim() || ""
    : "";
  return { ...parsed, metadataName, kind: "GPX" };
}

function parseImportedFile(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("The selected file is empty.");

  if (looksLikeXmlCoordinates(trimmed)) return parseGpxXml(trimmed);

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
  if (route.length > 1) total += haversineMeters(route[route.length - 1], route[0]);
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
  if (route.length > 1) total += distances[route[route.length - 1]][route[0]];
  return total;
}

function openRouteDistanceIndexes(route, distances) {
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

function exactClosedRoute(distances) {
  const count = distances.length;
  const stateCount = 1 << count;
  const costs = new Float64Array(stateCount * count);
  costs.fill(Infinity);
  const parents = new Int16Array(stateCount * count);
  parents.fill(-2);

  costs[count] = 0;
  parents[count] = -1;

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
  let last = 1;
  let bestClosedCost = costs[fullMask * count + last] + distances[last][0];
  for (let point = 2; point < count; point += 1) {
    const closedCost = costs[fullMask * count + point] + distances[point][0];
    if (closedCost < bestClosedCost) {
      last = point;
      bestClosedCost = closedCost;
    }
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
        const next = route[(after + 1) % route.length];
        const delta = distances[route[after]][point] + distances[point][next]
          - distances[route[after]][next];
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
    for (let first = 1; first < route.length - 1; first += 1) {
      for (let last = first; last < route.length; last += 1) {
        const previous = route[first - 1];
        const next = route[(last + 1) % route.length];
        const oldDistance = distances[previous][route[first]] + distances[route[last]][next];
        const newDistance = distances[previous][route[last]] + distances[route[first]][next];
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
    for (let index = 1; index < route.length; index += 1) {
      const point = route[index];
      const reduced = route.slice(0, index).concat(route.slice(index + 1));
      const previous = route[index - 1];
      const next = route[(index + 1) % route.length];
      const removalDelta = distances[previous][next]
        - distances[previous][point] - distances[point][next];
      for (let slot = 1; slot <= reduced.length; slot += 1) {
        const before = reduced[slot - 1];
        const after = reduced[slot % reduced.length];
        const insertionDelta = distances[before][point] + distances[point][after]
          - distances[before][after];
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

function bestHeuristicClosedRoute(distances) {
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

function preferredOpenRoute(distances) {
  if (distances.length <= EXACT_OPTIMIZATION_LIMIT) return exactOpenRoute(distances);
  return distances.map((_, start) => nearestNeighbor(distances, start))
    .reduce((best, route) => openRouteDistanceIndexes(route, distances) < openRouteDistanceIndexes(best, distances) ? route : best);
}

function optimizeRoute(points) {
  if (points.length < 3) return [...points];
  const distances = distanceMatrix(points);
  const indexes = points.length <= EXACT_OPTIMIZATION_LIMIT
    ? exactClosedRoute(distances)
    : bestHeuristicClosedRoute(distances);
  const openGuide = preferredOpenRoute(distances);
  const anchor = indexes.indexOf(openGuide[0]);
  const forward = indexes.slice(anchor).concat(indexes.slice(0, anchor));
  const reverse = [forward[0], ...forward.slice(1).reverse()];
  const selected = distances[forward[1]][openGuide[1]] <= distances[reverse[1]][openGuide[1]]
    ? forward : reverse;
  return selected.map((index) => points[index]);
}

function showStatus(message, error = false) {
  elements.statusText.textContent = message;
  elements.status.classList.toggle("error", error);
}

function getInputPoints() {
  try {
    const parsed = parseCoordinates(elements.coordinates.value);
    elements.coordinates.value = parsed.points.map((point) => `${formatNumber(point.lat)},${formatNumber(point.lon)}`).join("\n");
    if (parsed.kind === "GPX") {
      if (!elements.parkName.value.trim() && parsed.metadataName) elements.parkName.value = parsed.metadataName;
      const duplicateText = parsed.duplicates ? ` ${parsed.duplicates} duplicate(s) removed.` : "";
      elements.importNote.textContent = `GPX extracted: ${parsed.points.length} coordinates.${duplicateText}`;
      elements.importNote.classList.remove("error");
    }
    return parsed;
  } catch (error) {
    showStatus(error.message, true);
    throw error;
  }
}

function updateFooter() {
  elements.footerName.textContent = elements.parkName.value.trim() || "Unnamed route";
  elements.footerPoints.textContent = String(currentRoute.length || inputPreviewPoints.length);
  elements.footerDistance.textContent = currentRoute.length
    ? (routeDistance(currentRoute) / 1000).toFixed(2)
    : inputPreviewPoints.length ? "—" : "0.00";
}

function setMapAddMode(active) {
  if (active && osmBoundaryEditMode) finishOsmBoundaryEditing();
  mapAddMode = active && !elements.mapAddButton.hidden;
  elements.mapAddButton.classList.toggle("is-active", mapAddMode);
  elements.mapAddButton.textContent = mapAddMode ? "✓ Finish editing" : "＋ Add/Edit Points";
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
  showStatus("Point removed. Finish editing to rebuild the optimized route.");
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
  clearOsmBoundary();
  if (routeLayer) routeLayer.remove();
  if (markerLayer) markerLayer.remove();
  if (inputMarkerLayer) inputMarkerLayer.remove();
  routeLayer = null;
  markerLayer = null;
  inputMarkerLayer = null;
  inputPreviewPoints = [];
  elements.emptyMap.hidden = false;
  elements.footerLabel.textContent = "ROUTE READY";
  updateFooter();
  if (message && hadBuiltRoute) showStatus(message);
}

function drawInputPoints(points) {
  if (inputMarkerLayer) inputMarkerLayer.remove();
  inputPreviewPoints = [...points];
  inputMarkerLayer = L.layerGroup().addTo(map);
  const latLngs = points.map((point) => [point.lat, point.lon]);
  points.forEach((point, index) => {
    const icon = L.divIcon({
      className: "input-marker",
      html: '<div class="input-pin"></div>',
      iconSize: [20, 27],
      iconAnchor: [10, 25],
    });
    L.marker([point.lat, point.lon], { icon, bubblingMouseEvents: false })
      .bindTooltip(`Input point ${index + 1}<br>${formatNumber(point.lat)}, ${formatNumber(point.lon)}`)
      .addTo(inputMarkerLayer);
  });
  if (points.length === 1) map.setView(latLngs[0], 17);
  else map.fitBounds(L.latLngBounds(latLngs), { padding: [45, 45], maxZoom: 17 });
  elements.emptyMap.hidden = true;
  elements.footerLabel.textContent = "POINTS LOADED";
  elements.footerPoints.textContent = String(points.length);
  elements.footerDistance.textContent = "—";
  setTimeout(() => map.invalidateSize(), 0);
}

function drawRoute() {
  if (routeLayer) routeLayer.remove();
  if (markerLayer) markerLayer.remove();
  if (inputMarkerLayer) inputMarkerLayer.remove();
  inputMarkerLayer = null;
  inputPreviewPoints = [];

  const latLngs = currentRoute.map((point) => [point.lat, point.lon]);
  const loopLatLngs = currentRoute.length > 1 ? [...latLngs, latLngs[0]] : latLngs;
  routeLayer = L.polyline(loopLatLngs, { color: "#f24a2e", weight: 5, opacity: 0.95 }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  currentRoute.forEach((point, index) => {
    const markerRole = index === 0 ? "start" : index === currentRoute.length - 1 ? "finish" : "route";
    const icon = L.divIcon({
      className: "route-marker",
      html: `<div class="route-pin ${markerRole}-pin"></div>`,
      iconSize: [22, 29],
      iconAnchor: [11, 27],
    });
    const marker = L.marker([point.lat, point.lon], { icon, bubblingMouseEvents: false })
      .bindTooltip(`${markerRole === "start" ? "Start" : markerRole === "finish" ? "Last point" : `Point ${index + 1}`}<br>${formatNumber(point.lat)}, ${formatNumber(point.lon)}${mapAddMode ? "<br>Click to remove" : ""}`);
    marker.on("click", () => {
      if (mapAddMode) showRemovePointPopup(point);
    });
    marker.addTo(markerLayer);
  });
  drawOsmBoundary();
  if (osmBoundaryPolygons.length) {
    const displayBounds = routeLayer.getBounds();
    flattenBoundaryPoints().forEach((point) => displayBounds.extend([point.lat, point.lon]));
    map.fitBounds(displayBounds, { padding: [45, 45], maxZoom: 17 });
  } else if (currentRoute.length === 1) map.setView(latLngs[0], 17);
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
  const parkTypes = ["park", "garden", "nature_reserve", "recreation_ground", "common"];
  const isParkFeature = [result.type, result.addresstype].some((value) => parkTypes.includes(value))
    || ["leisure", "natural"].includes(result.category);
  const parkName = [
    address.park, address.nature_reserve, address.garden, address.recreation_ground,
    address.leisure, isParkFeature ? result.name : "", isParkFeature ? result.namedetails?.name : "",
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

function localityNameFromResult(result) {
  const address = result.address || {};
  const locality = address.city || address.town || address.municipality || address.village
    || address.suburb || address.county || address.state || "";
  const state = address.state || address.province || address.region || "";
  return [locality, state, address.country]
    .filter((part, index, parts) => part && parts.findIndex((value) => value.toLowerCase() === part.toLowerCase()) === index)
    .join(", ");
}

function sampledContainmentPoints(points) {
  if (points.length <= 3) return points;
  const center = points.reduce((sum, point) => ({ lat: sum.lat + point.lat, lon: sum.lon + point.lon }), { lat: 0, lon: 0 });
  center.lat /= points.length;
  center.lon /= points.length;
  const nearest = points.reduce((best, point) => haversineMeters(point, center) < haversineMeters(best, center) ? point : best);
  return [nearest, points[Math.floor(points.length / 3)], points[Math.floor(points.length * 2 / 3)]]
    .filter((point, index, values) => values.findIndex((item) => item.lat === point.lat && item.lon === point.lon) === index);
}

function overpassParkQuery(points) {
  const samples = sampledContainmentPoints(points);
  const assignments = samples.map((point, index) => `is_in(${point.lat},${point.lon})->.inside${index};`).join("\n");
  const selectors = samples.flatMap((_, index) => [
    `area.inside${index}[name][leisure=park];`,
    `area.inside${index}[name][leisure=garden];`,
    `area.inside${index}[name][leisure=recreation_ground];`,
    `area.inside${index}[name][leisure=nature_reserve];`,
    `area.inside${index}[name][boundary=protected_area];`,
  ]).join("\n");
  return `[out:json][timeout:25];\n${assignments}\n(\n${selectors}\n);\nout tags center;`;
}

async function overpassContainingParkIds(points) {
  const query = overpassParkQuery(points);
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 28000);
    try {
      const response = await fetch(`${endpoint}?${new URLSearchParams({ data: query })}`, {
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const ids = (payload.elements || []).map((area) => {
        const id = Number(area.id);
        if (area.type === "way") return `W${id}`;
        if (area.type === "relation") return `R${id}`;
        if (id >= 3600000000) return `R${id - 3600000000}`;
        if (id >= 2400000000) return `W${id - 2400000000}`;
        return "";
      }).filter((value, index, values) => value && values.indexOf(value) === index);
      return ids.slice(0, 25);
    } catch (_) {
      // Try the next public Overpass endpoint.
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

async function containingOsmParkResult(point, routePoints = [point]) {
  const cacheKey = sampledContainmentPoints(routePoints)
    .map((sample) => `${sample.lat.toFixed(5)},${sample.lon.toFixed(5)}`).join(";");
  if (containingParkCache.has(cacheKey)) return containingParkCache.get(cacheKey);
  const osmIds = await overpassContainingParkIds(routePoints);
  if (osmIds === null) return null;
  if (!osmIds.length) {
    containingParkCache.set(cacheKey, null);
    return null;
  }
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const url = new URL("https://nominatim.openstreetmap.org/lookup");
  url.search = new URLSearchParams({
    format: "jsonv2", osm_ids: osmIds.join(","), addressdetails: "1", namedetails: "1",
    polygon_geojson: "1", polygon_threshold: "0", "accept-language": "en",
  });
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const results = await response.json();
    const candidates = results.map((result) => {
      const boundary = geoJsonToBoundaryPolygons(result.geojson);
      const coveredPoints = boundary.length
        ? routePoints.filter((routePoint) => pointInsideBoundary(routePoint, boundary)).length : 0;
      return {
        name: parkNameFromResult(result), boundary,
        contains: boundary.length ? pointInsideBoundary(point, boundary) : false,
        coverage: routePoints.length ? coveredPoints / routePoints.length : 0,
        importance: Number(result.importance) || 0,
        osmType: result.osm_type || "", osmId: result.osm_id || "",
      };
    }).filter((candidate) => candidate.name && candidate.boundary.length
      && (candidate.contains || candidate.coverage >= 0.5));
    candidates.sort((a, b) => b.coverage - a.coverage || Number(b.contains) - Number(a.contains)
      || b.importance - a.importance);
    const selected = candidates[0] || null;
    containingParkCache.set(cacheKey, selected);
    return selected;
  } catch (_) {
    return null;
  }
}

async function ensureOsmParkBoundary(points = currentRoute) {
  if (osmBoundaryPolygons.length) return true;
  if (!points.length) return false;
  const center = points.reduce((sum, point) => ({ lat: sum.lat + point.lat, lon: sum.lon + point.lon }), { lat: 0, lon: 0 });
  center.lat /= points.length;
  center.lon /= points.length;
  const nearest = points.reduce((best, point) => haversineMeters(point, center) < haversineMeters(best, center) ? point : best);
  const candidate = await containingOsmParkResult(nearest, points);
  if (!candidate?.boundary?.length) {
    clearOsmBoundary();
    return false;
  }
  setOsmBoundary(candidate.boundary, {
    name: candidate.name, osmType: candidate.osmType, osmId: candidate.osmId,
  });
  elements.parkName.value = candidate.name;
  updateFooter();
  return true;
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
    const nearbyPark = await containingOsmParkResult(nearest, points);
    if (requestId !== lookupRequestId) return;
    let suggestedName = nearbyPark?.name || "";
    if (!suggestedName) suggestedName = parkNameFromResult(result);
    if (!suggestedName) suggestedName = localityNameFromResult(result);
    if (!suggestedName) throw new Error("No named place was found near these coordinates.");
    if (nearbyPark?.boundary?.length) {
      setOsmBoundary(nearbyPark.boundary, {
        name: nearbyPark.name, osmType: nearbyPark.osmType, osmId: nearbyPark.osmId,
      });
    } else {
      clearOsmBoundary();
    }
    elements.parkName.value = suggestedName;
    updateFooter();
    elements.lookupNote.textContent = nearbyPark
      ? `Containing OSM park: ${suggestedName}. Edit it if needed.`
      : `Suggested name: ${suggestedName}. Edit it if needed.`;
    elements.lookupNote.classList.toggle("error", !nearbyPark);
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
    const imported = parseImportedFile(await readFileText(file));
    const importedPoints = imported.points.map((point) => ({
      lat: Number(formatNumber(point.lat)),
      lon: Number(formatNumber(point.lon)),
    }));
    const filenameName = parkNameFromFilename(file.name);
    const importedName = imported.metadataName || filenameName;
    elements.coordinates.value = importedPoints.map((point) => `${formatNumber(point.lat)},${formatNumber(point.lon)}`).join("\n");
    elements.parkName.value = importedName;
    lastLookupSignature = "";
    invalidateRoute();
    drawInputPoints(importedPoints);
    updateFooter();
    const duplicateText = imported.duplicates ? ` ${imported.duplicates} duplicate(s) removed.` : "";
    elements.importNote.textContent = `${imported.kind} imported: ${importedPoints.length} coordinates.${duplicateText}`;
    showStatus(`${file.name} is ready. Build the route.`);
    if (importedName) {
      elements.lookupNote.classList.remove("error");
      elements.lookupNote.textContent = imported.metadataName
        ? `Name imported from GPX metadata: ${importedName}.`
        : `Name inferred from the file: ${importedName}.`;
    } else {
      elements.lookupNote.textContent = "Finding a name near the imported coordinates…";
    }
    lookupParkName(false, importedPoints);
  } catch (error) {
    elements.importNote.textContent = error.message;
    elements.importNote.classList.add("error");
    showStatus("Could not import that file.", true);
  } finally {
    elements.fileInput.value = "";
  }
}

function readFileText(file) {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("The selected file could not be read."));
    reader.readAsText(file);
  });
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
  return Number(value).toFixed(6);
}

function createGpx(name, route) {
  const safeName = escapeXml(name);
  const loopRoute = route.length > 1 ? [...route, route[0]] : route;
  const waypoints = loopRoute.map((point) => `<wpt lat="${formatNumber(point.lat)}" lon="${formatNumber(point.lon)}"></wpt>`).join("\n");
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

function downloadTxt() {
  if (!currentRoute.length) return;
  const name = elements.parkName.value.trim() || "Unnamed route";
  downloadBlob(new Blob([createGpx(name, currentRoute)], { type: "text/plain;charset=utf-8" }), safeFilename(name, "txt"));
  showStatus("GPX content downloaded as TXT.");
}

function worldPoint(point, zoom) {
  const scale = 256 * 2 ** zoom;
  const sinLat = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, point.lat)) * Math.PI / 180);
  return {
    x: (point.lon + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  };
}

function exportView(route, width, height, additionalPoints = []) {
  const footerHeight = 104;
  const mapHeight = height - footerHeight;
  const padding = 42;
  const base = [...route, ...additionalPoints].map((point) => worldPoint(point, 0));
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

function drawPin(context, x, y, color = "#22bce7") {
  context.save();
  context.translate(x, y);
  context.beginPath();
  context.arc(0, -10, 10, Math.PI * 0.12, Math.PI * 0.88, true);
  context.lineTo(0, 8);
  context.closePath();
  context.fillStyle = color;
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

function drawBoundaryOnCanvas(context, view, left, top) {
  if (!osmBoundaryPolygons.length) return;
  context.save();
  context.beginPath();
  osmBoundaryPolygons.forEach((polygon) => polygon.forEach((ring) => {
    ring.forEach((point, index) => {
      const projected = worldPoint(point, view.zoom);
      const x = projected.x - left;
      const y = projected.y - top;
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    });
    context.closePath();
  }));
  context.fillStyle = "rgba(108,99,255,.09)";
  context.fill("evenodd");
  context.strokeStyle = "#5b52ff";
  context.lineWidth = 4;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();
  context.restore();
}

function drawDoubleChevron(context, x, y, angle) {
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.beginPath();
  [-4, 4].forEach((offset) => {
    context.moveTo(offset - 3.5, -4);
    context.lineTo(offset + 0.5, 0);
    context.lineTo(offset - 3.5, 4);
  });
  context.strokeStyle = "rgba(255,255,255,.98)";
  context.lineWidth = 2.2;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();
  context.restore();
}

function drawRouteChevrons(context, points, spacing = 72) {
  if (points.length < 2) return;
  const loop = [...points, points[0]];
  const segments = [];
  let totalLength = 0;
  for (let index = 1; index < loop.length; index += 1) {
    const start = loop[index - 1];
    const end = loop[index];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length < 1) continue;
    segments.push({ start, end, length, offset: totalLength });
    totalLength += length;
  }
  for (let distance = Math.min(46, totalLength / 2); distance < totalLength - 18; distance += spacing) {
    const segment = segments.find((item) => distance <= item.offset + item.length);
    if (!segment) break;
    const ratio = (distance - segment.offset) / segment.length;
    drawDoubleChevron(context,
      segment.start.x + (segment.end.x - segment.start.x) * ratio,
      segment.start.y + (segment.end.y - segment.start.y) * ratio,
      Math.atan2(segment.end.y - segment.start.y, segment.end.x - segment.start.x));
  }
}

async function downloadMapImage() {
  if (!currentRoute.length) return;
  if (!osmBoundaryPolygons.length) {
    try {
      showStatus("Checking for a containing OSM park boundary…");
      await ensureOsmParkBoundary(currentRoute);
    } catch (_) {
      // Non-park routes intentionally export without a boundary.
    }
  }
  const name = elements.parkName.value.trim() || "Unnamed route";
  const width = 1200;
  const height = 800;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const view = exportView(currentRoute, width, height, flattenBoundaryPoints());
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

    drawBoundaryOnCanvas(context, view, left, top);

    if (canvasPoints.length > 1) {
      context.beginPath();
      [...canvasPoints, canvasPoints[0]].forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      context.lineJoin = "round";
      context.lineCap = "round";
      context.strokeStyle = "rgba(255,255,255,.9)";
      context.lineWidth = 11;
      context.stroke();
      context.strokeStyle = "#f24a2e";
      context.lineWidth = 6;
      context.stroke();
      drawRouteChevrons(context, canvasPoints);
    }
    canvasPoints.forEach((point, index) => drawPin(context, point.x, point.y,
      index === 0 ? "#25c46b" : index === canvasPoints.length - 1 ? "#ff4f91" : "#22bce7"));

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
elements.editOsmBoundary.addEventListener("click", () => {
  if (osmBoundaryEditMode) finishOsmBoundaryEditing();
  else startOsmBoundaryEditing();
});
elements.resetOsmBoundary.addEventListener("click", resetOsmBoundary);
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
elements.txtButton.addEventListener("click", downloadTxt);
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
      drawInputPoints(points);
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
