# GPX Route Creator V2

A small browser-based GPX route tool. It:

- accepts one `latitude,longitude` point per line;
- imports `.gpx` and `.txt` files (including GPX XML saved with a `.txt` extension);
- reads GPX waypoints, route points, track points, and the GPX metadata name;
- removes duplicates and uses an exact/heuristic closed-loop route optimizer;
- automatically suggests an editable `Park, City, Country` name using OpenStreetMap Nominatim;
- previews the route on an OpenStreetMap map;
- lets you enter **Add/Edit Points** mode after a build, place extra markers directly on
  the map, remove markers, and automatically rebuild when you finish;
- option to download a closed-loop GPX file and a tightly framed 1200 × 800 PNG map;

After coordinates are imported, pasted, or edited, click **Build optimized route**.
The GPX/PNG download buttons only appear for the currently built route and disappear
again as soon as its coordinates change.

## Add or edit points from the map

1. Build the initial route.
2. Click **Add/Edit Points** above the map.
3. Click the map for every extra coordinate you want to add.
4. To remove a point, click its marker and choose **Remove point**.
5. Click **Finish editing**. The route automatically rebuilds with the updated points.
