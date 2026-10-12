import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Circle, CircleMarker, Marker, Polyline, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { api } from '../api.js';
import BaseMap from '../components/BaseMap.jsx';
import Progress from '../components/Progress.jsx';
import { STATUS_LABELS, directionsUrl, formatDate, formatDistance, formatDuration, formatTime } from '../lib/format.js';

const REFRESH_MS = 20000;

function stopIcon(stop, { color, isNext, selected }) {
  const classes = ['stop-pin', `s-${stop.status}`, isNext && 'next', selected && 'selected'].filter(Boolean).join(' ');
  const glyph = stop.status === 'picked_up' ? '✓' : stop.status === 'not_out' ? '✕' : stop.seq;
  return L.divIcon({
    className: '',
    html: `<div class="${classes}" style="--route:${color}">${glyph}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

const depotIcon = L.divIcon({ className: '', html: '<div class="depot-pin">D</div>', iconSize: [30, 30], iconAnchor: [15, 15] });

/** Pans to `focus` whenever its key changes. */
function MapFocus({ focus }) {
  const map = useMap();
  useEffect(() => {
    if (focus) map.flyTo([focus.lat, focus.lng], Math.max(map.getZoom(), 18), { duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);
  return null;
}

function useGeolocation(enabled) {
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!enabled) {
      setPosition(null);
      return;
    }
    if (!navigator.geolocation) {
      setError('This browser cannot share your location.');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setPosition({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
        setError(null);
      },
      (err) => setError(err.code === 1 ? 'Location permission was denied.' : 'Could not get your location.'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);
  return { position, error };
}

function StopActions({ stop, onStatus, onNote, big = false }) {
  const who = `stop ${stop.seq}${stop.label ? `, ${stop.label}` : ''}`;
  return (
    <div className={`stop-actions${big ? ' big' : ''}`}>
      {stop.status === 'pending' ? (
        <>
          <button type="button" className="act picked" onClick={() => onStatus(stop, 'picked_up')} aria-label={`Mark ${who} as picked up`}>
            <span aria-hidden="true">✓</span> Picked up
          </button>
          <button type="button" className="act notout" onClick={() => onStatus(stop, 'not_out')} aria-label={`Mark ${who} as trash not out`}>
            <span aria-hidden="true">✕</span> Not out
          </button>
        </>
      ) : (
        <button type="button" className="act undo" onClick={() => onStatus(stop, 'pending')} aria-label={`Undo ${who}`}>
          Undo
        </button>
      )}
      {big && (
        <a className="act dir" href={directionsUrl(stop)} target="_blank" rel="noreferrer" aria-label={`Directions to ${who}`}>
          Directions ↗
        </a>
      )}
      {!big && stop.status === 'not_out' && (
        <button type="button" className="act ghost" onClick={() => onNote(stop)} aria-label={`${stop.note ? 'Edit' : 'Add'} note for ${who}`}>
          {stop.note ? 'Edit note' : 'Add note'}
        </button>
      )}
    </div>
  );
}

export default function RoutePage() {
  const { id } = useParams();
  const [route, setRoute] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [focus, setFocus] = useState(null);
  const [locate, setLocate] = useState(false);
  const inFlight = useRef(0);
  const itemRefs = useRef(new Map());
  const { position, error: geoError } = useGeolocation(locate);

  const load = useCallback(
    (initial = false) => {
      if (inFlight.current > 0) return; // don't overwrite optimistic updates
      api(`/routes/${id}`)
        .then((r) => {
          setRoute(r);
          setError(null);
          if (initial) document.title = `${r.name} · Truck Router`;
        })
        .catch((err) => setError(err.status === 404 ? 'This route no longer exists.' : err.message));
    },
    [id],
  );

  useEffect(() => {
    load(true);
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const stops = route?.stops ?? [];
  const next = stops.find((s) => s.status === 'pending');
  const counts = useMemo(() => {
    const c = { total: stops.length, picked_up: 0, not_out: 0 };
    for (const s of stops) if (s.status !== 'pending') c[s.status]++;
    return c;
  }, [stops]);
  const done = counts.picked_up + counts.not_out;

  const select = useCallback((stop, { pan = true, scroll = false } = {}) => {
    setSelectedId(stop.id);
    if (pan) setFocus({ lat: stop.lat, lng: stop.lng, key: `${stop.id}-${Date.now()}` });
    if (scroll) itemRefs.current.get(stop.id)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  // Optimistic: show the change immediately, roll back if the server rejects it.
  async function updateStop(stop, patch, localOnly = {}) {
    const previous = stop;
    setRoute((r) => ({ ...r, stops: r.stops.map((s) => (s.id === stop.id ? { ...s, ...patch, ...localOnly } : s)) }));
    inFlight.current++;
    try {
      const saved = await api(`/stops/${stop.id}`, { method: 'PATCH', body: patch });
      setRoute((r) => ({ ...r, stops: r.stops.map((s) => (s.id === saved.id ? saved : s)) }));
      setError(null);
      return true;
    } catch (err) {
      setRoute((r) => ({ ...r, stops: r.stops.map((s) => (s.id === previous.id ? previous : s)) }));
      setError(`Couldn't save stop ${stop.seq}: ${err.message}`);
      return false;
    } finally {
      inFlight.current--;
    }
  }

  async function setStatus(stop, status) {
    const ok = await updateStop(stop, { status }, { statusAt: null });
    // After finishing a stop, move on to the next pending one.
    if (ok && status !== 'pending') {
      const upcoming = stops.find((s) => s.status === 'pending' && s.id !== stop.id && s.seq > stop.seq) ?? stops.find((s) => s.status === 'pending' && s.id !== stop.id);
      if (upcoming) select(upcoming, { scroll: true });
    }
  }

  function editNote(stop) {
    const note = window.prompt(`Note for stop ${stop.seq}${stop.label ? ` (${stop.label})` : ''}:`, stop.note);
    if (note !== null) updateStop(stop, { note: note.slice(0, 500) });
  }

  if (error && !route) {
    return (
      <main className="center">
        <div className="card empty">
          <p className="err">{error}</p>
          <Link to="/" className="btn">
            Back to routes
          </Link>
        </div>
      </main>
    );
  }
  if (!route) return <main className="center muted">Loading route…</main>;

  const visible = stops.filter((s) => (filter === 'all' ? true : filter === 'left' ? s.status === 'pending' : s.status !== 'pending'));
  const bounds = [...stops.map((s) => [s.lat, s.lng]), ...(route.depot ? [[route.depot.lat, route.depot.lng]] : [])];

  return (
    <main className="split driver" style={{ '--route': route.color }}>
      <section className="panel" aria-labelledby="route-heading">
        <Link to="/" className="back">
          ← All routes
        </Link>
        <div className="route-head">
          <span className="swatch" aria-hidden="true" />
          <div>
            <h1 id="route-heading">{route.name}</h1>
            <p className="muted small">
              {formatDate(route.serviceDate)} · {stops.length} stops · {formatDistance(route.distance)}
              {formatDuration(route.duration) && ` · ~${formatDuration(route.duration)} driving`}
            </p>
          </div>
        </div>
        {!route.roadSnapped && <p className="warn small">The road-routing service was unavailable when this route was planned, so the line is straight between stops.</p>}

        <Progress counts={counts} large />

        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}

        {next ? (
          <div className="card next-card" aria-live="polite">
            <p className="eyebrow">
              Next stop · {done} of {stops.length} done
            </p>
            <button type="button" className="next-title" onClick={() => select(next, { scroll: true })}>
              <span className="seq-badge">{next.seq}</span>
              <span>
                <strong>{next.label || 'Unlabelled stop'}</strong>
                <span className="muted small coords">
                  {next.lat.toFixed(5)}, {next.lng.toFixed(5)}
                </span>
              </span>
            </button>
            <StopActions stop={next} onStatus={setStatus} onNote={editNote} big />
          </div>
        ) : (
          <div className="card next-card complete" aria-live="polite">
            <p className="eyebrow">Route complete</p>
            <p>
              <strong>All {stops.length} stops done</strong> — {counts.picked_up} picked up, {counts.not_out} not out.
            </p>
            <a className="btn" href={`/api/routes/${route.id}/export.csv`}>
              Export results (CSV)
            </a>
          </div>
        )}

        <div className="tabs" role="tablist" aria-label="Filter stops">
          {[
            ['all', `All (${stops.length})`],
            ['left', `Left (${stops.length - done})`],
            ['done', `Done (${done})`],
          ].map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>

        <ol className="stop-list">
          {visible.map((s) => (
            <li
              key={s.id}
              ref={(el) => (el ? itemRefs.current.set(s.id, el) : itemRefs.current.delete(s.id))}
              className={`stop-item s-${s.status}${s.id === selectedId ? ' selected' : ''}${s.id === next?.id ? ' is-next' : ''}`}
            >
              <button type="button" className="stop-main" onClick={() => select(s)} aria-current={s.id === selectedId ? 'true' : undefined}>
                <span className="seq-badge">{s.seq}</span>
                <span className="stop-text">
                  <strong>{s.label || `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`}</strong>
                  <span className={`status-text s-${s.status}`}>
                    {STATUS_LABELS[s.status]}
                    {s.statusAt && ` · ${formatTime(s.statusAt)}`}
                  </span>
                  {s.note && <span className="note">“{s.note}”</span>}
                </span>
              </button>
              <StopActions stop={s} onStatus={setStatus} onNote={editNote} />
            </li>
          ))}
        </ol>
        {visible.length === 0 && <p className="muted center-text">{filter === 'left' ? 'Nothing left on this route.' : 'No stops done yet.'}</p>}
      </section>

      <section className="map-wrap" aria-label={`Map of ${route.name}`}>
        <div className="map-tools">
          <button type="button" className={`btn small ${locate ? 'active' : ''}`} aria-pressed={locate} onClick={() => setLocate((v) => !v)}>
            {locate ? 'Hide my location' : 'Show my location'}
          </button>
          {locate && position && (
            <button type="button" className="btn small" onClick={() => setFocus({ ...position, key: `me-${Date.now()}` })}>
              Center on me
            </button>
          )}
        </div>
        {geoError && locate && (
          <div className="map-banner warn" role="alert">
            {geoError}
          </div>
        )}
        <BaseMap bounds={bounds} fitKey={route.id}>
          <Polyline positions={route.geometry} pathOptions={{ color: '#000', weight: 9, opacity: 0.35 }} interactive={false} />
          <Polyline positions={route.geometry} pathOptions={{ color: route.color, weight: 5, opacity: 0.95 }} interactive={false} />
          {route.depot && (
            <Marker position={[route.depot.lat, route.depot.lng]} icon={depotIcon}>
              <Tooltip direction="top" offset={[0, -14]}>
                Depot
              </Tooltip>
            </Marker>
          )}
          {stops.map((s) => (
            <Marker
              key={s.id}
              position={[s.lat, s.lng]}
              icon={stopIcon(s, { color: route.color, isNext: s.id === next?.id, selected: s.id === selectedId })}
              zIndexOffset={s.id === next?.id ? 1000 : s.id === selectedId ? 900 : s.status === 'pending' ? 100 : 0}
              title={`Stop ${s.seq}${s.label ? `: ${s.label}` : ''} (${STATUS_LABELS[s.status]})`}
              eventHandlers={{
                click: () => {
                  if (filter !== 'all') setFilter('all');
                  select(s, { pan: false, scroll: true });
                },
              }}
            />
          ))}
          {position && (
            <>
              <Circle center={[position.lat, position.lng]} radius={position.accuracy} pathOptions={{ color: '#3b82f6', weight: 1, fillOpacity: 0.12 }} interactive={false} />
              <CircleMarker center={[position.lat, position.lng]} radius={8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#3b82f6', fillOpacity: 1 }}>
                <Tooltip>You are here</Tooltip>
              </CircleMarker>
            </>
          )}
          <MapFocus focus={focus} />
        </BaseMap>
      </section>
    </main>
  );
}
