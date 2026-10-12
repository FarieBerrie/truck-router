import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CircleMarker, Polyline, Tooltip } from 'react-leaflet';
import { api } from '../api.js';
import BaseMap from '../components/BaseMap.jsx';
import Progress from '../components/Progress.jsx';
import { formatDate, formatDistance, formatDuration } from '../lib/format.js';

const STATUS_FILL = { pending: '#e2e8f0', picked_up: '#22c55e', not_out: '#f97316' };
const REFRESH_MS = 30000;

export default function RoutesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [routes, setRoutes] = useState(null);
  const [error, setError] = useState(null);
  const [date, setDate] = useState('all');
  const [notice] = useState(location.state); // { created, warnings } after planning

  const load = useCallback(() => {
    api('/routes')
      .then((r) => {
        setRoutes(r);
        setError(null);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
    // Clear the one-time "routes created" state so a refresh doesn't show it again.
    if (location.state) navigate('.', { replace: true, state: null });
    // Keep progress current while drivers work.
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const dates = useMemo(() => [...new Set((routes || []).map((r) => r.serviceDate))].sort().reverse(), [routes]);
  const shown = (routes || []).filter((r) => date === 'all' || r.serviceDate === date);
  const bounds = shown.flatMap((r) => r.stops.map((s) => [s.lat, s.lng]));
  const totals = shown.reduce(
    (t, r) => ({
      total: t.total + r.counts.total,
      picked_up: t.picked_up + r.counts.picked_up,
      not_out: t.not_out + r.counts.not_out,
    }),
    { total: 0, picked_up: 0, not_out: 0 },
  );

  async function remove(route) {
    if (!window.confirm(`Delete "${route.name}" and its ${route.counts.total} stops? This can't be undone.`)) return;
    try {
      await api(`/routes/${route.id}`, { method: 'DELETE' });
      setRoutes((prev) => prev.filter((r) => r.id !== route.id));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <main className="split">
      <section className="panel" aria-labelledby="routes-heading">
        <div className="panel-head">
          <h1 id="routes-heading">Routes</h1>
          {dates.length > 1 && (
            <label className="inline">
              <span className="sr-only">Service date</span>
              <select value={date} onChange={(e) => setDate(e.target.value)}>
                <option value="all">All dates</option>
                {dates.map((d) => (
                  <option key={d} value={d}>
                    {formatDate(d)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {notice?.created && (
          <div className="notice ok" role="status">
            Created {notice.created.length} route{notice.created.length === 1 ? '' : 's'}.
            {notice.warnings?.map((w) => (
              <p key={w} className="warn">
                {w}
              </p>
            ))}
          </div>
        )}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}

        {routes && shown.length > 0 && (
          <div className="card summary">
            <h2 className="eyebrow">
              Overall · {date === 'all' ? 'all dates' : formatDate(date)} · {shown.length} route{shown.length === 1 ? '' : 's'}
            </h2>
            <Progress counts={totals} large />
          </div>
        )}

        {routes === null && !error && <p className="muted">Loading routes…</p>}
        {routes?.length === 0 && (
          <div className="empty card">
            <h2>No routes yet</h2>
            <p className="muted">Load your GPS points and generate routes for your trucks.</p>
            <Link to="/plan" className="btn primary">
              Plan routes
            </Link>
          </div>
        )}

        <ul className="route-list">
          {shown.map((r) => (
            <li key={r.id} className={`card route-card${notice?.created?.includes(r.id) ? ' new' : ''}`} style={{ '--route': r.color }}>
              <Link to={`/routes/${r.id}`} className="route-link">
                <span className="swatch" aria-hidden="true" />
                <span className="route-title">
                  <strong>{r.name}</strong>
                  <span className="muted small">
                    {formatDate(r.serviceDate)} · {r.counts.total} stops · {formatDistance(r.distance)}
                    {formatDuration(r.duration) && ` · ~${formatDuration(r.duration)} driving`}
                    {!r.roadSnapped && ' · straight-line'}
                  </span>
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </Link>
              <Progress counts={r.counts} />
              <div className="row-actions end">
                <a className="btn small ghost" href={`/api/routes/${r.id}/export.csv`}>
                  Export CSV
                </a>
                <button type="button" className="btn small ghost danger" onClick={() => remove(r)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="map-wrap" aria-label="Map of all routes">
        <BaseMap bounds={bounds} fitKey={`${date}:${shown.length}:${routes === null}`}>
          {shown.map((r) => (
            <Polyline
              key={`line-${r.id}`}
              positions={r.geometry}
              pathOptions={{ color: r.color, weight: 5, opacity: 0.9 }}
              eventHandlers={{ click: () => navigate(`/routes/${r.id}`) }}
            >
              <Tooltip sticky>{r.name}</Tooltip>
            </Polyline>
          ))}
          {shown.flatMap((r) =>
            r.stops.map((s) => (
              <CircleMarker
                key={s.id}
                center={[s.lat, s.lng]}
                radius={5}
                pathOptions={{ color: r.color, weight: 2, fillColor: STATUS_FILL[s.status], fillOpacity: 1 }}
              />
            )),
          )}
        </BaseMap>
      </section>
    </main>
  );
}
