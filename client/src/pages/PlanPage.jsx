import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleMarker, Marker, Popup, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import { api } from '../api.js';
import BaseMap from '../components/BaseMap.jsx';
import { parsePoints, samplePoints } from '../lib/points.js';
import { todayIso } from '../lib/format.js';

const depotIcon = L.divIcon({
  className: '',
  html: '<div class="depot-pin" aria-hidden="true">D</div>',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const EXAMPLE = `label,lat,lng
101 Oak St,30.5141,-97.6742
105 Oak St,30.5142,-97.6731
110 Elm St,30.5163,-97.6725`;

export default function PlanPage() {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const [points, setPoints] = useState([]);
  const [depot, setDepot] = useState(null);
  const [mode, setMode] = useState('none'); // 'none' | 'add' | 'depot'
  const [text, setText] = useState('');
  const [importMsg, setImportMsg] = useState(null);
  const [fitKey, setFitKey] = useState(0);
  const [form, setForm] = useState({ name: 'Route', serviceDate: todayIso(), routeCount: 1, returnToDepot: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function addPoints(newPoints, source) {
    setPoints((prev) => [...prev, ...newPoints]);
    setFitKey((k) => k + 1);
    setImportMsg({ ok: `Added ${newPoints.length} point${newPoints.length === 1 ? '' : 's'} from ${source}.` });
  }

  function importText(input, source) {
    const { points: parsed, errors } = parsePoints(input);
    if (parsed.length) addPoints(parsed, source);
    if (errors.length) {
      setImportMsg((m) => ({
        ok: parsed.length ? m?.ok : null,
        errors: errors.slice(0, 5).concat(errors.length > 5 ? [`…and ${errors.length - 5} more`] : []),
      }));
    } else if (!parsed.length) setImportMsg({ errors: ['No points found.'] });
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    importText(await file.text(), file.name);
    e.target.value = '';
  }

  function onMapClick({ lat, lng }) {
    const rounded = { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
    if (mode === 'add') setPoints((prev) => [...prev, { ...rounded, label: '' }]);
    else if (mode === 'depot') {
      setDepot(rounded);
      setMode('none');
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const result = await api('/plan', {
        method: 'POST',
        body: { ...form, routeCount: Number(form.routeCount), points, depot },
      });
      navigate('/', { state: { created: result.routes.map((r) => r.id), warnings: result.warnings } });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const bounds = [...points.map((p) => [p.lat, p.lng]), ...(depot ? [[depot.lat, depot.lng]] : [])];
  const perTruck = points.length ? Math.ceil(points.length / Math.max(1, Number(form.routeCount) || 1)) : 0;

  return (
    <main className="split">
      <section className="panel" aria-labelledby="plan-heading">
        <h1 id="plan-heading">Plan routes</h1>
        <p className="muted">Load GPS points, choose how many trucks, and the planner splits the stops into balanced routes that follow the roads.</p>

        <div className="card">
          <h2>1. Stops</h2>
          <label htmlFor="paste">Paste CSV (lat, lng, optional label)</label>
          <textarea id="paste" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} spellCheck={false} />
          <div className="row-actions">
            <button type="button" className="btn" disabled={!text.trim()} onClick={() => (importText(text, 'pasted text'), setText(''))}>
              Add pasted points
            </button>
            <button type="button" className="btn" onClick={() => fileRef.current.click()}>
              Upload CSV…
            </button>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" hidden onChange={onFile} />
            <button type="button" className="btn ghost" onClick={() => addPoints(samplePoints(), 'the sample')}>
              Load sample
            </button>
          </div>
          {importMsg && (
            <div className="import-msg" role="status">
              {importMsg.ok && <p className="ok">{importMsg.ok}</p>}
              {importMsg.errors?.map((e) => (
                <p key={e} className="err">
                  {e}
                </p>
              ))}
            </div>
          )}
          <div className="row-actions">
            <button type="button" className={`btn ${mode === 'add' ? 'active' : ''}`} aria-pressed={mode === 'add'} onClick={() => setMode(mode === 'add' ? 'none' : 'add')}>
              {mode === 'add' ? 'Done adding' : 'Click map to add stops'}
            </button>
            {points.length > 0 && (
              <button
                type="button"
                className="btn ghost danger"
                onClick={() => {
                  if (window.confirm(`Remove all ${points.length} points?`)) setPoints([]);
                }}
              >
                Clear all
              </button>
            )}
          </div>
          <p className="count">
            <strong>{points.length}</strong> stop{points.length === 1 ? '' : 's'} loaded
          </p>
        </div>

        <div className="card">
          <h2>2. Depot (optional)</h2>
          <p className="muted small">Where trucks start. Routes begin at the stop nearest the depot.</p>
          <div className="row-actions">
            <button type="button" className={`btn ${mode === 'depot' ? 'active' : ''}`} aria-pressed={mode === 'depot'} onClick={() => setMode(mode === 'depot' ? 'none' : 'depot')}>
              {mode === 'depot' ? 'Click the map…' : depot ? 'Move depot' : 'Set depot on map'}
            </button>
            {depot && (
              <button type="button" className="btn ghost" onClick={() => setDepot(null)}>
                Remove depot
              </button>
            )}
          </div>
          {depot && (
            <label className="check">
              <input type="checkbox" checked={form.returnToDepot} onChange={(e) => setForm({ ...form, returnToDepot: e.target.checked })} />
              Return to depot at the end
            </label>
          )}
        </div>

        <div className="card">
          <h2>3. Routes</h2>
          <div className="grid2">
            <label>
              Name
              <input value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              Service date
              <input type="date" value={form.serviceDate} onChange={(e) => setForm({ ...form, serviceDate: e.target.value })} />
            </label>
            <label>
              Number of trucks
              <input
                type="number"
                min={1}
                max={50}
                value={form.routeCount}
                onChange={(e) => setForm({ ...form, routeCount: e.target.value })}
              />
            </label>
            <p className="muted small per-truck">{perTruck ? `≈ ${perTruck} stops per truck` : ''}</p>
          </div>
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="btn primary block" disabled={!points.length || busy} onClick={generate}>
            {busy ? 'Planning routes…' : `Generate ${Number(form.routeCount) > 1 ? `${form.routeCount} routes` : 'route'}`}
          </button>
        </div>
      </section>

      <section className={`map-wrap mode-${mode}`} aria-label="Map of stops">
        {mode !== 'none' && (
          <div className="map-banner" role="status">
            {mode === 'add' ? 'Click the map to drop stops. Tap a stop to remove it.' : 'Click the map to place the depot.'}
          </div>
        )}
        <BaseMap bounds={bounds} fitKey={fitKey} onMapClick={onMapClick}>
          {points.map((p, i) => (
            <CircleMarker
              key={`${i}-${p.lat}-${p.lng}`}
              center={[p.lat, p.lng]}
              radius={6}
              // Don't let a click on a stop also count as a map click (which would add another stop).
              bubblingMouseEvents={false}
              pathOptions={{ color: '#fff', weight: 2, fillColor: '#00e5ff', fillOpacity: 0.95 }}
            >
              <Popup>
                <strong>{p.label || `Stop ${i + 1}`}</strong>
                <br />
                {p.lat.toFixed(5)}, {p.lng.toFixed(5)}
                <br />
                <button type="button" className="link-btn" onClick={() => setPoints((prev) => prev.filter((_, j) => j !== i))}>
                  Remove this stop
                </button>
              </Popup>
            </CircleMarker>
          ))}
          {depot && (
            <Marker position={[depot.lat, depot.lng]} icon={depotIcon}>
              <Tooltip direction="top" offset={[0, -14]}>
                Depot
              </Tooltip>
            </Marker>
          )}
        </BaseMap>
      </section>
    </main>
  );
}
