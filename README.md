# GPX Route Creator V2

A small browser-based GPX route tool. It:

- accepts one `latitude,longitude` point per line and previews every valid point as a map pin before route building;
- imports `.gpx` and `.txt` files (including GPX XML saved with a `.txt` extension);
- reads GPX waypoints, route points, track points, and the GPX metadata name;
- removes duplicates and uses an exact/heuristic closed-loop route optimizer;
- identifies an enclosing OSM gathering-place polygon geometrically and suggests its editable name;
- previews the route on an OpenStreetMap map;
- lets you enter **Add/Edit Points** mode after a build, place extra markers directly on
  the map, remove markers, and automatically rebuild when you finish;
- draws the exact enclosing OSM place boundary when one exists and lets you edit its vertices;
- writes every imported and exported latitude/longitude value with six decimal places;
- downloads a closed-loop GPX file, the same GPX content as TXT, and a tightly framed 1200 × 800 PNG map with the
  existing pins/footer, the validated boundary, and repeated double-chevron direction markers;

Supported places include parks, gardens, recreation grounds, nature reserves, malls,
shopping centres, plazas/squares, pedestrian areas, markets, cultural/event venues,
tourist attractions, places of worship, sports grounds, playgrounds, and beaches.
Route coverage and containment come first; equally matching places prefer parks, then
gardens, then other green spaces, then other venues. Place types are proxies for
gathering spots, not live crowd estimates or guarantees of public access.

When uploaded coordinates are not covered by a mapped gathering-place OSM polygon, V2 uses a
locality name and intentionally shows no boundary rather than drawing a nearby or guessed shape.

Run detection regression tests from the parent folder with `node --test place-detection.test.js`.

After coordinates are imported, pasted, or edited, click **Build optimized route**.
The GPX/PNG download buttons only appear for the currently built route and disappear
again as soon as its coordinates change.

## Add or edit points from the map

1. Build the initial route.
2. Click **Add/Edit Points** above the map.
3. Click the map for every extra coordinate you want to add.
4. To remove a point, click its marker and choose **Remove point**.
5. Click **Finish editing**. The route automatically rebuilds with the updated points.
