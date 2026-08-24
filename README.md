# GPX Route Creator V2

A small browser-based GPX route tool. It:

- accepts one `latitude,longitude` point per line and previews every valid point as a map pin before route building;
- imports `.gpx` and `.txt` files (including GPX XML saved with a `.txt` extension);
- reads GPX waypoints, route points, track points, and the GPX metadata name;
- removes duplicates and uses an exact/heuristic closed-loop route optimizer;
- identifies an enclosing OSM park polygon geometrically and suggests its editable name;
- previews the route on an OpenStreetMap map;
- lets you enter **Add/Edit Points** mode after a build, place extra markers directly on
  the map, remove markers, and automatically rebuild when you finish;
- draws the exact enclosing OSM park boundary when one exists and lets you edit its vertices;
- writes every imported and exported latitude/longitude value with six decimal places;
- downloads a closed-loop GPX file, the same GPX content as TXT, and a tightly framed 1200 × 800 PNG map with the
  existing pins/footer, the validated boundary, and repeated double-chevron direction markers;

When uploaded coordinates are not covered by a mapped park-like OSM polygon, V2 uses a
locality name and intentionally shows no boundary rather than drawing a nearby or guessed shape.

After coordinates are imported, pasted, or edited, click **Build optimized route**.
The GPX/PNG download buttons only appear for the currently built route and disappear
again as soon as its coordinates change.

## Add or edit points from the map

1. Build the initial route.
2. Click **Add/Edit Points** above the map.
3. Click the map for every extra coordinate you want to add.
4. To remove a point, click its marker and choose **Remove point**.
5. Click **Finish editing**. The route automatically rebuilds with the updated points.
