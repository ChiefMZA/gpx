"use strict";

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const EARTH_RADIUS_METERS = 6371008.8;
const EXACT_OPTIMIZATION_LIMIT = 14;
const FULL_HEURISTIC_START_LIMIT = 160;
const LARGE_ROUTE_SEED_LIMIT = 64;
const LARGE_ROUTE_CANDIDATE_LIMIT = 16;
const LARGE_ROUTE_TWO_OPT_PASSES = 12;
const LARGE_ROUTE_RELOCATION_LIMIT = 32;
const MAX_ROUTE_TOLERANCE_METERS = 80;
const ROUTE_LINE_WIDTH = 5;
const PNG_DPI = 100;
const PNG_EXPORT_SCALE = PNG_DPI / 96;
const DOM_MARKER_LIMIT = 300;
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
  routeTolerance: document.querySelector("#route-tolerance"),
  gpxButton: document.querySelector("#gpx-button"),
  txtButton: document.querySelector("#txt-button"),
  imageButton: document.querySelector("#image-button"),
  pngShowBoundary: document.querySelector("#png-show-boundary"),
  pngShowPins: document.querySelector("#png-show-pins"),
  mapAddButton: document.querySelector("#map-add-button"),
  mapAddHint: document.querySelector("#map-add-hint"),
  actions: document.querySelector("#actions"),
  status: document.querySelector("#status"),
  statusText: document.querySelector("#status-text"),
  optimizationProgress: document.querySelector("#optimization-progress"),
  optimizationStage: document.querySelector("#optimization-stage"),
  optimizationPercent: document.querySelector("#optimization-percent"),
  optimizationTrack: document.querySelector("#optimization-track"),
  optimizationFill: document.querySelector("#optimization-fill"),
  emptyMap: document.querySelector("#empty-map"),
  footerName: document.querySelector("#footer-name"),
  footerLabel: document.querySelector("#footer-label"),
  footerPoints: document.querySelector("#footer-points"),
  footerDistance: document.querySelector("#footer-distance"),
};

let currentRoute = [];
let routeTargets = [];
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
let optimizationProgressTimer = null;
let toleranceTimer = null;
let routeBuildGeneration = 0;
const containingParkCache = new Map();

const map = L.map("map", { zoomControl: false, attributionControl: true, preferCanvas: true }).setView([20, 0], 2);
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

function wrappedLongitudeDelta(degrees) {
  return ((degrees + 540) % 360) - 180;
}

function pointToSegmentMeters(point, start, end) {
  if (start.lat === end.lat && start.lon === end.lon) return haversineMeters(point, start);
  const referenceLat = (start.lat + end.lat + point.lat) / 3 * Math.PI / 180;
  const latitudeScale = EARTH_RADIUS_METERS * Math.PI / 180;
  const longitudeScale = latitudeScale * Math.max(1e-9, Math.cos(referenceLat));
  const segmentX = wrappedLongitudeDelta(end.lon - start.lon) * longitudeScale;
  const segmentY = (end.lat - start.lat) * latitudeScale;
  const pointX = wrappedLongitudeDelta(point.lon - start.lon) * longitudeScale;
  const pointY = (point.lat - start.lat) * latitudeScale;
  const lengthSquared = segmentX ** 2 + segmentY ** 2;
  const position = Math.max(0, Math.min(1, (pointX * segmentX + pointY * segmentY) / lengthSquared));
  return Math.hypot(pointX - position * segmentX, pointY - position * segmentY);
}

function routeCoversTargets(route, targets, toleranceMeters) {
  if (!route.length) return false;
  if (route.length === 1) {
    return targets.every((point) => haversineMeters(point, route[0]) <= toleranceMeters + 0.05);
  }
  return targets.every((point) => route.some((start, index) =>
    pointToSegmentMeters(point, start, route[(index + 1) % route.length]) <= toleranceMeters + 0.05));
}

