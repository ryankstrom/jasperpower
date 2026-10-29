// Demo data so the app has something to show. Refuses to run on a database that already has devices.
import { openDb, DB_PATH, tx } from './db.js';
import { generateUid } from './codes.js';

const db = openDb();
if (db.prepare('SELECT COUNT(*) n FROM devices').get().n) {
  console.error(`${DB_PATH} already has devices — not seeding.`);
  process.exit(1);
}

const models = [
  ['sensor', 'Milesight', 'EM300-TH', 'Temperature & humidity sensor'],
  ['sensor', 'Milesight', 'EM500-UDL', 'Ultrasonic distance / level sensor'],
  ['sensor', 'Dragino', 'LHT65N', 'Temperature & humidity with external probe'],
  ['sensor', 'Dragino', 'LDDS75', 'Distance detection sensor'],
  ['gateway', 'MultiTech', 'Conduit MTCDT', 'Outdoor-capable LoRaWAN gateway'],
  ['gateway', 'Milesight', 'UG65', 'Indoor/semi-industrial LoRaWAN gateway'],
  ['antenna', 'Generic', '915 MHz 6 dBi Omni', 'Fibreglass omni antenna, N-female'],
  ['power', 'Jasper', 'Solar Kit 100W', '100 W panel, charge controller, 100 Ah battery'],
];
const locations = [
  ['Main Warehouse', 'warehouse', 'Shop shelf A–D', null, null],
  ['Field Truck 1', 'vehicle', null, null, null],
  ['North Ranch — Tank Farm', 'site', null, 44.3712, -103.7421],
  ['Hilltop Repeater', 'site', null, 44.3895, -103.7104],
  ['Milesight RMA', 'vendor', null, null, null],
];

const hex = n => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('');
const daysAgo = d => new Date(Date.now() - d * 864e5).toISOString();

tx(db, () => {
  const mIds = models.map(m => db.prepare('INSERT INTO models (category, manufacturer, model, description) VALUES (?,?,?,?)')
    .run(...m).lastInsertRowid);
  const lIds = locations.map(l => db.prepare('INSERT INTO locations (name, kind, address, lat, lon) VALUES (?,?,?,?,?)')
    .run(...l).lastInsertRowid);
  const [wh, truck, ranch, hill, rma] = lIds;

  // [model index, eui?, name, path of [status, location, daysAgo, note]]
  const devices = [
    [0, true, 'Pump house temp', [['in_stock', wh, 120], ['deployed', ranch, 90, 'Mounted inside pump house']]],
    [0, true, null, [['in_stock', wh, 120]]],
    [0, true, null, [['in_stock', wh, 120]]],
    [1, true, 'Tank 1 level', [['in_stock', wh, 100], ['deployed', ranch, 80]]],
    [1, true, 'Tank 2 level', [['in_stock', wh, 100], ['deployed', ranch, 80], ['repair', rma, 12, 'No uplinks — RMA'],]],
    [2, true, null, [['in_stock', wh, 60], ['in_transit', truck, 2, 'Loaded for Hilltop install']]],
    [3, true, null, [['in_stock', wh, 60]]],
    [4, true, 'Hilltop gateway', [['in_stock', wh, 200], ['deployed', hill, 150]]],
    [5, true, 'Spare gateway', [['in_stock', wh, 200], ['deployed', ranch, 180], ['in_stock', wh, 95, 'Swapped out, works fine']]],
    [6, false, null, [['in_stock', wh, 200], ['deployed', hill, 150]]],
    [6, false, null, [['in_stock', wh, 200]]],
    [7, false, 'Hilltop solar', [['in_stock', wh, 200], ['deployed', hill, 150]]],
  ];
  for (const [mi, hasEui, name, path] of devices) {
    const eui = hasEui ? (models[mi][0] === 'gateway' ? '00800000' + hex(8) : 'A84041' + hex(10)) : null;
    const uid = eui || generateUid();
    const [first] = path, last = path.at(-1);
    const lastLoc = locations[lIds.indexOf(last[1])];
    const id = db.prepare(`INSERT INTO devices (uid, uid_source, eui, name, model_id, status, location_id, lat, lon,
        purchase_date, vendor, po_number, cost, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(uid, eui ? 'eui' : 'generated', eui, name, mIds[mi],
      last[0], last[1], last[0] === 'deployed' ? lastLoc[3] : null, last[0] === 'deployed' ? lastLoc[4] : null,
      daysAgo(first[2] + 10).slice(0, 10), models[mi][1] === 'Jasper' ? 'In-house' : 'Connected Supply',
      'PO-' + (2400 + mi), [62, 95, 48, 70, 899, 420, 85, 1450][mi], daysAgo(first[2]), daysAgo(last[2])).lastInsertRowid;
    let prev = null;
    for (const [status, loc, ago, note] of path) {
      db.prepare(`INSERT INTO events (device_id, ts, action, from_status, to_status, from_location_id, to_location_id,
          note, actor) VALUES (?,?,?,?,?,?,?,?,?)`).run(id, daysAgo(ago), prev ? 'status' : 'created',
        prev?.[0] ?? null, status, prev?.[1] ?? null, loc, note ?? null, 'Demo');
      prev = [status, loc];
    }
  }
});
console.log(`Seeded demo data into ${DB_PATH}`);
