import express from 'express';
import QRCode from 'qrcode';
import { STATUSES, CATEGORIES, LOCATION_KINDS, tx } from './db.js';
import { generateUid, normalizeEui, parseScan } from './codes.js';

const STATUS_KEYS = new Set(STATUSES.map(s => s.key));
const CATEGORY_KEYS = new Set(CATEGORIES.map(c => c.key));
const KIND_KEYS = new Set(LOCATION_KINDS.map(k => k.key));

const DEVICE_FIELDS = ['eui', 'join_eui', 'serial_number', 'name', 'model_id', 'location_id', 'lat', 'lon',
  'purchase_date', 'vendor', 'po_number', 'cost', 'warranty_expires', 'firmware', 'notes'];

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

// Who is acting. Until logins exist this is the name the user typed in the header;
// once auth lands, swap this for req.user.
// Behind Cloudflare Access (TRUST_ACCESS_HEADER=1) the signed-in user's email is authoritative.
const accessEmail = req =>
  (process.env.TRUST_ACCESS_HEADER === '1' && req.get('cf-access-authenticated-user-email')) || null;
const actorOf = req => {
  const email = accessEmail(req);
  if (email) return email;
  let v = req.get('x-actor') || '';
  try { v = decodeURIComponent(v); } catch { /* use as sent */ }
  return v.trim().slice(0, 80) || null;
};

