// Route planning: split stops into balanced geographic groups (one per truck), then order
// each group into a short drivable sequence. Distances are straight-line (haversine);
// road geometry is added afterwards by the router (see osrm.js).

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Deterministic PRNG so the same input always produces the same routes. */
function seededRandom(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Capacity-constrained k-means. Returns arrays of point indices, one per group.
 * Each group holds at most ~10% more than an even share, so trucks get similar workloads.
 */
export function cluster(points, k, { seed = 42, slack = 1.1, maxIterations = 20 } = {}) {
  const n = points.length;
  k = Math.max(1, Math.min(Math.floor(k), n));
  if (n === 0) return [];
  if (k === 1) return [points.map((_, i) => i)];

  // k-means++ seeding: spread the initial centres out.
  const rand = seededRandom(seed + n);
  const centers = [{ ...points[Math.floor(rand() * n)] }];
  const nearest = new Float64Array(n).fill(Infinity);
  while (centers.length < k) {
    const last = centers[centers.length - 1];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = haversine(points[i], last) ** 2;
      if (d < nearest[i]) nearest[i] = d;
      total += nearest[i];
    }
    let r = rand() * total;
    let pick = 0;
    for (; pick < n - 1; pick++) {
      r -= nearest[pick];
      if (r <= 0) break;
    }
    centers.push({ lat: points[pick].lat, lng: points[pick].lng });
  }

  const capacity = Math.ceil((n / k) * slack);
  let assignment = new Int32Array(n).fill(-1);

  for (let iter = 0; iter < maxIterations; iter++) {
    // Greedy assignment, closest pairs first, skipping groups that are full.
    const pairs = [];
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) pairs.push([haversine(points[i], centers[c]), i, c]);
    pairs.sort((a, b) => a[0] - b[0]);

    const next = new Int32Array(n).fill(-1);
    const load = new Int32Array(k);
    let unassigned = n;
    for (const [, i, c] of pairs) {
      if (next[i] !== -1 || load[c] >= capacity) continue;
      next[i] = c;
      load[c]++;
      if (--unassigned === 0) break;
    }

    const changed = next.some((c, i) => c !== assignment[i]);
    assignment = next;

    const sums = Array.from({ length: k }, () => ({ lat: 0, lng: 0, count: 0 }));
    for (let i = 0; i < n; i++) {
      const s = sums[assignment[i]];
      s.lat += points[i].lat;
      s.lng += points[i].lng;
      s.count++;
    }
    sums.forEach((s, c) => {
      if (s.count) centers[c] = { lat: s.lat / s.count, lng: s.lng / s.count };
    });
    if (!changed) break;
  }

  const groups = Array.from({ length: k }, () => []);
  assignment.forEach((c, i) => groups[c].push(i));
  return groups.filter((g) => g.length > 0);
}

function reverse(arr, from, to) {
  while (from < to) {
    [arr[from], arr[to]] = [arr[to], arr[from]];
    from++;
    to--;
  }
}

/**
 * Orders stops into a short path: nearest-neighbour construction, then 2-opt improvement.
 * With `start` (the depot) the path begins there; with `closed` it also returns there.
 * `cost` is an optional travel-time matrix over [depot?, ...stops] (cost[i][j] = i → j, may be
 * asymmetric); without it, straight-line distance is used.
 * Returns the stop indices in driving order (the depot itself is not included).
 */
