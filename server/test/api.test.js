import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { haversine } from '../src/planner.js';

let server;
let base;
let routerMode = 'ok';
const routerCalls = [];

// Stand-ins for OSRM: geometry is the waypoints themselves; travel times are straight-line
// seconds at 10 m/s. Both fail on demand.
async function fakeRouter(waypoints) {
  routerCalls.push(waypoints.length);
  if (routerMode === 'fail') throw new Error('server down');
  return { geometry: waypoints.map((p) => [p.lat, p.lng]), distance: 1234, duration: 300 };
}

let tableCalls = 0;
async function fakeTravelTimes(points) {
  tableCalls++;
  if (routerMode === 'fail') throw new Error('server down');
  return points.map((a) => points.map((b) => haversine(a, b) / 10));
}

before(async () => {
  const app = createApp({ db: openDb(':memory:'), routing: { route: fakeRouter, travelTimes: fakeTravelTimes } });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const data = res.status === 204 ? null : type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}

const grid = (n) =>
  Array.from({ length: n }, (_, i) => ({ lat: 30.5 + (i % 10) * 0.001, lng: -97.7 + Math.floor(i / 10) * 0.001, label: `${100 + i} Main St` }));

describe('planning', () => {
  test('rejects bad input', async () => {
    assert.equal((await call('/plan', { method: 'POST', body: { points: [] } })).status, 400);
    assert.equal((await call('/plan', { method: 'POST', body: { points: [{ lat: 95, lng: 0 }] } })).status, 400);
    assert.equal((await call('/plan', { method: 'POST', body: { points: grid(3), routeCount: 0 } })).status, 400);
    assert.equal((await call('/plan', { method: 'POST', body: { points: grid(3), serviceDate: 'tomorrow' } })).status, 400);
  });

  test('creates balanced routes that cover every point', async () => {
    const { status, data } = await call('/plan', {
      method: 'POST',
      body: { points: grid(40), routeCount: 2, name: 'Tuesday', serviceDate: '2026-10-13', depot: { lat: 30.49, lng: -97.71 }, returnToDepot: true },
    });
    assert.equal(status, 201);
    assert.equal(data.routes.length, 2);
    assert.deepEqual(data.warnings, []);
    assert.deepEqual(data.routes.map((r) => r.name), ['Tuesday 1', 'Tuesday 2']);
    assert.equal(data.routes.reduce((s, r) => s + r.counts.total, 0), 40);
    for (const r of data.routes) {
      assert.equal(r.roadSnapped, true);
      assert.equal(r.serviceDate, '2026-10-13');
      assert.ok(r.counts.total >= 18 && r.counts.total <= 22);
    }
    // Depot + stops + return to depot
    assert.deepEqual(routerCalls.slice(-2), data.routes.map((r) => r.counts.total + 2));
    assert.ok(tableCalls >= 2, 'stops should be ordered by drive time');
  });

  test('falls back to straight lines when routing fails', async () => {
    routerMode = 'fail';
    try {
      const { status, data } = await call('/plan', { method: 'POST', body: { points: grid(5) } });
      assert.equal(status, 201);
      assert.equal(data.routes[0].roadSnapped, false);
      assert.equal(data.warnings.length, 1);
      assert.equal(data.routes[0].geometry.length, 5);
    } finally {
      routerMode = 'ok';
    }
  });
});

describe('stops', () => {
  test('route detail lists stops in order, and status updates persist', async () => {
    const { data: plan } = await call('/plan', { method: 'POST', body: { points: grid(6), name: 'Detail' } });
    const { data: route } = await call(`/routes/${plan.routes[0].id}`);
    assert.deepEqual(route.stops.map((s) => s.seq), [1, 2, 3, 4, 5, 6]);
    assert.ok(route.stops.every((s) => s.status === 'pending' && s.statusAt === null));

    const [a, b] = route.stops;
    const picked = await call(`/stops/${a.id}`, { method: 'PATCH', body: { status: 'picked_up' } });
    assert.equal(picked.status, 200);
    assert.equal(picked.data.status, 'picked_up');
    assert.ok(picked.data.statusAt);

    await call(`/stops/${b.id}`, { method: 'PATCH', body: { status: 'not_out', note: 'Bin behind gate' } });
    const { data: after } = await call(`/routes/${route.id}`);
    assert.deepEqual(after.counts, { total: 6, picked_up: 1, not_out: 1, pending: 4 });
    assert.equal(after.stops[1].note, 'Bin behind gate');

    const undone = await call(`/stops/${a.id}`, { method: 'PATCH', body: { status: 'pending' } });
    assert.equal(undone.data.statusAt, null);
  });

  test('rejects unknown statuses and stops', async () => {
    const { data: plan } = await call('/plan', { method: 'POST', body: { points: grid(1) } });
    const { data: route } = await call(`/routes/${plan.routes[0].id}`);
    assert.equal((await call(`/stops/${route.stops[0].id}`, { method: 'PATCH', body: { status: 'lost' } })).status, 400);
    assert.equal((await call('/stops/999999', { method: 'PATCH', body: { status: 'picked_up' } })).status, 404);
    assert.equal((await call('/stops/abc', { method: 'PATCH', body: { status: 'picked_up' } })).status, 400);
  });
});

describe('routes', () => {
  test('list filters by date and includes stops', async () => {
    const { data } = await call('/routes?date=2026-10-13');
    assert.equal(data.length, 2);
    assert.ok(data.every((r) => r.serviceDate === '2026-10-13' && r.stops.length === r.counts.total));
  });

  test('CSV export escapes formulas', async () => {
    const { data: plan } = await call('/plan', {
      method: 'POST',
      body: { points: [{ lat: 30.5, lng: -97.7, label: '=HYPERLINK("http://evil")' }], name: 'Export' },
    });
    const { status, data, headers } = await call(`/routes/${plan.routes[0].id}/export.csv`);
    assert.equal(status, 200);
    assert.match(headers.get('content-type'), /text\/csv/);
    assert.match(data, /^stop,label,lat,lng,status/);
    assert.match(data, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
  });

  test('delete removes the route and its stops', async () => {
    const { data: plan } = await call('/plan', { method: 'POST', body: { points: grid(2) } });
    const id = plan.routes[0].id;
    const { data: route } = await call(`/routes/${id}`);
    assert.equal((await call(`/routes/${id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await call(`/routes/${id}`)).status, 404);
    assert.equal((await call(`/stops/${route.stops[0].id}`, { method: 'PATCH', body: { status: 'picked_up' } })).status, 404);
  });
});