function simplifyRouteForTolerance(orderedRoute, targets, toleranceMeters) {
  const tolerance = Number(toleranceMeters);
  if (!(tolerance > 0) || orderedRoute.length < 2) return [...orderedRoute];
  const route = orderedRoute.map((point, id) => ({ point, id }));
  const coverageCounts = new Int32Array(targets.length);
  const segmentCoverage = new Map();
  const segmentKey = (start, end) => `${start.id}:${end.id}`;
  const measureSegment = (start, end) => {
    const covered = new Uint8Array(targets.length);
    targets.forEach((target, index) => {
      if (pointToSegmentMeters(target, start.point, end.point) <= tolerance + 0.05) covered[index] = 1;
    });
    return covered;
  };
  const addSegment = (start, end, covered = measureSegment(start, end)) => {
    segmentCoverage.set(segmentKey(start, end), covered);
    for (let index = 0; index < covered.length; index += 1) coverageCounts[index] += covered[index];
  };
  for (let index = 0; index < route.length; index += 1) addSegment(route[index], route[(index + 1) % route.length]);

  let changed = true;
  while (changed && route.length > 1) {
    changed = false;
    const candidates = route.map((node, index) => {
      const previous = route[(index - 1 + route.length) % route.length];
      const next = route[(index + 1) % route.length];
      return { node, saving: haversineMeters(previous.point, node.point)
        + haversineMeters(node.point, next.point) - haversineMeters(previous.point, next.point) };
    }).sort((first, second) => second.saving - first.saving);

    for (const { node } of candidates) {
      if (route.length <= 1) break;
      const index = route.indexOf(node);
      if (index < 0) continue;
      const previous = route[(index - 1 + route.length) % route.length];
      const next = route[(index + 1) % route.length];
      const beforeCoverage = segmentCoverage.get(segmentKey(previous, node));
      const afterCoverage = segmentCoverage.get(segmentKey(node, next));
      const replacementCoverage = measureSegment(previous, next);
      let safe = true;
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
        if (coverageCounts[targetIndex] - beforeCoverage[targetIndex] - afterCoverage[targetIndex]
          + replacementCoverage[targetIndex] <= 0) {
          safe = false;
          break;
        }
      }
      if (!safe) continue;

      segmentCoverage.delete(segmentKey(previous, node));
      segmentCoverage.delete(segmentKey(node, next));
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
        coverageCounts[targetIndex] += replacementCoverage[targetIndex]
          - beforeCoverage[targetIndex] - afterCoverage[targetIndex];
      }
      segmentCoverage.set(segmentKey(previous, next), replacementCoverage);
      route.splice(index, 1);
      changed = true;
    }
  }
  const simplified = route.map(({ point }) => point);
  return routeCoversTargets(simplified, targets, tolerance) ? simplified : [...orderedRoute];
}

function distanceMatrix(points) {
  const distances = Array.from({ length: points.length }, () => new Float64Array(points.length));
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      const distance = haversineMeters(points[first], points[second]);
      distances[first][second] = distance;
      distances[second][first] = distance;
    }
  }
  return distances;
}

function heuristicStartIndexes(distances) {
  const count = distances.length;
  if (count <= FULL_HEURISTIC_START_LIMIT) return Array.from({ length: count }, (_, index) => index);
  const starts = [];
  const orderedSeedCount = Math.floor(LARGE_ROUTE_SEED_LIMIT / 2);
  for (let seed = 0; seed < orderedSeedCount; seed += 1) {
    const index = Math.floor(seed * count / orderedSeedCount);
    if (!starts.includes(index)) starts.push(index);
  }
  const nearestStartDistance = new Float64Array(count);
  nearestStartDistance.fill(Infinity);
  starts.forEach((start) => {
    for (let index = 0; index < count; index += 1) {
      if (distances[start][index] < nearestStartDistance[index]) nearestStartDistance[index] = distances[start][index];
    }
  });
  while (starts.length < Math.min(count, LARGE_ROUTE_SEED_LIMIT)) {
    let farthest = -1;
    for (let index = 0; index < count; index += 1) {
      if (!starts.includes(index) && (farthest < 0 || nearestStartDistance[index] > nearestStartDistance[farthest])) farthest = index;
    }
    if (farthest < 0) break;
    starts.push(farthest);
    for (let index = 0; index < count; index += 1) {
      if (distances[farthest][index] < nearestStartDistance[index]) nearestStartDistance[index] = distances[farthest][index];
    }
  }
  return starts;
}