export function orderStops(stops, { start = null, closed = false, cost = null } = {}) {
  const n = stops.length;
  if (n <= 1) return stops.map((_, i) => i);

  // Node 0 is the depot when given; otherwise the path starts at the stop farthest from the
  // centre, which tends to be one natural end of the route.
  const nodes = start ? [start, ...stops] : [...stops];
  const offset = start ? 1 : 0;
  const m = nodes.length;
  if (cost && cost.length !== m) throw new Error(`Cost matrix is ${cost.length}×${cost.length}, expected ${m}×${m}`);

  // Precompute distances for typical route sizes; compute on the fly for very large ones.
  const useMatrix = m <= 1500;
  const symmetric = !cost;
  let dist;
  if (cost) {
    dist = (a, b) => cost[a][b];
  } else if (useMatrix) {
    const matrix = new Float64Array(m * m);
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        const d = haversine(nodes[i], nodes[j]);
        matrix[i * m + j] = d;
        matrix[j * m + i] = d;
      }
    }
    dist = (a, b) => matrix[a * m + b];
  } else {
    dist = (a, b) => haversine(nodes[a], nodes[b]);
  }

  let first = 0;
  if (!start) {
    const centre = {
      lat: stops.reduce((s, p) => s + p.lat, 0) / n,
      lng: stops.reduce((s, p) => s + p.lng, 0) / n,
    };
    let best = -1;
    stops.forEach((p, i) => {
      const d = haversine(p, centre);
      if (d > best) {
        best = d;
        first = i;
      }
    });
  }

  // Nearest-neighbour tour
  const tour = [first];
  const used = new Uint8Array(m);
  used[first] = 1;
  for (let step = 1; step < m; step++) {
    const from = tour[tour.length - 1];
    let bestNode = -1;
    let bestDist = Infinity;
    for (let j = 0; j < m; j++) {
      if (used[j]) continue;
      const d = dist(from, j);
      if (d < bestDist) {
        bestDist = d;
        bestNode = j;
      }
    }
    tour.push(bestNode);
    used[bestNode] = 1;
  }

  // With one-way or asymmetric travel times, reversing a segment also changes the cost of
  // driving it, so that part has to be summed explicitly.
  const segmentDelta = (from, to) => {
    if (symmetric) return 0;
    let forward = 0;
    let backward = 0;
    for (let k = from; k < to; k++) {
      forward += dist(tour[k], tour[k + 1]);
      backward += dist(tour[k + 1], tour[k]);
    }
    return backward - forward;
  };

  // 2-opt: reverse segments while that shortens the path. tour[0] stays fixed.
  const window = cost || useMatrix ? m : 60;
  const maxPasses = symmetric ? 50 : 20;
  let improved = true;
  for (let pass = 0; improved && pass < maxPasses; pass++) {
    improved = false;
    for (let i = 0; i < m - 2; i++) {
      const a = tour[i];
      const b = tour[i + 1];
      const jMax = Math.min(m - 1, i + window);
      for (let j = i + 2; j <= jMax; j++) {
        const c = tour[j];
        const d = j + 1 < m ? tour[j + 1] : closed ? tour[0] : -1;
        const before = dist(a, b) + (d >= 0 ? dist(c, d) : 0);
        const after = dist(a, c) + (d >= 0 ? dist(b, d) : 0) + segmentDelta(i + 1, j);
        if (after < before - 1e-6) {
          reverse(tour, i + 1, j);
          improved = true;
        }
      }
    }
  }

  return tour.filter((node) => node >= offset).map((node) => node - offset);
}

/** Straight-line length of depot → stops (→ depot). */
export function pathLength(stops, { start = null, closed = false } = {}) {
  const path = [...(start ? [start] : []), ...stops, ...(start && closed ? [start] : [])];
  let total = 0;
  for (let i = 1; i < path.length; i++) total += haversine(path[i - 1], path[i]);
  return total;
}

/**
 * Splits points into `routeCount` routes and orders each one.
 * `travelTimes(nodes)` (optional, async) returns a drive-time matrix for [depot?, ...stops];
 * routes it can't handle (too many stops, service down) fall back to straight-line ordering.
 * Routes come back sorted west → east so numbering is predictable.
 */
export async function planRoutes(points, { routeCount = 1, depot = null, returnToDepot = false } = {}, { travelTimes } = {}) {
  const closed = Boolean(depot && returnToDepot);
  const groups = cluster(points, routeCount)
    .map((group) => group.map((i) => points[i]))
    .map((members) => ({ members, centreLng: members.reduce((s, p) => s + p.lng, 0) / members.length }))
    .sort((a, b) => a.centreLng - b.centreLng);

  const routes = [];
  for (const { members } of groups) {
    let cost = null;
    if (travelTimes) {
      try {
        cost = await travelTimes(depot ? [depot, ...members] : members);
      } catch {
        cost = null;
      }
    }
    const order = orderStops(members, { start: depot, closed, cost });
    const stops = order.map((i) => members[i]);
    routes.push({ stops, straightDistance: pathLength(stops, { start: depot, closed }), orderedBy: cost ? 'drive-time' : 'distance' });
  }
  return routes;
}
