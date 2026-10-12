import { Router } from 'express';
import { transaction } from './db.js';
import { planRoutes } from './planner.js';

// Bright, distinct colours that stay visible over satellite imagery.
const ROUTE_COLORS = ['#00e5ff', '#ff3d71', '#ffd600', '#76ff03', '#ff9100', '#e040fb', '#1de9b6', '#ff6e40', '#448aff', '#eeff41'];
const STATUSES = new Set(['pending', 'picked_up', 'not_out']);
const MAX_POINTS = 5000;
const MAX_ROUTES = 50;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isLat = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const isLng = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parsePlanRequest(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Expected a JSON object');
  const { points, routeCount = 1, depot = null, returnToDepot = false, name = 'Route', serviceDate = '' } = body;

  if (!Array.isArray(points) || points.length === 0) throw new HttpError(400, 'Add at least one GPS point');
  if (points.length > MAX_POINTS) throw new HttpError(400, `At most ${MAX_POINTS} points per plan`);
  const clean = points.map((p, i) => {
    if (!p || !isLat(p.lat) || !isLng(p.lng)) throw new HttpError(400, `Point ${i + 1} needs a valid lat and lng`);
    const label = typeof p.label === 'string' ? p.label.trim().slice(0, 200) : '';
    return { lat: p.lat, lng: p.lng, label };
  });

  if (!Number.isInteger(routeCount) || routeCount < 1 || routeCount > MAX_ROUTES) {
    throw new HttpError(400, `Number of routes must be a whole number from 1 to ${MAX_ROUTES}`);
  }
  if (depot !== null && (!isLat(depot?.lat) || !isLng(depot?.lng))) throw new HttpError(400, 'Depot needs a valid lat and lng');
  if (typeof name !== 'string' || name.trim().length > 60) throw new HttpError(400, 'Name must be text up to 60 characters');
  if (serviceDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) throw new HttpError(400, 'Service date must be YYYY-MM-DD');

  return {
    points: clean,
    routeCount: Math.min(routeCount, clean.length),
    depot: depot && { lat: depot.lat, lng: depot.lng },
    returnToDepot: Boolean(returnToDepot),
    name: name.trim() || 'Route',
    serviceDate: serviceDate || today(),
  };
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Invalid id');
  return id;
}

function serializeRoute(row) {
  return {
    id: row.id,
    name: row.name,
    serviceDate: row.service_date,
    color: row.color,
    depot: row.depot_lat === null ? null : { lat: row.depot_lat, lng: row.depot_lng },
    returnToDepot: Boolean(row.return_to_depot),
    geometry: JSON.parse(row.geometry),
    distance: row.distance_m,
    duration: row.duration_s,
    roadSnapped: Boolean(row.road_snapped),
    createdAt: row.created_at,
    counts: {
      total: row.total ?? 0,
      picked_up: row.picked_up ?? 0,
      not_out: row.not_out ?? 0,
      pending: (row.total ?? 0) - (row.picked_up ?? 0) - (row.not_out ?? 0),
    },
  };
}

const serializeStop = (s) => ({
  id: s.id,
  routeId: s.route_id,
  seq: s.seq,
  lat: s.lat,
  lng: s.lng,
  label: s.label,
  status: s.status,
  statusAt: s.status_at,
  note: s.note,
});

const ROUTE_WITH_COUNTS = `
  SELECT r.*,
         COUNT(s.id) AS total,
         COALESCE(SUM(s.status = 'picked_up'), 0) AS picked_up,
         COALESCE(SUM(s.status = 'not_out'), 0) AS not_out
  FROM routes r LEFT JOIN stops s ON s.route_id = r.id`;

