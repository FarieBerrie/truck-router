# truck-router

Plan trash-pickup truck routes from GPS points, then run them from a phone on a satellite map. You mark each stop **Picked up** or **Trash not out** as you go.

**Stack:** React 18 · Leaflet · Vite · Node.js · Express 5 · SQLite (`node:sqlite`) · OSRM road routing · Esri World Imagery

## What it does

1. **Load stops.** Paste or upload a CSV of GPS points, click the map to drop stops, or load the built-in sample.
2. **Plan.** Choose how many trucks and an optional depot. The planner:
   - splits the stops into balanced groups, one per truck, each about the same size;
   - orders each group by real **drive time** between stops, from OSRM;
   - snaps each route to the road network, so the line on the map is the actual path, with mileage and an estimated drive time.
3. **Drive.** The driver view shows the route on satellite imagery with road labels and numbered stops. It has a big **Next stop** card with **Picked up** / **Not out** / **Directions** buttons, undo, notes for missed pickups, and the driver's live location. Finishing a stop moves straight on to the next one.
4. **Track.** The Routes page shows every truck's progress and refreshes every 30 seconds. Export any route's results to CSV.

## Getting started

Requires **Node.js 22.13+**. Node 24 is recommended because SQLite is built in.

```bash
npm install
npm run dev
```

Open http://localhost:5180, go to **Plan routes**, click **Load sample**, set the number of trucks, and click **Generate**.

| Script          | What it does                                               |
| --------------- | ---------------------------------------------------------- |
| `npm run dev`   | API on :3010 (auto-restart) + Vite dev server on :5180     |
| `npm test`      | Planner and API tests (no network needed)                  |
| `npm run build` | Build the client into `client/dist`                        |
| `npm start`     | Serve the API and the built client from one port (:3010)   |

## CSV format

A header row with `lat` and `lng` columns (`latitude`/`longitude` also work), plus an optional `label`, `name` or `address` column:

```csv
label,lat,lng
101 Oak St,30.5141,-97.6742
105 Oak St,30.5142,-97.6731
```

Rows without a header also work: `30.5141, -97.6742` or `101 Oak St, 30.5141, -97.6742`. Longitude-first coordinates are detected and swapped. Invalid rows are reported by line number and skipped.

## How the planning works

- **Splitting stops between trucks:** capacity-limited k-means. No truck gets more than about 10% over an even share, and nearby stops stay together. The result is deterministic, so the same input always gives the same routes.
- **Ordering each route:** nearest-neighbour, then 2-opt improvement, using OSRM's drive-time matrix for routes of up to 100 stops. One-way streets and other asymmetric costs are handled correctly. Larger routes, or any time OSRM is unavailable, fall back to straight-line distance.
- **Road geometry:** OSRM's `route` service, requested in overlapping chunks of 90 waypoints. If the service is down the route is still created, drawn as straight lines between stops, and you get a warning.

On the 60-stop sample with three trucks, ordering by drive time instead of straight-line distance cut total driving by about a quarter.

## API

| Method | Path                          | Description                                        |
| ------ | ----------------------------- | -------------------------------------------------- |
| POST   | `/api/plan`                   | `{ points, routeCount, depot?, returnToDepot?, name?, serviceDate? }` → routes |
| GET    | `/api/routes?date=YYYY-MM-DD` | Routes with progress counts, geometry and stops    |
| GET    | `/api/routes/:id`             | One route with its stops in order                  |
| DELETE | `/api/routes/:id`             | Delete a route and its stops                       |
| GET    | `/api/routes/:id/export.csv`  | Stop results as CSV                                |
| PATCH  | `/api/stops/:id`              | `{ status: "pending" \| "picked_up" \| "not_out", note? }` |

## Configuration

| Variable        | Default                           | Purpose                    |
| --------------- | --------------------------------- | -------------------------- |
| `PORT`          | `3010`                            | Server port                |
| `DATABASE_FILE` | `server/data/truck-router.db`     | SQLite file location       |
| `OSRM_URL`      | `https://router.project-osrm.org` | Road-routing server        |

## Before using this for real

- **Routing server:** the default OSRM server is a free public demo with no uptime guarantee, and it asks for light use only. For daily operations, [self-host OSRM](https://github.com/Project-OSRM/osrm-backend) with a truck profile, or use a commercial routing API, and set `OSRM_URL`.
- **Imagery:** Esri World Imagery tiles are free to view with attribution, but production use falls under Esri's terms of use. Check that they fit your organisation.
- **Logins:** there are no user accounts yet. Anyone with the URL can view routes and change stop status. Add authentication before putting real customer addresses online.

## Deploying

`render.yaml` is a Render Blueprint: a web service plus a 1 GB disk for the database. In Render, choose **New → Blueprint** and pick this repo. Any Node host with a persistent disk works the same way:

```bash
npm install --include=dev && npm run build
NODE_ENV=production DATABASE_FILE=/var/data/truck-router.db npm start
```
