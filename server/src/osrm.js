// Road routing via an OSRM server:
//  - route(waypoints): road geometry, distance and duration through ordered waypoints. Long routes
//    are requested in overlapping chunks so they stay under server waypoint limits.
//  - travelTimes(points): drive-time matrix used to order stops (≤ 100 points per request).

import { haversine } from './planner.js';

const ROUTE_CHUNK = 90;
export const MAX_TABLE_POINTS = 100;

const coordList = (points) => points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');

export function createOsrmClient(baseUrl = 'https://router.project-osrm.org', { timeoutMs = 20000 } = {}) {
  const base = baseUrl.replace(/\/$/, '');

  async function get(path) {
    const res = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'truck-router (route planning demo)' },
    });
    if (!res.ok) throw new Error(`Routing server responded ${res.status}`);
    const body = await res.json();
    if (body.code !== 'Ok') throw new Error(`Routing failed: ${body.code || 'unknown error'}`);
    return body;
  }

  async function route(waypoints) {
    if (waypoints.length < 2) return null;
    const geometry = [];
    let distance = 0;
    let duration = 0;

    for (let from = 0; from < waypoints.length - 1; from += ROUTE_CHUNK - 1) {
      const slice = waypoints.slice(from, from + ROUTE_CHUNK);
      const body = await get(`/route/v1/driving/${coordList(slice)}?overview=full&geometries=geojson`);
      if (!body.routes?.length) throw new Error('Routing failed: no route');
      const leg = body.routes[0];
      const points = leg.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      geometry.push(...(geometry.length ? points.slice(1) : points));
      distance += leg.distance;
      duration += leg.duration;
    }
    return { geometry, distance, duration };
  }

  async function travelTimes(points) {
    if (points.length < 2 || points.length > MAX_TABLE_POINTS) return null;
    const body = await get(`/table/v1/driving/${coordList(points)}?annotations=duration`);
    // Unreachable pairs come back as null: treat them as a slow straight-line crawl.
    return body.durations.map((row, i) => row.map((t, j) => (t ?? haversine(points[i], points[j]) / 2)));
  }

  return { route, travelTimes };
}