const blank = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const str = v => (blank(v) ? null : String(v).trim());
const num = v => (blank(v) ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const int = v => (blank(v) ? null : Number.isInteger(Number(v)) ? Number(v) : null);

function cleanDevice(body) {
  const d = {};
  for (const f of DEVICE_FIELDS) {
    if (!(f in body)) continue;
    const v = body[f];
    if (f === 'eui' || f === 'join_eui') {
      if (blank(v)) { d[f] = null; continue; }
      const e = normalizeEui(v);
      if (!e) throw new HttpError(400, `${f === 'eui' ? 'EUI' : 'JoinEUI'} must be 16 hex digits`);
      d[f] = e;
    } else if (f === 'model_id' || f === 'location_id') d[f] = int(v);
    else if (f === 'lat' || f === 'lon' || f === 'cost') d[f] = num(v);
    else d[f] = str(v);
  }
  return d;
}

const DEVICE_SELECT = `
  SELECT d.*, m.manufacturer, m.model AS model_name, m.category,
         l.name AS location_name, l.kind AS location_kind
    FROM devices d
    LEFT JOIN models m    ON m.id = d.model_id
    LEFT JOIN locations l ON l.id = d.location_id`;

const EVENT_SELECT = `
  SELECT e.*, fl.name AS from_location_name, tl.name AS to_location_name,
         d.uid, d.name AS device_name, m.manufacturer, m.model AS model_name
    FROM events e
    JOIN devices d        ON d.id = e.device_id
    LEFT JOIN models m    ON m.id = d.model_id
    LEFT JOIN locations fl ON fl.id = e.from_location_id
    LEFT JOIN locations tl ON tl.id = e.to_location_id`;

export function createApi(db) {
  const r = express.Router();
  const q = (sql) => db.prepare(sql);

  const getDevice = id => q(`${DEVICE_SELECT} WHERE d.id = ?`).get(id);
  const mustDevice = id => {
    const d = getDevice(int(id));
    if (!d) throw new HttpError(404, 'Device not found');
    return d;
  };
  const checkLocation = id => {
    if (id != null && !q('SELECT 1 FROM locations WHERE id = ?').get(id)) throw new HttpError(400, 'Unknown location');
  };
  const checkModel = id => {
    if (id != null && !q('SELECT 1 FROM models WHERE id = ?').get(id)) throw new HttpError(400, 'Unknown model');
  };
  const logEvent = e => q(`INSERT INTO events (device_id, action, from_status, to_status, from_location_id,
      to_location_id, lat, lon, note, changes, actor)
      VALUES (:device_id, :action, :from_status, :to_status, :from_location_id, :to_location_id,
      :lat, :lon, :note, :changes, :actor)`).run(Object.fromEntries(
    ['device_id', 'action', 'from_status', 'to_status', 'from_location_id', 'to_location_id',
      'lat', 'lon', 'note', 'changes', 'actor'].map(k => [k, e[k] ?? null])));

  // ---- reference data ----
  r.get('/me', (req, res) => {
    const email = accessEmail(req);
    // Any request that reached us through Cloudflare Access carries its JWT, even if the email header is missing.
    const access = process.env.TRUST_ACCESS_HEADER === '1' && !!(email || req.get('cf-access-jwt-assertion'));
    if (access && !email) console.warn('Access request without cf-access-authenticated-user-email header');
    res.json({ email, access });
  });
  r.get('/meta', (req, res) => res.json({ statuses: STATUSES, categories: CATEGORIES, location_kinds: LOCATION_KINDS }));

  r.get('/stats', (req, res) => {
    const byStatus = q('SELECT status, COUNT(*) n FROM devices GROUP BY status').all();
    const byCategory = q(`SELECT COALESCE(m.category,'other') category, d.status, COUNT(*) n
      FROM devices d LEFT JOIN models m ON m.id = d.model_id GROUP BY 1, 2`).all();
    const byLocation = q(`SELECT l.id, l.name, l.kind, COUNT(d.id) n FROM locations l
      JOIN devices d ON d.location_id = l.id AND d.status NOT IN ('retired','lost')
      GROUP BY l.id ORDER BY n DESC LIMIT 8`).all();
    const warranty = q(`${DEVICE_SELECT} WHERE d.warranty_expires IS NOT NULL
      AND d.warranty_expires <= date('now','+60 days') AND d.status NOT IN ('retired','lost')
      ORDER BY d.warranty_expires LIMIT 10`).all();
    // things someone should follow up on: away for repair, still in transit, or lost recently
    const attention = q(`${DEVICE_SELECT} WHERE d.status IN ('repair','in_transit')
      OR (d.status = 'lost' AND d.updated_at >= date('now','-90 days'))
      ORDER BY d.updated_at LIMIT 20`).all();
    const total = q('SELECT COUNT(*) n FROM devices').get().n;
    res.json({ total, byStatus, byCategory, byLocation, warranty, attention });
  });

  r.get('/events', (req, res) => {
    const limit = Math.min(int(req.query.limit) ?? 30, 200);
    res.json(q(`${EVENT_SELECT} ORDER BY e.ts DESC, e.id DESC LIMIT ?`).all(limit));
  });

  // ---- models (equipment catalog) ----
  r.get('/models', (req, res) => {
    res.json(q(`SELECT m.*, COUNT(d.id) device_count FROM models m LEFT JOIN devices d ON d.model_id = m.id
      GROUP BY m.id ORDER BY m.category, m.manufacturer, m.model`).all());
  });
  const cleanModel = b => {
    const m = { category: str(b.category) || 'sensor', manufacturer: str(b.manufacturer), model: str(b.model),
      description: str(b.description) };
    if (!m.manufacturer || !m.model) throw new HttpError(400, 'Manufacturer and model are required');
    if (!CATEGORY_KEYS.has(m.category)) throw new HttpError(400, 'Unknown category');
    return m;
  };
  r.post('/models', (req, res) => {
    const m = cleanModel(req.body);
    const { lastInsertRowid } = q(`INSERT INTO models (category, manufacturer, model, description)
      VALUES (:category, :manufacturer, :model, :description)`).run(m);
    res.status(201).json(q('SELECT * FROM models WHERE id = ?').get(lastInsertRowid));
  });
  r.put('/models/:id', (req, res) => {
    const m = cleanModel(req.body);
    const { changes } = q(`UPDATE models SET category=:category, manufacturer=:manufacturer, model=:model,
      description=:description WHERE id=:id`).run({ ...m, id: int(req.params.id) });
    if (!changes) throw new HttpError(404, 'Model not found');
    res.json(q('SELECT * FROM models WHERE id = ?').get(int(req.params.id)));
  });
  r.delete('/models/:id', (req, res) => {
    if (q('SELECT 1 FROM devices WHERE model_id = ?').get(int(req.params.id)))
      throw new HttpError(409, 'Model is used by devices; reassign them first');
    q('DELETE FROM models WHERE id = ?').run(int(req.params.id));
    res.status(204).end();
  });

  // ---- locations ----
  r.get('/locations', (req, res) => {
    res.json(q(`SELECT l.*, COUNT(d.id) device_count FROM locations l
      LEFT JOIN devices d ON d.location_id = l.id AND d.status NOT IN ('retired','lost')
      GROUP BY l.id ORDER BY l.archived, l.kind, l.name`).all());
  });
  r.get('/locations/:id', (req, res) => {
    const loc = q('SELECT * FROM locations WHERE id = ?').get(int(req.params.id));
    if (!loc) throw new HttpError(404, 'Location not found');
    loc.devices = q(`${DEVICE_SELECT} WHERE d.location_id = ? ORDER BY d.status, m.category, d.uid`).all(loc.id);
    // everything that has ever been at this location, for deployment history
    loc.history = q(`${EVENT_SELECT} WHERE e.to_location_id = :id OR e.from_location_id = :id
      ORDER BY e.ts DESC LIMIT 100`).all({ id: loc.id });
    res.json(loc);
  });
  const cleanLocation = b => {
    const l = { name: str(b.name), kind: str(b.kind) || 'warehouse', address: str(b.address),
      lat: num(b.lat), lon: num(b.lon), notes: str(b.notes), archived: b.archived ? 1 : 0 };
    if (!l.name) throw new HttpError(400, 'Location name is required');
    if (!KIND_KEYS.has(l.kind)) throw new HttpError(400, 'Unknown location type');
    return l;
  };
  r.post('/locations', (req, res) => {
    const l = cleanLocation(req.body);
    const { lastInsertRowid } = q(`INSERT INTO locations (name, kind, address, lat, lon, notes, archived)
      VALUES (:name, :kind, :address, :lat, :lon, :notes, :archived)`).run(l);
    res.status(201).json(q('SELECT * FROM locations WHERE id = ?').get(lastInsertRowid));
  });
  r.put('/locations/:id', (req, res) => {
    const l = cleanLocation(req.body);
    const { changes } = q(`UPDATE locations SET name=:name, kind=:kind, address=:address, lat=:lat, lon=:lon,
      notes=:notes, archived=:archived WHERE id=:id`).run({ ...l, id: int(req.params.id) });
    if (!changes) throw new HttpError(404, 'Location not found');
    res.json(q('SELECT * FROM locations WHERE id = ?').get(int(req.params.id)));
  });
  r.delete('/locations/:id', (req, res) => {
    const id = int(req.params.id);
    if (q('SELECT 1 FROM devices WHERE location_id = ?').get(id) ||
        q('SELECT 1 FROM events WHERE from_location_id = ? OR to_location_id = ?').get(id, id))
      throw new HttpError(409, 'Location has devices or history; archive it instead');
    q('DELETE FROM locations WHERE id = ?').run(id);
    res.status(204).end();
  });

  // ---- devices ----
  r.get('/devices', (req, res) => {
    const where = [], p = {};
    if (req.query.q) {
      where.push(`(d.uid LIKE :q OR d.eui LIKE :hex OR d.serial_number LIKE :q OR d.name LIKE :q
        OR m.model LIKE :q OR m.manufacturer LIKE :q OR l.name LIKE :q OR d.po_number LIKE :q)`);
      const text = String(req.query.q).trim();
      p.q = `%${text}%`;
      p.hex = `%${text.replace(/[\s:\-]/g, '')}%`; // EUIs are often written AA:BB:.. or AA-BB-..
    }
    if (req.query.status) { where.push('d.status = :status'); p.status = String(req.query.status); }
    else if (!req.query.all) where.push(`d.status NOT IN ('retired','lost')`);
    if (req.query.category) { where.push('m.category = :category'); p.category = String(req.query.category); }
    if (req.query.location_id) { where.push('d.location_id = :loc'); p.loc = int(req.query.location_id); }
    if (req.query.model_id) { where.push('d.model_id = :model'); p.model = int(req.query.model_id); }
    const sql = `${DEVICE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY d.updated_at DESC LIMIT 1000`;
    res.json(q(sql).all(p));
  });

  r.get('/devices.csv', (req, res) => {
    const rows = q(`${DEVICE_SELECT} ORDER BY d.uid`).all();
    const cols = ['uid', 'eui', 'join_eui', 'serial_number', 'name', 'category', 'manufacturer', 'model_name',
      'status', 'location_name', 'lat', 'lon', 'purchase_date', 'vendor', 'po_number', 'cost',
      'warranty_expires', 'firmware', 'notes', 'created_at', 'updated_at'];
    const esc = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [cols.join(','), ...rows.map(row => cols.map(c => esc(row[c])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="jasper-inventory-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  r.get('/devices/:id', (req, res) => {
    const d = mustDevice(req.params.id);
    d.events = q(`${EVENT_SELECT} WHERE e.device_id = ? ORDER BY e.ts DESC, e.id DESC`).all(d.id);
    d.deletable = !hasHistory(d.id);
    res.json(d);
  });

  r.post('/devices', (req, res) => {
    const d = cleanDevice(req.body);
    const status = str(req.body.status) || 'in_stock';
    if (!STATUS_KEYS.has(status)) throw new HttpError(400, 'Unknown status');
    checkLocation(d.location_id);
    checkModel(d.model_id);

    let uid = str(req.body.uid), uid_source = 'manual';
    if (uid) {
      const asEui = normalizeEui(uid);
      if (asEui) { uid = asEui; uid_source = 'eui'; d.eui ??= asEui; }
    } else if (d.eui) { uid = d.eui; uid_source = 'eui'; }
    else {
      uid_source = 'generated';
      do uid = generateUid(); while (q('SELECT 1 FROM devices WHERE uid = ?').get(uid));
    }
    const dupe = q('SELECT id, uid FROM devices WHERE uid = :uid OR (eui IS NOT NULL AND eui = :eui)')
      .get({ uid, eui: d.eui ?? null });
    if (dupe) throw new HttpError(409, `Already in inventory as ${dupe.uid}`, { device_id: dupe.id });

    const row = { ...Object.fromEntries(DEVICE_FIELDS.map(f => [f, null])), ...d, uid, uid_source, status };
    const id = tx(db, () => {
      const { lastInsertRowid } = q(`INSERT INTO devices (uid, uid_source, status, ${DEVICE_FIELDS.join(', ')})
        VALUES (:uid, :uid_source, :status, ${DEVICE_FIELDS.map(f => ':' + f).join(', ')})`).run(row);
      logEvent({ device_id: lastInsertRowid, action: 'created', to_status: status, to_location_id: d.location_id,
        lat: d.lat, lon: d.lon, note: str(req.body.event_note), actor: actorOf(req) });
      return lastInsertRowid;
    });
    res.status(201).json(getDevice(id));
  });

  r.put('/devices/:id', (req, res) => {
    const cur = mustDevice(req.params.id);
    // status and location move through /transition so history stays meaningful
    const d = cleanDevice(req.body);
    delete d.location_id;
    checkModel(d.model_id);
    const changes = {};
    for (const [k, v] of Object.entries(d)) if ((cur[k] ?? null) !== v) changes[k] = { from: cur[k] ?? null, to: v };
    if (!Object.keys(changes).length) return res.json(cur);
    if (changes.eui && changes.eui.to) {
      const dupe = q('SELECT uid FROM devices WHERE eui = ? AND id <> ?').get(changes.eui.to, cur.id);
      if (dupe) throw new HttpError(409, `EUI already belongs to ${dupe.uid}`);
    }
    // EUI-keyed devices follow a corrected EUI; generated/manual uids are printed on labels and stay put
    const newUid = cur.uid_source === 'eui' && changes.eui?.to ? changes.eui.to : cur.uid;
    if (newUid !== cur.uid) changes.uid = { from: cur.uid, to: newUid };
    tx(db, () => {
      const sets = Object.keys(d).filter(k => k in changes);
      q(`UPDATE devices SET ${sets.map(k => `${k} = :${k}`).join(', ')}${sets.length ? ',' : ''} uid = :uid,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`)
        .run({ ...Object.fromEntries(sets.map(k => [k, d[k]])), uid: newUid, id: cur.id });
      logEvent({ device_id: cur.id, action: 'edit', changes: JSON.stringify(changes), actor: actorOf(req) });
    });
    res.json(getDevice(cur.id));
  });

  // Status / location change — the core check-in / check-out / deploy action.
  r.post('/devices/:id/transition', (req, res) => {
    const cur = mustDevice(req.params.id);
    const status = str(req.body.status) || cur.status;
    if (!STATUS_KEYS.has(status)) throw new HttpError(400, 'Unknown status');
    const location_id = 'location_id' in req.body ? int(req.body.location_id) : cur.location_id;
    checkLocation(location_id);
    const lat = num(req.body.lat), lon = num(req.body.lon);
    if (status === cur.status && location_id === cur.location_id && lat == null)
      throw new HttpError(400, 'Nothing changed — pick a different status or location');
    tx(db, () => {
      q(`UPDATE devices SET status = :status, location_id = :location_id,
          lat = COALESCE(:lat, CASE WHEN :location_id IS :old_loc THEN lat END),
          lon = COALESCE(:lon, CASE WHEN :location_id IS :old_loc THEN lon END),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = :id`)
        .run({ status, location_id, lat, lon, old_loc: cur.location_id, id: cur.id });
      logEvent({ device_id: cur.id, action: 'status', from_status: cur.status, to_status: status,
        from_location_id: cur.location_id, to_location_id: location_id, lat, lon,
        note: str(req.body.note), actor: actorOf(req) });
    });
    res.json(getDevice(cur.id));
  });

  r.post('/devices/:id/notes', (req, res) => {
    const cur = mustDevice(req.params.id);
    const note = str(req.body.note);
    if (!note) throw new HttpError(400, 'Note is empty');
    logEvent({ device_id: cur.id, action: 'note', note, actor: actorOf(req) });
    res.status(201).json({ ok: true });
  });

  // A device's history is the point of the app, so only a record with nothing beyond its
  // "added" entry (i.e. entered by mistake) can be deleted. Everything else gets retired.
  const hasHistory = id => q(`SELECT 1 FROM events WHERE device_id = ? AND action <> 'created'`).get(id);
  r.delete('/devices/:id', (req, res) => {
    const cur = mustDevice(req.params.id);
    if (hasHistory(cur.id)) throw new HttpError(409, 'This device has history, so it can’t be deleted. Retire it instead.');
    q('DELETE FROM devices WHERE id = ?').run(cur.id);
    res.status(204).end();
  });

  r.get('/devices/:id/qr.svg', async (req, res) => {
    const d = mustDevice(req.params.id);
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const svg = await QRCode.toString(`${base}/u/${encodeURIComponent(d.uid)}`,
      { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#27383a', light: '#ffffff' } });
    res.type('image/svg+xml').send(svg);
  });

  // ---- scan lookup ----
  r.get('/lookup', (req, res) => {
    const parsed = parseScan(req.query.code);
    let device = null;
    const find = (sql, v) => (v ? q(`${DEVICE_SELECT} WHERE ${sql}`).get(v) : null);
    device = find('d.uid = ? COLLATE NOCASE', parsed.uid)
      || find('d.eui = ?', parsed.eui)
      || find('d.uid = ? COLLATE NOCASE', parsed.raw)
      || find('d.serial_number = ? COLLATE NOCASE', parsed.serial);
    res.json({ parsed, device: device || null });
  });

  // ---- errors ----
  r.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (/constraint failed/i.test(err.message || '')) {
      return res.status(409).json({ error: /UNIQUE/.test(err.message) ? 'That value is already in use' : err.message });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });

  return r;
}
