import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cluster, haversine, orderStops, pathLength, planRoutes } from '../src/planner.js';

// Deterministic pseudo-random points in a ~3 km box.
function randomPoints(n, seed = 1) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, () => ({ lat: 30.5 + rand() * 0.03, lng: -97.7 + rand() * 0.03 }));
}

describe('haversine', () => {
  test('one degree of latitude is about 111 km', () => {
    const d = haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    assert.ok(Math.abs(d - 111195) < 50, `got ${d}`);
  });
  test('same point is zero', () => {
    assert.equal(haversine({ lat: 30, lng: -97 }, { lat: 30, lng: -97 }), 0);
  });
});

describe('cluster', () => {
  test('assigns every point exactly once', () => {
    const points = randomPoints(97);
    const groups = cluster(points, 4);
    const all = groups.flat().sort((a, b) => a - b);
    assert.deepEqual(all, points.map((_, i) => i));
  });

  test('keeps group sizes balanced', () => {
    const groups = cluster(randomPoints(200), 5);
    assert.equal(groups.length, 5);
    for (const g of groups) assert.ok(g.length <= Math.ceil((200 / 5) * 1.1), `group of ${g.length}`);
  });

  test('separates two distant neighbourhoods', () => {
    const west = randomPoints(20, 3).map((p) => ({ lat: p.lat, lng: p.lng - 0.5 }));
    const east = randomPoints(20, 7).map((p) => ({ lat: p.lat, lng: p.lng + 0.5 }));
    const groups = cluster([...west, ...east], 2);
    const sides = groups.map((g) => new Set(g.map((i) => (i < 20 ? 'west' : 'east'))));
    assert.ok(sides.every((s) => s.size === 1), 'each group should be one neighbourhood');
  });

  test('never makes more groups than points', () => {
    assert.equal(cluster(randomPoints(3), 10).length, 3);
  });

  test('is deterministic', () => {
    const points = randomPoints(60);
    assert.deepEqual(cluster(points, 3), cluster(points, 3));
  });
});

describe('orderStops', () => {
  test('returns a permutation', () => {
    const stops = randomPoints(50);
    const order = orderStops(stops);
    assert.deepEqual([...order].sort((a, b) => a - b), stops.map((_, i) => i));
  });

  test('walks points on a line in order', () => {
    const line = [5, 1, 4, 0, 3, 2].map((x) => ({ lat: 30, lng: -97 + x * 0.001 }));
    const order = orderStops(line, { start: { lat: 30, lng: -97.01 } });
    assert.deepEqual(order.map((i) => line[i].lng), [...line.map((p) => p.lng)].sort((a, b) => a - b));
  });

  test('is much shorter than a random order', () => {
    const stops = randomPoints(120, 11);
    const ordered = orderStops(stops).map((i) => stops[i]);
    assert.ok(pathLength(ordered) < pathLength(stops) * 0.35);
  });

  test('starts nearest the depot', () => {
    const stops = randomPoints(30, 5);
    const depot = { lat: 30.49, lng: -97.71 };
    const first = stops[orderStops(stops, { start: depot })[0]];
    const closest = Math.min(...stops.map((s) => haversine(depot, s)));
    // 2-opt can trade the very first stop for a shorter total, but it should still be close.
    assert.ok(haversine(depot, first) <= closest * 2.5);
  });
});

describe('planRoutes', () => {
  test('includes every point once across routes', async () => {
    const points = randomPoints(80).map((p, i) => ({ ...p, label: `Stop ${i}` }));
    const routes = await planRoutes(points, { routeCount: 3 });
    assert.equal(routes.length, 3);
    const labels = routes.flatMap((r) => r.stops.map((s) => s.label)).sort();
    assert.deepEqual(labels, points.map((p) => p.label).sort());
    for (const r of routes) assert.ok(r.straightDistance > 0);
  });

  test('orders by drive time when available, and falls back when it fails', async () => {
    const points = randomPoints(12, 9);
    const timed = await planRoutes(points, { routeCount: 1 }, { travelTimes: async (nodes) => nodes.map((a) => nodes.map((b) => haversine(a, b))) });
    assert.equal(timed[0].orderedBy, 'drive-time');
    const failed = await planRoutes(points, { routeCount: 1 }, { travelTimes: async () => { throw new Error('down'); } });
    assert.equal(failed[0].orderedBy, 'distance');
    assert.equal(failed[0].stops.length, 12);
  });
});

describe('orderStops with a travel-time matrix', () => {
  test('respects one-way costs', () => {
    // Three stops in a row from the depot (node 0). Driving "backwards" is very expensive,
    // as on a one-way street, so the only cheap order is 1 → 2 → 3.
    const stops = [1, 2, 3].map((x) => ({ lat: 30, lng: -97 + x * 0.001 }));
    const cost = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (j >= i ? (j - i) * 10 : (i - j) * 1000)));
    assert.deepEqual(orderStops(stops, { start: { lat: 30, lng: -97 }, cost }), [0, 1, 2]);
  });

  test('can choose a different order from straight-line distance', () => {
    // Stop B is physically closer to the depot, but stop A is quicker to reach by road.
    const stops = [
      { lat: 30.01, lng: -97 }, // A
      { lat: 30.001, lng: -97 }, // B
    ];
    const cost = [
      [0, 60, 600],
      [60, 0, 60],
      [600, 60, 0],
    ];
    const depot = { lat: 30, lng: -97 };
    assert.deepEqual(orderStops(stops, { start: depot }), [1, 0]);
    assert.deepEqual(orderStops(stops, { start: depot, cost }), [0, 1]);
  });

  test('rejects a matrix of the wrong size', () => {
    assert.throws(() => orderStops(randomPoints(3), { cost: [[0]] }), /Cost matrix/);
  });
});