function perturbClosedRoute(route, variant) {
  const shift = Math.floor((variant + 1) * route.length / 17) % route.length;
  const rotated = route.slice(shift).concat(route.slice(0, shift));
  const quarter = Math.max(1, Math.floor(rotated.length / 4));
  return rotated.slice(0, quarter)
    .concat(rotated.slice(quarter * 2, quarter * 3))
    .concat(rotated.slice(quarter, quarter * 2))
    .concat(rotated.slice(quarter * 3));
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
  let passes = 0;
  const maxPasses = route.length > FULL_HEURISTIC_START_LIMIT ? LARGE_ROUTE_TWO_OPT_PASSES : Infinity;
  while (improved && passes < maxPasses) {
    passes += 1;
    improved = false;
    for (let first = 1; first < route.length - 1; first += 1) {
      for (let last = first; last < route.length; last += 1) {
        const previous = route[first - 1];
        const next = route[(last + 1) % route.length];
        const oldDistance = distances[previous][route[first]] + distances[route[last]][next];
        const newDistance = distances[previous][route[last]] + distances[route[first]][next];
        if (newDistance + 0.000001 < oldDistance) {
          for (let left = first, right = last; left < right; left += 1, right -= 1) {
            [route[left], route[right]] = [route[right], route[left]];
          }
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
  let moves = 0;
  const maxMoves = route.length > FULL_HEURISTIC_START_LIMIT ? LARGE_ROUTE_RELOCATION_LIMIT : Infinity;
  while (moves < maxMoves) {
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
    moves += 1;
  }
  return anyChange;
}

function improveRoute(candidate, distances) {
  const route = [...candidate];
  const maxRounds = route.length > FULL_HEURISTIC_START_LIMIT ? 2 : Infinity;
  for (let round = 0; round < maxRounds; round += 1) {
    improveTwoOpt(route, distances);
    if (!relocatePoints(route, distances)) return route;
  }
  return route;
}

function bestHeuristicClosedRoute(distances, reportProgress = null) {
  const startIndexes = heuristicStartIndexes(distances);
  const nearest = [];
  startIndexes.forEach((start, index) => {
    nearest.push(nearestNeighbor(distances, start));
    if (reportProgress) reportProgress(18 + Math.round((index + 1) / startIndexes.length * 22), "Comparing starting points…");
  });
  nearest.sort((a, b) => routeDistanceIndexes(a, distances) - routeDistanceIndexes(b, distances));
  const largeRoute = distances.length > FULL_HEURISTIC_START_LIMIT;
  const candidates = nearest.slice(0, Math.min(largeRoute ? LARGE_ROUTE_CANDIDATE_LIMIT : 24, nearest.length));
  const starts = [];
  candidates.slice(0, 8).forEach((route) => {
    [route[0], route[route.length - 1]].forEach((point) => {
      if (!starts.includes(point)) starts.push(point);
    });
  });
  if (!largeRoute) starts.forEach((start) => {
      candidates.push(cheapestInsertion(distances, start, false));
      candidates.push(cheapestInsertion(distances, start, true));
    });
  else candidates.slice(0, 4).forEach((route, routeIndex) => {
    candidates.push(perturbClosedRoute(route, routeIndex * 2));
    candidates.push(perturbClosedRoute(route, routeIndex * 2 + 1));
  });
  const improved = candidates.map((route, index) => {
    const result = improveRoute(route, distances);
    if (reportProgress) reportProgress(42 + Math.round((index + 1) / candidates.length * 48), "Shortening the route…");
    return result;
  });
  return improved.reduce((best, route) => routeDistanceIndexes(route, distances) < routeDistanceIndexes(best, distances) ? route : best);
}

function preferredOpenRoute(distances) {
  if (distances.length <= EXACT_OPTIMIZATION_LIMIT) return exactOpenRoute(distances);
  return heuristicStartIndexes(distances).map((start) => nearestNeighbor(distances, start))
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

function optimizeRouteAsync(points, reportProgress = null) {
  if (points.length <= FULL_HEURISTIC_START_LIMIT || typeof Worker === "undefined") {
    return Promise.resolve(optimizeRoute(points));
  }
  const workerSource = `
    "use strict";
    const EARTH_RADIUS_METERS = ${EARTH_RADIUS_METERS};
    const FULL_HEURISTIC_START_LIMIT = ${FULL_HEURISTIC_START_LIMIT};
    const LARGE_ROUTE_SEED_LIMIT = ${LARGE_ROUTE_SEED_LIMIT};
    const LARGE_ROUTE_CANDIDATE_LIMIT = ${LARGE_ROUTE_CANDIDATE_LIMIT};
    const LARGE_ROUTE_TWO_OPT_PASSES = ${LARGE_ROUTE_TWO_OPT_PASSES};
    const LARGE_ROUTE_RELOCATION_LIMIT = ${LARGE_ROUTE_RELOCATION_LIMIT};
    ${haversineMeters.toString()}
    ${distanceMatrix.toString()}
    ${heuristicStartIndexes.toString()}
    ${perturbClosedRoute.toString()}
    ${routeDistanceIndexes.toString()}
    ${openRouteDistanceIndexes.toString()}
    ${nearestNeighbor.toString()}
    ${improveTwoOpt.toString()}
    ${relocatePoints.toString()}
    ${improveRoute.toString()}
    ${bestHeuristicClosedRoute.toString()}
    self.onmessage = ({ data: points }) => {
      try {
        self.postMessage({ type: "progress", percent: 8, stage: "Measuring distances…" });
        const distances = distanceMatrix(points);
        self.postMessage({ type: "progress", percent: 18, stage: "Comparing starting points…" });
        const indexes = bestHeuristicClosedRoute(distances, (percent, stage) => self.postMessage({ type: "progress", percent, stage }));
        self.postMessage({ type: "progress", percent: 93, stage: "Choosing the best route…" });
        const openGuide = heuristicStartIndexes(distances).map((start) => nearestNeighbor(distances, start))
          .reduce((best, route) => openRouteDistanceIndexes(route, distances) < openRouteDistanceIndexes(best, distances) ? route : best);
        self.postMessage({ type: "progress", percent: 98, stage: "Finalizing the route…" });
        const anchor = indexes.indexOf(openGuide[0]);
        const forward = indexes.slice(anchor).concat(indexes.slice(0, anchor));
        const reverse = [forward[0], ...forward.slice(1).reverse()];
        self.postMessage({ type: "result", indexes: distances[forward[1]][openGuide[1]] <= distances[reverse[1]][openGuide[1]] ? forward : reverse });
      } catch (error) {
        self.postMessage({ error: error.message || String(error) });
      }
    };
  `;
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);
    const cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    };
    worker.onmessage = ({ data }) => {
      if (data?.type === "progress") {
        if (reportProgress) reportProgress(data.percent, data.stage);
        return;
      }
      cleanup();
      if (data?.error) reject(new Error(data.error));
      else resolve(data.indexes.map((index) => points[index]));
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Route optimization worker failed."));
    };
    worker.postMessage(points);
  });
}

function showOptimizationProgress(percent, stage) {
  clearTimeout(optimizationProgressTimer);
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  elements.optimizationProgress.hidden = false;
  elements.optimizationStage.textContent = stage;
  elements.optimizationPercent.textContent = `${value}%`;
  elements.optimizationFill.style.width = `${value}%`;
  elements.optimizationTrack.setAttribute("aria-valuenow", String(value));
}

function finishOptimizationProgress(stage = "Route ready") {
  showOptimizationProgress(100, stage);
  optimizationProgressTimer = setTimeout(() => { elements.optimizationProgress.hidden = true; }, 1400);
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
  elements.footerPoints.textContent = String(routeTargets.length || currentRoute.length || inputPreviewPoints.length);
  elements.footerDistance.textContent = currentRoute.length
    ? (routeDistance(currentRoute) / 1000).toFixed(2)
    : inputPreviewPoints.length ? "—" : "0.00";
}

function routePointRole(point, route = currentRoute) {
  if (point === route[0]) return "start";
  if (route.length > 1 && point === route[route.length - 1]) return "finish";
  return "route";
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
  routeTargets = [...parsed.points];
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
  routeBuildGeneration += 1;
  elements.buildButton.disabled = false;
  const hadBuiltRoute = currentRoute.length > 0 || !elements.actions.hidden;
  currentRoute = [];
  routeTargets = [];
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
  const lightweightMarkers = points.length > DOM_MARKER_LIMIT;
  points.forEach((point, index) => {
    if (lightweightMarkers) {
      const icon = L.divIcon({ className: "input-marker", html: '<div class="compact-map-pin input"></div>', iconSize: [10, 14], iconAnchor: [5, 13] });
      L.marker([point.lat, point.lon], { icon, bubblingMouseEvents: false })
        .bindTooltip(`Input point ${index + 1}<br>${formatNumber(point.lat)}, ${formatNumber(point.lon)}`)
        .addTo(inputMarkerLayer);
      return;
    }
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
  routeLayer = L.polyline(loopLatLngs, { color: "#f24a2e", weight: ROUTE_LINE_WIDTH, opacity: 0.95 }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  const displayedTargets = routeTargets.length ? routeTargets : currentRoute;
  displayedTargets.forEach((point, index) => {
    const role = routePointRole(point);
    const roleClass = role === "route" ? "" : ` ${role}`;
    const icon = L.divIcon({ className: "route-marker", html: `<div class="compact-map-pin${roleClass}"></div>`, iconSize: [12, 16], iconAnchor: [6, 15] });
    const marker = L.marker([point.lat, point.lon], { icon, bubblingMouseEvents: false })
      .bindTooltip(`Target point ${index + 1}<br>${formatNumber(point.lat)}, ${formatNumber(point.lon)}${mapAddMode ? "<br>Click to remove" : ""}`);
    marker.on("click", () => { if (mapAddMode) showRemovePointPopup(point); });
    marker.addTo(markerLayer);
  });
  drawOsmBoundary();
  if (osmBoundaryPolygons.length) {
    const displayBounds = routeLayer.getBounds();
    displayedTargets.forEach((point) => displayBounds.extend([point.lat, point.lon]));
    flattenBoundaryPoints().forEach((point) => displayBounds.extend([point.lat, point.lon]));
    map.fitBounds(displayBounds, { padding: [45, 45], maxZoom: 17 });
  } else if (displayedTargets.length === 1) map.setView([displayedTargets[0].lat, displayedTargets[0].lon], 17);
  else map.fitBounds(L.latLngBounds(displayedTargets.map((point) => [point.lat, point.lon])), { padding: [45, 45], maxZoom: 17 });
  elements.emptyMap.hidden = true;
  setTimeout(() => map.invalidateSize(), 0);
}

async function buildRoute() {
  const generation = ++routeBuildGeneration;
  let parsed;
  let tolerance;
  try {
    parsed = getInputPoints();
    tolerance = Number(elements.routeTolerance.value);
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > MAX_ROUTE_TOLERANCE_METERS) {
      throw new Error(`Pass distance must be between 0 and ${MAX_ROUTE_TOLERANCE_METERS} metres.`);
    }
  } catch (_) {
    if (generation === routeBuildGeneration) elements.buildButton.disabled = false;
    return;
  }
  elements.buildButton.disabled = true;
  showStatus(`Optimizing ${parsed.points.length} points…`);
  showOptimizationProgress(2, "Preparing the points…");
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  let optimizedRoute;
  try {
    optimizedRoute = await optimizeRouteAsync(parsed.points, showOptimizationProgress);
  } catch (_) {
    showOptimizationProgress(25, "Continuing route optimization…");
    optimizedRoute = optimizeRoute(parsed.points);
  }
  if (generation !== routeBuildGeneration) return;
  showOptimizationProgress(98, tolerance > 0 ? "Applying pass distance…" : "Finalizing the route…");
  currentRoute = simplifyRouteForTolerance(optimizedRoute, parsed.points, tolerance);
  routeTargets = [...parsed.points];
  clearPendingMapPoints();
  drawRoute();
  updateFooter();
  elements.footerLabel.textContent = "ROUTE READY";
  elements.actions.hidden = false;
  elements.mapAddButton.hidden = false;
  setMapAddMode(false);
  const duplicateText = parsed.duplicates ? ` ${parsed.duplicates} duplicate(s) removed.` : "";
  const waypointText = tolerance > 0
    ? `${routeTargets.length} targets covered by ${currentRoute.length} route waypoint${currentRoute.length === 1 ? "" : "s"} within ${tolerance} m`
    : `${currentRoute.length} points`;
  showStatus(`Route ready: ${waypointText}, ${(routeDistance(currentRoute) / 1000).toFixed(2)} km.${duplicateText}`);
  finishOptimizationProgress();
  elements.buildButton.disabled = false;
}

// Keep detection scoped to mapped gathering venues, not arbitrary buildings or city boundaries.
const PLACE_TAG_GROUPS = [
  { key: "leisure", values: ["park"], priority: 0 },
  { key: "leisure", values: ["garden"], priority: 1 },
  { key: "leisure", values: ["recreation_ground", "nature_reserve", "common"], priority: 2 },
  { key: "boundary", values: ["protected_area", "national_park"], priority: 2 },
  { key: "landuse", values: ["recreation_ground", "village_green"], priority: 2 },
  { key: "shop", values: ["mall", "shopping_centre", "department_store"], priority: 3 },
  { key: "building", values: ["mall"], priority: 3 },
  { key: "place", values: ["square"], priority: 3 },
  { key: "highway", values: ["pedestrian"], priority: 3 },
  { key: "amenity", values: ["marketplace", "community_centre", "events_venue", "arts_centre", "theatre", "conference_centre", "exhibition_centre", "place_of_worship"], priority: 3 },
  { key: "tourism", values: ["attraction", "theme_park", "zoo", "museum", "aquarium", "gallery", "picnic_site"], priority: 3 },
  { key: "leisure", values: ["stadium", "sports_centre", "playground", "water_park", "resort"], priority: 3 },
  { key: "natural", values: ["beach"], priority: 3 },
];

function placePriority(result) {
  const category = result.category || result.class;
  return PLACE_TAG_GROUPS.reduce((priority, group) => {
    const matches = (category === group.key && group.values.includes(result.type))
      || group.values.includes(result.extratags?.[group.key]);
    return matches ? Math.min(priority, group.priority) : priority;
  }, 99);
}

function placeBaseName(result) {
  const address = result.address || {};
  // An object's own name must take precedence over a parent park in its address.
  if (placePriority(result) < 99) {
    return result.name || result.namedetails?.name || result.namedetails?.["name:en"]
      || address[result.type] || "";
  }
  return [address.park, address.garden, address.nature_reserve, address.recreation_ground,
    address.mall, address.shopping_centre, address.square, address.marketplace].find(Boolean) || "";
}

function comparePlaceCandidates(a, b) {
  // Geometry wins first. Prefer parks only among equally well-covered places.
  return b.coverage - a.coverage || Number(b.contains) - Number(a.contains)
    || a.priority - b.priority || b.importance - a.importance
    || (a.distance || 0) - (b.distance || 0);
}

function parkNameFromResult(result) {
  const address = result.address || {};
  const parkName = placeBaseName(result);
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
  const selectors = samples.flatMap((_, index) => PLACE_TAG_GROUPS.map(({ key, values }) =>
    `area.inside${index}[name][${key}~"^(${values.join("|")})$"];`
  )).join("\n");
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
  const cacheKey = `${point.lat},${point.lon}|` + routePoints
    .map((sample) => `${sample.lat},${sample.lon}`).join(";");
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
    format: "jsonv2", osm_ids: osmIds.join(","), addressdetails: "1", namedetails: "1", extratags: "1",
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
        priority: placePriority(result), name: parkNameFromResult(result), boundary,
        contains: boundary.length ? pointInsideBoundary(point, boundary) : false,
        coverage: routePoints.length ? coveredPoints / routePoints.length : 0,
        importance: Number(result.importance) || 0,
        osmType: result.osm_type || "", osmId: result.osm_id || "",
      };
    }).filter((candidate) => candidate.priority < 99 && candidate.name && candidate.boundary.length
      && (candidate.contains || candidate.coverage >= 0.5));
    candidates.sort(comparePlaceCandidates);
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
      ? `Containing OSM place: ${suggestedName}. Edit it if needed.`
      : `Suggested name: ${suggestedName}. Edit it if needed.`;
    elements.lookupNote.classList.toggle("error", !nearbyPark);
  } catch (error) {
    if (requestId === lookupRequestId) {
      elements.lookupNote.textContent = `${error.message} You can enter the place name manually.`;
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

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngPhysicalResolutionChunk(dpi) {
  const type = Uint8Array.from([112, 72, 89, 115]);
  const data = new Uint8Array(9);
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  const dataView = new DataView(data.buffer);
  dataView.setUint32(0, pixelsPerMeter);
  dataView.setUint32(4, pixelsPerMeter);
  data[8] = 1;
  const chunk = new Uint8Array(21);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  chunkView.setUint32(17, pngCrc32(chunk.subarray(4, 17)));
  return chunk;
}

async function setPngDpi(blob, dpi) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parts = [bytes.subarray(0, 8)];
  const resolutionChunk = pngPhysicalResolutionChunk(dpi);
  let inserted = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const end = offset + length + 12;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!inserted && (type === "IDAT" || type === "IEND")) {
      parts.push(resolutionChunk);
      inserted = true;
    }
    if (type !== "pHYs") parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  return new Blob(parts, { type: "image/png" });
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

async function drawTiles(context, view, width, reportProgress = null) {
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
  let completed = 0;
  for (let tileY = firstY; tileY <= lastY; tileY += 1) {
    for (let tileX = firstX; tileX <= lastX; tileX += 1) {
      if (tileY < 0 || tileY >= tileCount) continue;
      const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
      const url = TILE_URL.replace("{z}", tileZoom).replace("{x}", wrappedX).replace("{y}", tileY);
      jobs.push(loadImage(url).then((image) => {
        context.drawImage(image, tileX * tileSize - left, tileY * tileSize - top, tileSize, tileSize);
        completed += 1;
        if (reportProgress) reportProgress(completed / jobs.length);
      }));
    }
  }
  await Promise.all(jobs);
}

function routePinColor(role) {
  const variables = {
    route: ["--route-pin", "#22bce7"],
    start: ["--route-start-pin", "#25c46b"],
    finish: ["--route-finish-pin", "#ff4f91"],
  };
  const [property, fallback] = variables[role] || variables.route;
  return getComputedStyle(document.documentElement).getPropertyValue(property).trim() || fallback;
}

function drawPin(context, x, y, color = routePinColor("route"), compact = false) {
  const size = compact ? 12 : 22;
  const borderWidth = compact ? 1.5 : 3;
  const inset = compact ? 4 : 5;
  const centerOffsetX = 0;
  const centerOffsetY = compact ? -9 : -16;
  const cornerRadius = (size - borderWidth) / 2;
  context.save();
  context.translate(x + centerOffsetX, y + centerOffsetY);
  context.rotate(-Math.PI / 4);
  context.shadowColor = compact ? "rgb(0 0 0 / 38%)" : "rgb(0 0 0 / 45%)";
  context.shadowBlur = compact ? 2 : 7;
  context.shadowOffsetY = compact ? 1 : 2;
  context.beginPath();
  context.roundRect(-size / 2 + borderWidth / 2, -size / 2 + borderWidth / 2,
    size - borderWidth, size - borderWidth,
    [cornerRadius, cornerRadius, cornerRadius, 0]);
  context.fillStyle = color;
  context.fill();
  context.shadowColor = "transparent";
  context.lineWidth = borderWidth;
  context.strokeStyle = "#ffffff";
  context.stroke();
  context.beginPath();
  context.arc(0, 0, (size - inset * 2) / 2, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.restore();
}

function exportPinScale(pointCount) {
  return 0.5;
}

async function drawCanvasRoutePins(context, points, reportProgress = null) {
  const compact = true;
  const batchSize = 100;
  for (let start = 0; start < points.length; start += batchSize) {
    const end = Math.min(points.length, start + batchSize);
    for (let index = start; index < end; index += 1) {
      drawPin(context, points[index].x, points[index].y, routePinColor(points[index].role || "route"), compact);
    }
    if (reportProgress) reportProgress(end / points.length);
    if (end < points.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
  const includeBoundary = elements.pngShowBoundary.checked;
  const includePins = elements.pngShowPins.checked;
  elements.imageButton.disabled = true;
  elements.pngShowBoundary.disabled = true;
  elements.pngShowPins.disabled = true;
  elements.imageButton.textContent = "Rendering…";
  showOptimizationProgress(3, "Preparing the map image…");
  if (includeBoundary && !osmBoundaryPolygons.length) {
    try {
      showStatus("Checking for a containing OSM place boundary…");
      showOptimizationProgress(8, "Checking the map area…");
      await ensureOsmParkBoundary(routeTargets.length ? routeTargets : currentRoute);
    } catch (_) {
      // Routes without a mapped gathering place intentionally export without a boundary.
    }
  }
  const name = elements.parkName.value.trim() || "Unnamed route";
  const width = 1200;
  const height = 800;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * PNG_EXPORT_SCALE);
  canvas.height = Math.round(height * PNG_EXPORT_SCALE);
  const context = canvas.getContext("2d");
  context.scale(PNG_EXPORT_SCALE, PNG_EXPORT_SCALE);
  const targetPoints = routeTargets.length ? routeTargets : currentRoute;
  const view = exportView([...currentRoute, ...targetPoints], width, height, includeBoundary ? flattenBoundaryPoints() : []);
  showStatus("Rendering map image…");
  try {
    showOptimizationProgress(18, "Preparing the map canvas…");
    context.fillStyle = "#e6ece8";
    context.fillRect(0, 0, width, view.mapHeight);
    showOptimizationProgress(25, "Loading map tiles…");
    await drawTiles(context, view, width, (ratio) => showOptimizationProgress(25 + ratio * 35, "Loading map tiles…"));
    const left = view.centerX - width / 2;
    const top = view.centerY - view.mapHeight / 2;
    const canvasPoints = currentRoute.map((point) => {
      const projected = worldPoint(point, view.zoom);
      return { x: projected.x - left, y: projected.y - top };
    });
    const canvasTargets = targetPoints.map((point) => {
      const projected = worldPoint(point, view.zoom);
      const role = routePointRole(point);
      return { x: projected.x - left, y: projected.y - top, role };
    });

    showOptimizationProgress(63, "Drawing the route…");
    if (includeBoundary) drawBoundaryOnCanvas(context, view, left, top);

    if (canvasPoints.length > 1) {
      context.beginPath();
      [...canvasPoints, canvasPoints[0]].forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      context.lineJoin = "round";
      context.lineCap = "round";
      context.strokeStyle = "#f24a2e";
      context.lineWidth = ROUTE_LINE_WIDTH;
      context.globalAlpha = 0.95;
      context.stroke();
      context.globalAlpha = 1;
      drawRouteChevrons(context, canvasPoints);
    }
    if (includePins) {
      await drawCanvasRoutePins(context, canvasTargets,
        (ratio) => showOptimizationProgress(68 + ratio * 20, "Adding route pins…"));
    } else {
      showOptimizationProgress(88, "Drawing the route without pins…");
    }

    showOptimizationProgress(91, "Adding map details…");
    context.fillStyle = "#14212b";
    context.fillRect(0, view.mapHeight, width, height - view.mapHeight);
    context.fillStyle = "#c9f75d";
    context.font = "800 13px system-ui, sans-serif";
    context.fillText("PLACE / ROUTE", 36, view.mapHeight + 31);
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
    context.fillText(`${targetPoints.length} points   •   ${(routeDistance(currentRoute) / 1000).toFixed(2)} km`, width - 36, view.mapHeight + 57);
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

    showOptimizationProgress(96, "Saving the PNG…");
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The browser could not create the PNG.");
    const highResolutionBlob = await setPngDpi(blob, PNG_DPI);
    downloadBlob(highResolutionBlob, safeFilename(name, "png"));
    showStatus(`${PNG_DPI} DPI map PNG downloaded.`);
    finishOptimizationProgress("PNG downloaded");
  } catch (error) {
    showStatus(`${error.message} Try again, or check the internet connection.`, true);
    elements.optimizationProgress.hidden = true;
  } finally {
    elements.imageButton.disabled = false;
    elements.pngShowBoundary.disabled = false;
    elements.pngShowPins.disabled = false;
    elements.imageButton.textContent = "Download map PNG";
  }
}

elements.buildButton.addEventListener("click", buildRoute);
elements.routeTolerance.addEventListener("input", () => {
  clearTimeout(toleranceTimer);
  const tolerance = Number(elements.routeTolerance.value);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > MAX_ROUTE_TOLERANCE_METERS) {
    showStatus(`Pass distance must be between 0 and ${MAX_ROUTE_TOLERANCE_METERS} metres.`, true);
    return;
  }
  if (!currentRoute.length || elements.actions.hidden) return;
  showStatus(`Pass distance changed to ${tolerance} m. Re-optimizing…`);
  toleranceTimer = setTimeout(() => { void buildRoute(); }, 450);
});
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
  parseCoordinates, parseImportedFile, haversineMeters, pointToSegmentMeters, routeDistance,
  routeCoversTargets, simplifyRouteForTolerance, optimizeRoute,
  parkNameFromResult, safeFilename, createGpx, exportView,
};
