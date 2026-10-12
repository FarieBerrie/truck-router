// Turning pasted or uploaded text into GPS points.
// Accepts CSV/TSV with a header (lat/latitude, lng/lon/longitude, optional label/name/address)
// or headerless rows like "30.267, -97.743" or "123 Main St, 30.267, -97.743".

const LAT = /^(lat|latitude|y)$/i;
const LNG = /^(lng|lon|long|longitude|x)$/i;
const LABEL = /^(label|name|address|stop|customer|description|title|location)$/i;

/** Minimal CSV reader: commas or tabs, double-quoted fields with "" escapes. */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

const isNumber = (s) => s !== '' && Number.isFinite(Number(s));

export function parsePoints(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { points: [], errors: [] };

  const first = rows[0];
  const hasHeader = first.some((h) => LAT.test(h) || LNG.test(h)) || !first.some(isNumber);
  let cols;
  let start = 0;

  if (hasHeader) {
    cols = {
      lat: first.findIndex((h) => LAT.test(h)),
      lng: first.findIndex((h) => LNG.test(h)),
      label: first.findIndex((h) => LABEL.test(h)),
    };
    if (cols.lat === -1 || cols.lng === -1) {
      return { points: [], errors: ['The header row needs "lat" and "lng" (or "latitude" and "longitude") columns.'] };
    }
    start = 1;
  } else {
    const i = first.findIndex((c, k) => isNumber(c) && isNumber(first[k + 1] ?? ''));
    if (i === -1) return { points: [], errors: ['Line 1: expected two numbers (latitude, longitude).'] };
    cols = { lat: i, lng: i + 1, label: i > 0 ? 0 : first.length > 2 ? 2 : -1 };
  }

  const points = [];
  const errors = [];
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    let lat = Number(row[cols.lat]);
    let lng = Number(row[cols.lng]);
    if (!isNumber(row[cols.lat] ?? '') || !isNumber(row[cols.lng] ?? '')) {
      errors.push(`Line ${r + 1}: missing latitude or longitude.`);
      continue;
    }
    // Longitude-first data (common in GeoJSON exports): swap when only that reading is valid.
    if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) [lat, lng] = [lng, lat];
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      errors.push(`Line ${r + 1}: ${row[cols.lat]}, ${row[cols.lng]} is not a valid coordinate.`);
      continue;
    }
    const label = cols.label >= 0 ? (row[cols.label] ?? '').slice(0, 200) : '';
    points.push({ lat, lng, label });
  }
  return { points, errors };
}

/** Demo data: houses along a grid of streets, so routes look like real collection runs. */
// Default centre: the residential grid east of downtown Round Rock, TX (clear of Interstate 35).
export function samplePoints(center = { lat: 30.515, lng: -97.6715 }, count = 60) {
  const streets = ['Oak', 'Elm', 'Cedar', 'Pecan', 'Maple', 'Willow'];
  const points = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    const street = i % streets.length;
    const along = Math.floor(i / streets.length);
    points.push({
      lat: center.lat + (street - streets.length / 2) * 0.0022 + (rand() - 0.5) * 0.0004,
      lng: center.lng + (along - count / streets.length / 2) * 0.0011 + (rand() - 0.5) * 0.0003,
      label: `${100 + along * 8 + (street % 2) * 3} ${streets[street]} St`,
    });
  }
  return points;
}