// Spreadsheet apps execute cells that start with these characters.
const csvCell = (value) => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function apiRouter({ db, routing }) {
  const router = Router();

  function getRoute(id) {
    const row = db.prepare(`${ROUTE_WITH_COUNTS} WHERE r.id = ? GROUP BY r.id`).get(id);
    if (!row) throw new HttpError(404, 'Route not found');
    return serializeRoute(row);
  }

  router.get('/routes', (req, res) => {
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    const rows = date
      ? db.prepare(`${ROUTE_WITH_COUNTS} WHERE r.service_date = ? GROUP BY r.id ORDER BY r.service_date DESC, r.id`).all(date)
      : db.prepare(`${ROUTE_WITH_COUNTS} GROUP BY r.id ORDER BY r.service_date DESC, r.id`).all();
    const routes = rows.map(serializeRoute);

    // Stops for the overview map, grouped by route.
    const stopRows = date
      ? db.prepare('SELECT s.* FROM stops s JOIN routes r ON r.id = s.route_id WHERE r.service_date = ? ORDER BY s.route_id, s.seq').all(date)
      : db.prepare('SELECT * FROM stops ORDER BY route_id, seq').all();
    const byRoute = new Map(routes.map((r) => [r.id, []]));
    for (const s of stopRows) byRoute.get(s.route_id)?.push(serializeStop(s));
    res.json(routes.map((r) => ({ ...r, stops: byRoute.get(r.id) })));
  });

  router.get('/routes/:id', (req, res) => {
    const route = getRoute(parseId(req.params.id));
    const stops = db.prepare('SELECT * FROM stops WHERE route_id = ? ORDER BY seq').all(route.id).map(serializeStop);
    res.json({ ...route, stops });
  });

  router.delete('/routes/:id', (req, res) => {
    const { changes } = db.prepare('DELETE FROM routes WHERE id = ?').run(parseId(req.params.id));
    if (!changes) throw new HttpError(404, 'Route not found');
    res.status(204).end();
  });

  router.get('/routes/:id/export.csv', (req, res) => {
    const route = getRoute(parseId(req.params.id));
    const stops = db.prepare('SELECT * FROM stops WHERE route_id = ? ORDER BY seq').all(route.id);
    const header = ['stop', 'label', 'lat', 'lng', 'status', 'status_time_utc', 'note'];
    const lines = [header, ...stops.map((s) => [s.seq, s.label, s.lat, s.lng, s.status, s.status_at, s.note])];
    const filename = `${route.name}-${route.serviceDate}`.replace(/[^\w.-]+/g, '_');
    res
      .type('text/csv')
      .attachment(`${filename}.csv`)
      .send(lines.map((line) => line.map(csvCell).join(',')).join('\r\n') + '\r\n');
  });

  router.patch('/stops/:id', (req, res) => {
    const id = parseId(req.params.id);
    const { status, note } = req.body || {};
    if (status !== undefined && !STATUSES.has(status)) throw new HttpError(400, 'Status must be pending, picked_up or not_out');
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) throw new HttpError(400, 'Note must be text up to 500 characters');
    if (status === undefined && note === undefined) throw new HttpError(400, 'Nothing to update');

    const stop = db.prepare('SELECT * FROM stops WHERE id = ?').get(id);
    if (!stop) throw new HttpError(404, 'Stop not found');

    if (status !== undefined && status !== stop.status) {
      db.prepare(
        `UPDATE stops SET status = ?, status_at = CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END WHERE id = ?`,
      ).run(status, status, id);
    }
    if (note !== undefined) db.prepare('UPDATE stops SET note = ? WHERE id = ?').run(note.trim(), id);

    res.json(serializeStop(db.prepare('SELECT * FROM stops WHERE id = ?').get(id)));
  });

  router.post('/plan', async (req, res) => {
    const plan = parsePlanRequest(req.body);
    const planned = await planRoutes(plan.points, plan, { travelTimes: routing.travelTimes });
    const warnings = [];

    // Road geometry from the routing server; fall back to straight lines if it's unavailable.
    const withRoads = [];
    for (const [i, route] of planned.entries()) {
      const waypoints = [
        ...(plan.depot ? [plan.depot] : []),
        ...route.stops,
        ...(plan.depot && plan.returnToDepot ? [plan.depot] : []),
      ];
      let road = null;
      try {
        road = await routing.route(waypoints);
      } catch (err) {
        warnings.push(`Route ${i + 1}: couldn't follow roads (${err.message}); showing straight lines instead.`);
      }
      withRoads.push({ ...route, waypoints, road });
    }

    const firstColor = db.prepare('SELECT COUNT(*) AS n FROM routes WHERE service_date = ?').get(plan.serviceDate).n;
    const ids = transaction(db, () =>
      withRoads.map((route, i) => {
        const name = withRoads.length > 1 ? `${plan.name} ${i + 1}` : plan.name;
        const geometry = route.road?.geometry ?? route.waypoints.map((p) => [p.lat, p.lng]);
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO routes (name, service_date, color, depot_lat, depot_lng, return_to_depot, geometry, distance_m, duration_s, road_snapped)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            name,
            plan.serviceDate,
            ROUTE_COLORS[(firstColor + i) % ROUTE_COLORS.length],
            plan.depot?.lat ?? null,
            plan.depot?.lng ?? null,
            plan.returnToDepot ? 1 : 0,
            JSON.stringify(geometry.map(([lat, lng]) => [+lat.toFixed(6), +lng.toFixed(6)])),
            route.road?.distance ?? route.straightDistance,
            route.road?.duration ?? null,
            route.road ? 1 : 0,
          );
        const routeId = Number(lastInsertRowid);
        const insertStop = db.prepare('INSERT INTO stops (route_id, seq, lat, lng, label) VALUES (?, ?, ?, ?, ?)');
        route.stops.forEach((s, seq) => insertStop.run(routeId, seq + 1, s.lat, s.lng, s.label));
        return routeId;
      }),
    );

    res.status(201).json({ routes: ids.map(getRoute), warnings });
  });

  router.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    next(err);
  });

  return router;
}
