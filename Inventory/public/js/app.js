// JasperInventory client — a small hash-routed single-page app (no build step).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');

// ---------- formatting ----------
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS_COLOR = { in_stock: 'var(--accent)', deployed: 'var(--good)', in_transit: 'var(--blue)',
  repair: 'var(--warn)', retired: '#8d9a9b', lost: 'var(--danger)' };
const STATUS_ICON = { in_stock: '⇩', deployed: '⇧', in_transit: '⇄', repair: '⚒', retired: '⊘', lost: '?' };
let META = { statuses: [], categories: [], location_kinds: [] };
const label = (list, key) => META[list].find(x => x.key === key)?.label ?? key ?? '—';
const statusLabel = k => label('statuses', k);
const catLabel = k => label('categories', k);
const kindLabel = k => label('location_kinds', k);
const pill = s => `<span class="pill" style="--c:${STATUS_COLOR[s] || 'var(--muted)'}">${esc(statusLabel(s))}</span>`;
const modelText = d => (d.manufacturer ? `${d.manufacturer} ${d.model_name}` : 'Unknown model');
const devTitle = d => d.name || modelText(d);
const fmtDate = s => (s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString(undefined,
  { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtDateTime = s => (s ? new Date(s).toLocaleString(undefined,
  { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
function ago(s) {
  const sec = (Date.now() - new Date(s)) / 1000;
  if (sec < 60) return 'just now';
  const units = [[60, 'min'], [3600, 'hr'], [86400, 'day'], [2592000, 'mo'], [31536000, 'yr']];
  let u = units[0];
  for (const x of units) if (sec >= x[0]) u = x;
  const n = Math.floor(sec / u[0]);
  return `${n} ${u[1]}${n > 1 ? 's' : ''} ago`;
}
const duration = (a, b) => {
  const days = Math.round((new Date(b || Date.now()) - new Date(a)) / 864e5);
  return days < 1 ? '< 1 day' : days < 60 ? `${days} days` : `${(days / 30.4).toFixed(1)} months`;
};
const money = v => (v == null ? '—' : Number(v).toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
const fmtEui = e => (e ? e.match(/.{2}/g).join(':') : '—');

// ---------- api ----------
const actor = {
  get: () => { try { return localStorage.getItem('jinv.actor') || ''; } catch { return ''; } },
  set: v => { try { localStorage.setItem('jinv.actor', v); } catch {} },
};
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Actor': encodeURIComponent(actor.get()) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data, status: res.status });
  return data;
}

// ---------- ui helpers ----------
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 2800);
}
function modal(html, onMount) {
  $('#modal').innerHTML = html;
  $('#modalBackdrop').classList.add('show');
  onMount?.($('#modal'));
  $('#modal').querySelector('input:not([type=checkbox]),select,textarea')?.focus({ preventScroll: true });
}
function closeModal() {
  $('#modalBackdrop').classList.remove('show');
  $('#modal').innerHTML = '';
}
$('#modalBackdrop').addEventListener('mousedown', e => { if (e.target.id === 'modalBackdrop') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function confirmModal(title, body, okText = 'Confirm', danger = false) {
  return new Promise(resolve => {
    modal(`<h2>${esc(title)}</h2><p>${body}</p>
      <div class="modal-actions"><button class="sec" data-x>Cancel</button>
      <button class="${danger ? 'danger' : ''}" data-ok>${esc(okText)}</button></div>`, m => {
      m.querySelector('[data-x]').onclick = () => { closeModal(); resolve(false); };
      m.querySelector('[data-ok]').onclick = () => { closeModal(); resolve(true); };
    });
  });
}
const formData = form => Object.fromEntries(new FormData(form).entries());
const options = (list, sel, blankText) =>
  (blankText != null ? `<option value="">${esc(blankText)}</option>` : '') +
  list.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(sel ?? '') ? 'selected' : ''}>${esc(o.text)}</option>`).join('');
const statusOptions = sel => options(META.statuses.map(s => ({ value: s.key, text: s.label })), sel);

function getPosition() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6) }),
      () => resolve(null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}

// cached lookups for selects
const cache = { locations: null, models: null };
async function locations(force) { if (force || !cache.locations) cache.locations = await api('/locations'); return cache.locations; }
async function models(force) { if (force || !cache.models) cache.models = await api('/models'); return cache.models; }
function locationOptions(locs, sel, blank = '— None —') {
  const groups = META.location_kinds.map(k => {
    const items = locs.filter(l => l.kind === k.key && (!l.archived || l.id === sel));
    return items.length ? `<optgroup label="${esc(k.label)}">${options(items.map(l => ({ value: l.id, text: l.name })), sel)}</optgroup>` : '';
  }).join('');
  return `<option value="">${esc(blank)}</option>${groups}<option value="__new">＋ New location…</option>`;
}
function modelOptions(ms, sel) {
  const groups = META.categories.map(c => {
    const items = ms.filter(m => m.category === c.key);
    return items.length ? `<optgroup label="${esc(c.label)}">${options(items.map(m => ({ value: m.id, text: `${m.manufacturer} ${m.model}` })), sel)}</optgroup>` : '';
  }).join('');
  return `<option value="">— Select model —</option>${groups}<option value="__new">＋ New model…</option>`;
}

// "＋ New …" entries in selects open a nested quick-create form, then select the result.
function wireQuickCreate(select, kind, onCreated) {
  let prev = select.value === '__new' ? '' : select.value;
  select.addEventListener('focus', () => { if (select.value !== '__new') prev = select.value; });
  select.addEventListener('change', async () => {
    if (select.value !== '__new') { prev = select.value; return; }
    select.value = prev;
    const created = kind === 'location' ? await quickLocation() : await quickModel();
    if (!created) return;
    await onCreated(created);
    select.value = created.id;
    select.dispatchEvent(new Event('change'));
  });
}
function inlineDialog(html) {
  // a small dialog layered over the current modal/page
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.id = 'modalBackdrop';
    wrap.className = 'show';
    wrap.style.zIndex = 3500;
    wrap.innerHTML = `<div class="modal">${html}</div>`;
    document.body.append(wrap);
    const done = v => { wrap.remove(); resolve(v); };
    wrap.querySelector('[data-x]').onclick = () => done(null);
    wrap.querySelector('form').onsubmit = e => { e.preventDefault(); done(formData(e.target)); };
    wrap.querySelector('input')?.focus();
  });
}
async function quickLocation() {
  const v = await inlineDialog(`<h2>New location</h2><form class="stack">
    <div class="field"><label>Name</label><input type="text" name="name" required></div>
    <div class="field"><label>Type</label><select name="kind">${options(META.location_kinds.map(k => ({ value: k.key, text: k.label })), 'site')}</select></div>
    <div class="modal-actions"><button type="button" class="sec" data-x>Cancel</button><button>Create</button></div></form>`);
  if (!v) return null;
  try { const l = await api('/locations', { method: 'POST', body: v }); await locations(true); return l; }
  catch (e) { toast(e.message, true); return null; }
}
async function quickModel() {
  const v = await inlineDialog(`<h2>New catalog model</h2><form class="stack">
    <div class="field"><label>Category</label><select name="category">${options(META.categories.map(c => ({ value: c.key, text: c.label })), 'sensor')}</select></div>
    <div class="field"><label>Manufacturer</label><input type="text" name="manufacturer" required placeholder="e.g. Milesight"></div>
    <div class="field"><label>Model</label><input type="text" name="model" required placeholder="e.g. EM300-TH"></div>
    <div class="modal-actions"><button type="button" class="sec" data-x>Cancel</button><button>Create</button></div></form>`);
  if (!v) return null;
  try { const m = await api('/models', { method: 'POST', body: v }); await models(true); return m; }
  catch (e) { toast(e.message, true); return null; }
}

// ---------- status transition (check in / deploy / move ...) ----------
const ACTIONS = [
  { key: 'in_stock', text: 'Check in', kind: 'warehouse' },
  { key: 'deployed', text: 'Deploy', kind: 'site' },
  { key: 'in_transit', text: 'In transit', kind: 'vehicle' },
  { key: 'repair', text: 'Repair', kind: 'vendor' },
  { key: 'retired', text: 'Retire', kind: null },
  { key: 'lost', text: 'Lost', kind: null },
];
async function transitionModal(dev, status, onDone) {
  const locs = await locations();
  const act = ACTIONS.find(a => a.key === status);
  // suggest the device's current location if it already fits, otherwise the only/first location of the right kind
  const fits = locs.filter(l => !l.archived && l.kind === act.kind);
  const curLoc = locs.find(l => l.id === dev.location_id);
  const selLoc = status === dev.status ? dev.location_id
    : curLoc?.kind === act.kind ? curLoc.id : act.kind ? (fits.length === 1 ? fits[0].id : '') : dev.location_id;
  modal(`<h2>${esc(act.text)}: ${esc(devTitle(dev))}</h2>
    <form class="stack" id="trForm">
      <div class="field"><label>Status</label><select name="status">${statusOptions(status)}</select></div>
      <div class="field"><label>Location</label><select name="location_id">${locationOptions(locs, selLoc)}</select></div>
      <label class="check"><input type="checkbox" name="gps" ${status === 'deployed' ? 'checked' : ''}> Record my current GPS position</label>
      <div class="field"><label>Note <span class="muted">(optional)</span></label>
        <textarea name="note" placeholder="${status === 'deployed' ? 'e.g. Mounted on north side of tank, 2 m up' : 'Anything worth remembering'}"></textarea></div>
      <div class="modal-actions"><button type="button" class="sec" data-x>Cancel</button><button type="submit">Save</button></div>
    </form>`, m => {
    m.querySelector('[data-x]').onclick = closeModal;
    wireQuickCreate(m.querySelector('[name=location_id]'), 'location', async () => {
      m.querySelector('[name=location_id]').innerHTML = locationOptions(await locations());
    });
    m.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const btn = e.submitter; btn.disabled = true;
      const f = formData(e.target);
      const body = { status: f.status, location_id: f.location_id || null, note: f.note };
      if (f.gps) {
        btn.textContent = 'Getting GPS…';
        const pos = await getPosition();
        if (pos) Object.assign(body, pos); else toast('Could not get GPS position — saved without it', true);
      }
      try {
        const d = await api(`/devices/${dev.id}/transition`, { method: 'POST', body });
        closeModal();
        toast(`${devTitle(d)} → ${statusLabel(d.status)}${d.location_name ? ' @ ' + d.location_name : ''}`);
        onDone?.(d);
      } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Save'; }
    };
  });
}

// ---------- router ----------
let cleanup = null;
const routes = [
  [/^\/?$/, 'home', pageHome],
  [/^\/devices$/, 'devices', pageDevices],
  [/^\/d\/(\d+)$/, 'devices', pageDevice],
  [/^\/new$/, 'devices', pageNew],
  [/^\/scan(?:\/(.+))?$/, 'scan', pageScan],
  [/^\/locations$/, 'locations', pageLocations],
  [/^\/l\/(\d+)$/, 'locations', pageLocation],
  [/^\/models$/, 'models', pageModels],
  [/^\/labels$/, 'devices', pageLabels],
];
function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [path, qs] = h.split('?');
  return { path, params: new URLSearchParams(qs || '') };
}
async function router() {
  cleanup?.(); cleanup = null;
  closeModal();
  const { path, params } = parseHash();
  for (const [re, nav, fn] of routes) {
    const m = path.match(re);
    if (!m) continue;
    $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
    window.scrollTo(0, 0);
    try { await fn(params, ...m.slice(1).map(x => x && decodeURIComponent(x))); }
    catch (e) { view.innerHTML = `<div class="card empty">⚠ ${esc(e.message)}</div>`; }
    return;
  }
  view.innerHTML = `<div class="card empty">Page not found. <a href="#/">Go to dashboard</a></div>`;
}
const go = h => { if (location.hash === h) router(); else location.hash = h; };

// ---------- pages ----------
async function pageHome() {
  const [stats, events] = await Promise.all([api('/stats'), api('/events?limit=15')]);
  const by = Object.fromEntries(stats.byStatus.map(s => [s.status, s.n]));
  const cats = META.categories.map(c => {
    const rows = stats.byCategory.filter(r => r.category === c.key);
    const n = s => rows.filter(r => r.status === s).reduce((a, r) => a + r.n, 0);
    return { ...c, stock: n('in_stock'), deployed: n('deployed'), other: rows.reduce((a, r) => a + r.n, 0) - n('in_stock') - n('deployed') };
  }).filter(c => c.stock + c.deployed + c.other);

  view.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Dashboard</h1>
      <p class="sub">${stats.total} device${stats.total === 1 ? '' : 's'} tracked across ${stats.byLocation.length ? 'your sites and stock' : 'inventory'}.</p></div>
      <div class="actions"><a class="btn" href="#/scan">⌗ Scan a device</a><a class="btn sec" href="#/new">＋ Add device</a></div></div>
    <div class="readouts">${META.statuses.map(s => `
      <a class="readout" style="--c:${STATUS_COLOR[s.key]}" href="#/devices?status=${s.key}">
        <div class="big">${by[s.key] || 0}</div><div class="lbl">${esc(s.label)}</div></a>`).join('')}</div>
    <div class="split" style="margin-top:14px">
      <div class="stack">
        <div class="card"><div class="card-title">By equipment type</div>
          ${cats.length ? `<div class="tbl-wrap" style="border:0"><table><thead><tr><th>Type</th><th>In stock</th><th>Deployed</th><th>Other</th></tr></thead><tbody>
          ${cats.map(c => `<tr class="click" data-href="#/devices?category=${c.key}"><td class="t1">${esc(c.label)}</td><td>${c.stock}</td><td>${c.deployed}</td><td class="muted">${c.other}</td></tr>`).join('')}
          </tbody></table></div>` : `<div class="empty">No devices yet. <a href="#/new">Add your first device</a> or <a href="#/scan">scan one</a>.</div>`}
        </div>
        <div class="card"><div class="card-title">Where things are</div>
          ${stats.byLocation.length ? `<div class="tbl-wrap" style="border:0"><table><tbody>
          ${stats.byLocation.map(l => `<tr class="click" data-href="#/l/${l.id}"><td><div class="t1">${esc(l.name)}</div><div class="t2">${esc(kindLabel(l.kind))}</div></td><td style="text-align:right"><b>${l.n}</b></td></tr>`).join('')}
          </tbody></table></div>` : `<div class="empty">No devices assigned to locations yet.</div>`}
        </div>
        ${stats.warranty.length ? `<div class="card"><div class="card-title">Warranty expiring within 60 days</div>
          <div class="tbl-wrap" style="border:0"><table><tbody>${stats.warranty.map(d => `<tr class="click" data-href="#/d/${d.id}">
          <td><div class="t1">${esc(devTitle(d))}</div><div class="t2 mono">${esc(d.uid)}</div></td><td class="nowrap">${fmtDate(d.warranty_expires)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      </div>
      <div class="card"><div class="card-title">Recent activity</div>${timeline(events, true)}</div>
    </div>`;
  wireRowLinks();
}

function wireRowLinks() {
  $$('[data-href]', view).forEach(el => el.addEventListener('click', () => go(el.dataset.href)));
}

function eventText(e, withDevice) {
  const dev = withDevice ? `<a href="#/d/${e.device_id}"><b>${esc(e.device_name || (e.manufacturer ? `${e.manufacturer} ${e.model_name}` : e.uid))}</b></a> ` : '';
  switch (e.action) {
    case 'created':
      return `${dev}${withDevice ? 'added' : 'Added to inventory'} — ${esc(statusLabel(e.to_status))}${e.to_location_name ? ` at <b>${esc(e.to_location_name)}</b>` : ''}`;
    case 'status': {
      const moved = e.from_location_id !== e.to_location_id;
      const st = e.from_status !== e.to_status ? `${esc(statusLabel(e.from_status))} → <b>${esc(statusLabel(e.to_status))}</b>` : esc(statusLabel(e.to_status));
      return `${dev}${st}${moved ? ` · ${e.to_location_name ? `to <b>${esc(e.to_location_name)}</b>` : 'no location'}` : ''}`;
    }
    case 'edit': {
      const ch = Object.keys(JSON.parse(e.changes || '{}')).map(k => k.replace(/_/g, ' ').replace(/\bid\b/, '')).join(', ');
      return `${dev}Details edited <span class="muted">(${esc(ch)})</span>`;
    }
    case 'note': return `${dev}Note added`;
    default: return `${dev}${esc(e.action)}`;
  }
}
function timeline(events, withDevice = false) {
  if (!events.length) return `<div class="empty">No activity yet.</div>`;
  return `<ul class="timeline">${events.map(e => `<li style="--c:${e.to_status ? STATUS_COLOR[e.to_status] : 'var(--muted)'}">
    <div class="what">${eventText(e, withDevice)}</div>
    <div class="when" title="${esc(fmtDateTime(e.ts))}">${ago(e.ts)} · ${fmtDateTime(e.ts)}${e.actor ? ` · ${esc(e.actor)}` : ''}${e.lat != null ? ` · <a href="https://www.openstreetmap.org/?mlat=${e.lat}&mlon=${e.lon}#map=17/${e.lat}/${e.lon}" target="_blank" rel="noopener">📍 GPS</a>` : ''}</div>
    ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}</li>`).join('')}</ul>`;
}

// --- device list ---
async function pageDevices(params) {
  const locs = await locations(true);
  const st = params.get('status') || '';
  const modelId = params.get('model');
  view.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Devices</h1><p class="sub" id="count">&nbsp;</p></div>
      <div class="actions"><a class="btn sec" href="/api/devices.csv">⇩ Export CSV</a><a class="btn" href="#/new">＋ Add device</a></div></div>
    <div class="chips" id="chips">
      <button class="chip ${!st ? 'on' : ''}" data-s="">Active</button>
      ${META.statuses.map(s => `<button class="chip ${st === s.key ? 'on' : ''}" data-s="${s.key}">${esc(s.label)}</button>`).join('')}
      <button class="chip ${st === 'all' ? 'on' : ''}" data-s="all">All</button>
    </div>
    <div class="filters">
      <input type="search" id="q" placeholder="Search UID, EUI, serial, name, model, PO…" value="${esc(params.get('q') || '')}">
      <select id="cat">${options(META.categories.map(c => ({ value: c.key, text: c.label })), params.get('category'), 'All types')}</select>
      <select id="loc">${options(locs.map(l => ({ value: l.id, text: l.name })), params.get('location_id'), 'All locations')}</select>
    </div>
    <div class="tbl-wrap devices"><table><thead><tr><th>Device</th><th>UID</th><th>Type</th><th>Status</th><th>Location</th><th>Updated</th></tr></thead>
      <tbody id="rows"></tbody></table></div>
    <div class="dlist" id="cards"></div>`;
  let status = st;
  const load = async () => {
    const qs = new URLSearchParams();
    const q = $('#q').value.trim();
    if (q) qs.set('q', q);
    if (status === 'all') qs.set('all', '1'); else if (status) qs.set('status', status);
    if ($('#cat').value) qs.set('category', $('#cat').value);
    if ($('#loc').value) qs.set('location_id', $('#loc').value);
    if (modelId) qs.set('model_id', modelId);
    const list = await api('/devices?' + qs);
    $('#count').textContent = `${list.length} device${list.length === 1 ? '' : 's'}${status && status !== 'all' ? ' · ' + statusLabel(status) : status === 'all' ? ' · all statuses' : ' · active (excludes retired & lost)'}`;
    const empty = `<div class="empty">No devices match. ${q ? '' : '<a href="#/new">Add one</a>'}</div>`;
    $('#rows').innerHTML = list.length ? list.map(d => `<tr class="click" data-href="#/d/${d.id}">
      <td><div class="t1">${esc(devTitle(d))}</div><div class="t2">${d.name ? esc(modelText(d)) : esc(d.serial_number ? 'S/N ' + d.serial_number : '')}</div></td>
      <td class="mono small">${esc(d.uid)}</td><td><span class="tag">${esc(catLabel(d.category))}</span></td>
      <td>${pill(d.status)}</td><td>${esc(d.location_name || '—')}</td><td class="small muted nowrap">${ago(d.updated_at)}</td></tr>`).join('')
      : `<tr><td colspan="6">${empty}</td></tr>`;
    $('#cards').innerHTML = list.length ? list.map(d => `<a class="dcard" style="--c:${STATUS_COLOR[d.status]}" href="#/d/${d.id}">
      <div class="body"><div class="t1">${esc(devTitle(d))}</div><div class="t2 mono">${esc(d.uid)}</div>
      <div class="t2">${esc(statusLabel(d.status))}${d.location_name ? ' · ' + esc(d.location_name) : ''}</div></div><div class="chev">›</div></a>`).join('') : empty;
    wireRowLinks();
  };
  let t;
  $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 200); });
  $('#cat').onchange = load; $('#loc').onchange = load;
  $$('#chips .chip').forEach(c => c.onclick = () => {
    status = c.dataset.s;
    $$('#chips .chip').forEach(x => x.classList.toggle('on', x === c));
    load();
  });
  await load();
}

// --- device detail ---
function deployments(events) {
  // stretches of time spent deployed, oldest first, derived from the event log
  const out = [];
  let open = null;
  for (const e of [...events].reverse()) {
    if (!e.to_status) continue;
    if (open && (e.to_status !== 'deployed' || e.to_location_id !== open.location_id)) { open.end = e.ts; open = null; }
    if (e.to_status === 'deployed' && !open) {
      open = { location_id: e.to_location_id, location: e.to_location_name, start: e.ts, end: null, lat: e.lat, lon: e.lon };
      out.push(open);
    }
  }
  return out.reverse();
}

async function pageDevice(params, id) {
  const d = await api('/devices/' + id);
  const deps = deployments(d.events);
  const pos = d.lat != null ? `<a href="https://www.openstreetmap.org/?mlat=${d.lat}&mlon=${d.lon}#map=17/${d.lat}/${d.lon}" target="_blank" rel="noopener">${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}</a>` : '—';
  view.innerHTML = `
    <div class="crumb"><a href="#/devices">‹ Devices</a></div>
    <div class="page-head dev-head"><div class="grow">
      <h1>${esc(devTitle(d))}</h1>
      <div class="sub">${esc(modelText(d))} · ${esc(catLabel(d.category))}</div>
      <span class="uid" title="${d.uid_source === 'eui' ? 'UID is the device EUI' : d.uid_source === 'generated' ? 'Generated Jasper ID' : 'Manually entered UID'}">${esc(d.uid)}</span>
    </div>
    <div class="dev-status">${pill(d.status)}<div class="sub">${d.location_name ? `at <a href="#/l/${d.location_id}"><b>${esc(d.location_name)}</b></a>` : 'No location'}</div>
      <div class="small muted">since ${ago(d.updated_at)}</div></div></div>

    <div class="split">
      <div class="stack">
        <div class="card"><div class="card-title">Update status</div>
          <div class="qa">${ACTIONS.map(a => `<button data-act="${a.key}" style="--c:${STATUS_COLOR[a.key]}" class="${d.status === a.key ? 'cur' : ''}">
            <span class="i">${STATUS_ICON[a.key]}</span>${esc(a.text)}</button>`).join('')}</div>
        </div>
        <div class="card"><div class="card-title">History<span class="r"><button class="link" id="addNote">＋ Add note</button></span></div>
          ${timeline(d.events)}</div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-title">Details<span class="r"><button class="link" id="editBtn">Edit</button></span></div>
          <dl class="kv">
            <dt>EUI</dt><dd class="mono">${fmtEui(d.eui)}</dd>
            ${d.join_eui ? `<dt>JoinEUI</dt><dd class="mono">${fmtEui(d.join_eui)}</dd>` : ''}
            <dt>Serial #</dt><dd>${esc(d.serial_number || '—')}</dd>
            <dt>Firmware</dt><dd>${esc(d.firmware || '—')}</dd>
            <dt>Position</dt><dd>${pos}</dd>
            <dt>Purchased</dt><dd>${fmtDate(d.purchase_date)}</dd>
            <dt>Vendor</dt><dd>${esc(d.vendor || '—')}</dd>
            <dt>PO #</dt><dd>${esc(d.po_number || '—')}</dd>
            <dt>Cost</dt><dd>${money(d.cost)}</dd>
            <dt>Warranty</dt><dd>${d.warranty_expires ? fmtDate(d.warranty_expires) : '—'}</dd>
            <dt>Added</dt><dd>${fmtDate(d.created_at)}</dd>
          </dl>
          ${d.notes ? `<div class="timeline"><div class="note" style="margin-top:10px">${esc(d.notes)}</div></div>` : ''}
        </div>
        <div class="card"><div class="card-title">Deployments</div>
          ${deps.length ? `<div class="tbl-wrap" style="border:0"><table><thead><tr><th>Site</th><th>From</th><th>Until</th></tr></thead><tbody>
          ${deps.map(x => `<tr><td>${x.location_id ? `<a href="#/l/${x.location_id}">${esc(x.location || '—')}</a>` : '—'}</td>
            <td class="small nowrap">${fmtDate(x.start)}</td><td class="small">${x.end ? fmtDate(x.end) : '<b>current</b>'}<div class="t2">${duration(x.start, x.end)}</div></td></tr>`).join('')}
          </tbody></table></div>` : `<div class="empty" style="padding:12px">Never deployed.</div>`}
        </div>
        <div class="card"><div class="card-title">QR label</div>
          <div class="qrbox"><img src="/api/devices/${d.id}/qr.svg" alt="QR code for ${esc(d.uid)}">
            <div class="stack" style="gap:8px"><div class="small muted">Scanning this label opens the device here. ${d.uid_source === 'eui' ? 'The device’s own LoRaWAN QR code also works.' : ''}</div>
            <a class="btn sec" href="#/labels?ids=${d.id}">🖨 Print label</a></div></div>
        </div>
        <button class="sec" id="delBtn" style="color:var(--danger)">Delete record…</button>
      </div>
    </div>`;
  const reload = () => pageDevice(params, id);
  $$('[data-act]').forEach(b => b.onclick = () => transitionModal(d, b.dataset.act, reload));
  $('#addNote').onclick = () => modal(`<h2>Add note</h2><form class="stack">
      <textarea name="note" required placeholder="e.g. Replaced battery, RSSI -97 dBm at install"></textarea>
      <div class="modal-actions"><button type="button" class="sec" data-x>Cancel</button><button>Add note</button></div></form>`, m => {
    m.querySelector('[data-x]').onclick = closeModal;
    m.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try { await api(`/devices/${d.id}/notes`, { method: 'POST', body: formData(e.target) }); closeModal(); reload(); }
      catch (err) { toast(err.message, true); }
    };
  });
  $('#editBtn').onclick = () => editDeviceModal(d, reload);
  $('#delBtn').onclick = async () => {
    if (!await confirmModal('Delete this record?', `This permanently removes <b>${esc(d.uid)}</b> and its entire history. Use <b>Retire</b> instead for equipment that has reached end of life — deleting is for records entered by mistake.`, 'Delete', true)) return;
    await api('/devices/' + d.id, { method: 'DELETE' });
    toast('Deleted ' + d.uid);
    go('#/devices');
  };
}

function deviceFields(d = {}, ms = [], { withStatus = false, locs = [] } = {}) {
  return `
    <div class="field"><label>EUI <span class="muted">(DevEUI / Gateway EUI)</span></label>
      <div class="inline"><input type="text" class="mono" name="eui" value="${esc(d.eui || '')}" placeholder="16 hex digits" autocomplete="off" spellcheck="false">
      ${withStatus ? '<button type="button" class="sec" id="scanEui" title="Scan the device’s QR code">⌗</button>' : ''}</div>
      <span class="hint">${withStatus ? 'Becomes the device UID. Leave blank for equipment without an EUI and a JSP- ID will be generated.' : ''}</span></div>
    <div class="field"><label>Model</label><select name="model_id">${modelOptions(ms, d.model_id)}</select></div>
    <div class="field"><label>Name <span class="muted">(optional)</span></label><input type="text" name="name" value="${esc(d.name || '')}" placeholder="e.g. Tank 3 level"></div>
    <div class="field"><label>Serial #</label><input type="text" name="serial_number" value="${esc(d.serial_number || '')}"></div>
    ${withStatus ? `
    <div class="field"><label>Status</label><select name="status">${statusOptions(d.status || 'in_stock')}</select></div>
    <div class="field"><label>Location</label><select name="location_id">${locationOptions(locs, d.location_id)}</select></div>` : ''}
    <div class="field"><label>JoinEUI / AppEUI</label><input type="text" class="mono" name="join_eui" value="${esc(d.join_eui || '')}" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label>Firmware</label><input type="text" name="firmware" value="${esc(d.firmware || '')}"></div>
    <div class="field"><label>Purchase date</label><input type="date" name="purchase_date" value="${esc(d.purchase_date || '')}"></div>
    <div class="field"><label>Vendor</label><input type="text" name="vendor" value="${esc(d.vendor || '')}"></div>
    <div class="field"><label>PO #</label><input type="text" name="po_number" value="${esc(d.po_number || '')}"></div>
    <div class="field"><label>Cost (USD)</label><input type="number" step="0.01" min="0" name="cost" value="${esc(d.cost ?? '')}"></div>
    <div class="field"><label>Warranty expires</label><input type="date" name="warranty_expires" value="${esc(d.warranty_expires || '')}"></div>
    <div class="field wide"><label>Notes</label><textarea name="notes">${esc(d.notes || '')}</textarea></div>`;
}

async function editDeviceModal(d, onDone) {
  const ms = await models();
  modal(`<h2>Edit details</h2><form id="edForm"><div class="form">${deviceFields(d, ms)}</div>
    <p class="small muted" style="margin-top:10px">Status and location change through the status buttons so the history stays accurate.</p>
    <div class="modal-actions"><button type="button" class="sec" data-x>Cancel</button><button>Save</button></div></form>`, m => {
    m.querySelector('[data-x]').onclick = closeModal;
    wireQuickCreate(m.querySelector('[name=model_id]'), 'model', async () => {
      m.querySelector('[name=model_id]').innerHTML = modelOptions(await models());
    });
    m.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try { await api('/devices/' + d.id, { method: 'PUT', body: formData(e.target) }); closeModal(); toast('Saved'); onDone(); }
      catch (err) { toast(err.message, true); }
    };
  });
  $('#modal').style.maxWidth = '640px';
}
// reset modal width whenever it closes
new MutationObserver(() => { if (!$('#modalBackdrop').classList.contains('show')) $('#modal').style.maxWidth = ''; })
  .observe($('#modalBackdrop'), { attributes: true, attributeFilter: ['class'] });

// --- add device ---
async function pageNew(params) {
  const [ms, locs] = await Promise.all([models(true), locations(true)]);
  const prefill = { eui: params.get('eui'), join_eui: params.get('join'), serial_number: params.get('serial'),
    status: 'in_stock', location_id: locs.find(l => l.kind === 'warehouse' && !l.archived)?.id };
  view.innerHTML = `
    <div class="crumb"><a href="#/devices">‹ Devices</a></div>
    <div class="page-head"><div class="grow"><h1>Add device</h1>
      <p class="sub">Use the device EUI as its unique ID whenever it has one. Equipment without an EUI (antennas, solar kits…) gets a generated <span class="mono">JSP-</span> ID and a printable QR label.</p></div></div>
    <form id="newForm" class="card"><div class="form">${deviceFields(prefill, ms, { withStatus: true, locs })}</div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap">
        <a class="btn sec" href="#/devices">Cancel</a><button type="submit">Add to inventory</button></div></form>`;
  const f = $('#newForm');
  wireQuickCreate(f.model_id, 'model', async () => { f.model_id.innerHTML = modelOptions(await models()); });
  wireQuickCreate(f.location_id, 'location', async () => { f.location_id.innerHTML = locationOptions(await locations()); });
  $('#scanEui').onclick = () => scanOnce(parsed => {
    if (parsed.eui) f.eui.value = parsed.eui;
    if (parsed.join_eui) f.join_eui.value = parsed.join_eui;
    if (parsed.serial && !f.serial_number.value) f.serial_number.value = parsed.serial;
    if (!parsed.eui) toast('No EUI found in that code', true);
  });
  f.onsubmit = async e => {
    e.preventDefault();
    try {
      const d = await api('/devices', { method: 'POST', body: formData(f) });
      toast(`Added ${d.uid}`);
      go(d.uid_source === 'generated' ? `#/labels?ids=${d.id}&new=1` : `#/d/${d.id}`);
    } catch (err) {
      if (err.data?.device_id) {
        if (await confirmModal('Already in inventory', esc(err.message) + '. Open that device?', 'Open device')) go('#/d/' + err.data.device_id);
      } else toast(err.message, true);
    }
  };
}

// --- labels ---
async function pageLabels(params) {
  const ids = (params.get('ids') || '').split(',').filter(Boolean);
  const devs = await Promise.all(ids.map(i => api('/devices/' + i)));
  view.innerHTML = `
    <div class="no-print">
      <div class="crumb"><a href="${ids.length === 1 ? '#/d/' + ids[0] : '#/devices'}">‹ Back</a></div>
      <div class="page-head"><div class="grow"><h1>${params.get('new') ? 'Device added — print its label' : 'Print labels'}</h1>
        <p class="sub">Stick the label on the equipment. Scanning it in the app (or with any phone camera) opens the device.</p></div>
        <div class="actions"><button onclick="window.print()">🖨 Print</button>${ids.length === 1 ? `<a class="btn sec" href="#/d/${ids[0]}">Open device</a>` : ''}</div></div>
    </div>
    <div class="label-sheet">${devs.map(d => `<div class="label"><img src="/api/devices/${d.id}/qr.svg" alt="">
      <div><div class="lt">${esc(d.uid)}</div><div class="ls">${esc(modelText(d))}</div>
      ${d.serial_number ? `<div class="ls">S/N ${esc(d.serial_number)}</div>` : ''}
      <div class="lb"><img src="brand/jasper-icon-cyan.svg" alt="">Jasper inventory</div></div></div>`).join('')}</div>`;
}

// --- locations ---
async function pageLocations() {
  const locs = await locations(true);
  view.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Locations</h1>
      <p class="sub">Warehouses, deployment sites, vehicles and vendors — anywhere a device can be.</p></div>
      <div class="actions"><button id="addLoc">＋ Add location</button></div></div>
    ${locs.length ? META.location_kinds.map(k => {
      const items = locs.filter(l => l.kind === k.key);
      return items.length ? `<h2 style="margin-top:16px">${esc(k.label)}</h2><div class="tbl-wrap"><table><tbody>
        ${items.map(l => `<tr class="click" data-href="#/l/${l.id}" ${l.archived ? 'style="opacity:.55"' : ''}><td><div class="t1">${esc(l.name)}${l.archived ? ' <span class="tag">archived</span>' : ''}</div>
          <div class="t2">${esc(l.address || '')}</div></td><td style="text-align:right" class="nowrap"><b>${l.device_count}</b> <span class="muted small">device${l.device_count === 1 ? '' : 's'}</span></td></tr>`).join('')}
        </tbody></table></div>` : '';
    }).join('') : `<div class="card empty">No locations yet. Add your warehouse and deployment sites to get started.</div>`}`;
  wireRowLinks();
  $('#addLoc').onclick = () => locationModal(null, l => go('#/l/' + l.id));
}
function locationModal(l, onDone) {
  l ||= { kind: 'site' };
  modal(`<h2>${l.id ? 'Edit location' : 'New location'}</h2><form class="stack">
    <div class="field"><label>Name</label><input type="text" name="name" required value="${esc(l.name || '')}"></div>
    <div class="field"><label>Type</label><select name="kind">${options(META.location_kinds.map(k => ({ value: k.key, text: k.label })), l.kind)}</select></div>
    <div class="field"><label>Address / description</label><input type="text" name="address" value="${esc(l.address || '')}"></div>
    <div class="form" style="grid-template-columns:1fr 1fr">
      <div class="field"><label>Latitude</label><input type="number" step="any" name="lat" value="${esc(l.lat ?? '')}"></div>
      <div class="field"><label>Longitude</label><input type="number" step="any" name="lon" value="${esc(l.lon ?? '')}"></div></div>
    <button type="button" class="sec" id="useGps">📍 Use my current position</button>
    <div class="field"><label>Notes</label><textarea name="notes">${esc(l.notes || '')}</textarea></div>
    ${l.id ? `<label class="check"><input type="checkbox" name="archived" ${l.archived ? 'checked' : ''}> Archived (hidden from pickers)</label>` : ''}
    <div class="modal-actions"><button type="button" class="sec" data-x>Cancel</button><button>Save</button></div></form>`, m => {
    m.querySelector('[data-x]').onclick = closeModal;
    m.querySelector('#useGps').onclick = async e => {
      e.target.textContent = 'Getting position…';
      const p = await getPosition();
      e.target.textContent = '📍 Use my current position';
      if (!p) return toast('Location unavailable', true);
      m.querySelector('[name=lat]').value = p.lat; m.querySelector('[name=lon]').value = p.lon;
    };
    m.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try {
        const saved = await api(l.id ? '/locations/' + l.id : '/locations', { method: l.id ? 'PUT' : 'POST', body: formData(e.target) });
        cache.locations = null; closeModal(); toast('Saved'); onDone(saved);
      } catch (err) { toast(err.message, true); }
    };
  });
}
async function pageLocation(params, id) {
  const l = await api('/locations/' + id);
  const current = l.devices.filter(d => !['retired', 'lost'].includes(d.status));
  view.innerHTML = `
    <div class="crumb"><a href="#/locations">‹ Locations</a></div>
    <div class="page-head"><div class="grow"><h1>${esc(l.name)}</h1>
      <p class="sub">${esc(kindLabel(l.kind))}${l.address ? ' · ' + esc(l.address) : ''}${l.lat != null ? ` · <a href="https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lon}#map=15/${l.lat}/${l.lon}" target="_blank" rel="noopener">📍 map</a>` : ''}</p></div>
      <div class="actions"><button class="sec" id="editLoc">Edit</button>${current.length ? `<a class="btn sec" href="#/labels?ids=${current.map(d => d.id).join(',')}">🖨 Labels</a>` : ''}</div></div>
    ${l.notes ? `<div class="card small" style="margin-bottom:14px;white-space:pre-wrap">${esc(l.notes)}</div>` : ''}
    <div class="split">
      <div class="card"><div class="card-title">Here now<span class="r muted">${current.length}</span></div>
        ${current.length ? `<div class="tbl-wrap" style="border:0"><table><tbody>${current.map(d => `<tr class="click" data-href="#/d/${d.id}">
          <td><div class="t1">${esc(devTitle(d))}</div><div class="t2 mono">${esc(d.uid)}</div></td><td>${pill(d.status)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">Nothing here right now.</div>`}</div>
      <div class="card"><div class="card-title">History at this location</div>${timeline(l.history, true)}</div>
    </div>`;
  wireRowLinks();
  $('#editLoc').onclick = () => locationModal(l, () => pageLocation(params, id));
}

// --- catalog ---
async function pageModels() {
  const ms = await models(true);
  view.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Equipment catalog</h1>
      <p class="sub">The makes and models you stock. Each device in inventory points at one of these.</p></div>
      <div class="actions"><button id="addModel">＋ Add model</button></div></div>
    ${ms.length ? `<div class="tbl-wrap"><table><thead><tr><th>Model</th><th>Type</th><th>Devices</th><th></th></tr></thead><tbody>
      ${ms.map(m => `<tr><td><div class="t1">${esc(m.manufacturer)} ${esc(m.model)}</div><div class="t2">${esc(m.description || '')}</div></td>
        <td><span class="tag">${esc(catLabel(m.category))}</span></td>
        <td>${m.device_count ? `<a href="#/devices?model=${m.id}" data-model="${m.id}">${m.device_count}</a>` : '<span class="muted">0</span>'}</td>
        <td style="text-align:right"><button class="link" data-edit="${m.id}">Edit</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="card empty">No models yet. Add the sensors, gateways and other equipment you buy.</div>`}`;
  $('#addModel').onclick = () => modelModal(null);
  $$('[data-edit]').forEach(b => b.onclick = () => modelModal(ms.find(m => m.id === +b.dataset.edit)));
}
function modelModal(m) {
  m ||= { category: 'sensor' };
  modal(`<h2>${m.id ? 'Edit model' : 'New model'}</h2><form class="stack">
    <div class="field"><label>Category</label><select name="category">${options(META.categories.map(c => ({ value: c.key, text: c.label })), m.category)}</select></div>
    <div class="field"><label>Manufacturer</label><input type="text" name="manufacturer" required value="${esc(m.manufacturer || '')}"></div>
    <div class="field"><label>Model</label><input type="text" name="model" required value="${esc(m.model || '')}"></div>
    <div class="field"><label>Description</label><input type="text" name="description" value="${esc(m.description || '')}"></div>
    <div class="modal-actions">${m.id && !m.device_count ? '<button type="button" class="sec" data-del style="margin-right:auto;color:var(--danger)">Delete</button>' : ''}
      <button type="button" class="sec" data-x>Cancel</button><button>Save</button></div></form>`, el => {
    el.querySelector('[data-x]').onclick = closeModal;
    el.querySelector('[data-del]')?.addEventListener('click', async () => {
      try { await api('/models/' + m.id, { method: 'DELETE' }); cache.models = null; closeModal(); pageModels(); }
      catch (err) { toast(err.message, true); }
    });
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try {
        await api(m.id ? '/models/' + m.id : '/models', { method: m.id ? 'PUT' : 'POST', body: formData(e.target) });
        cache.models = null; closeModal(); toast('Saved'); pageModels();
      } catch (err) { toast(err.message, true); }
    };
  });
}

// ---------- scanning ----------
// Camera decoding: native BarcodeDetector where available (Chrome/Android — also reads 1D barcodes),
// otherwise jsQR on canvas frames (iOS Safari, Firefox).
class Scanner {
  constructor(video, onCode) { this.video = video; this.onCode = onCode; this.canvas = document.createElement('canvas'); }
  async start() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('insecure');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    if ('BarcodeDetector' in window) {
      try {
        const want = ['qr_code', 'data_matrix', 'code_128', 'code_39', 'ean_13', 'upc_a'];
        const have = await BarcodeDetector.getSupportedFormats();
        const formats = want.filter(f => have.includes(f));
        if (formats.length) this.detector = new BarcodeDetector({ formats });
      } catch { /* fall back to jsQR */ }
    }
    this.running = true;
    this.tick();
  }
  async tick() {
    if (!this.running) return;
    try {
      const code = await this.detect(this.video);
      if (code) this.onCode(code);
    } catch { /* frame not ready */ }
    this.timer = setTimeout(() => this.tick(), 160);
  }
  async detect(src) {
    if (this.detector) {
      const r = await this.detector.detect(src);
      if (r.length) return r[0].rawValue;
      if (src instanceof HTMLVideoElement) return null;
    }
    return decodeWithJsQR(src, this.canvas);
  }
  get torchSupported() { return !!this.stream?.getVideoTracks()[0]?.getCapabilities?.().torch; }
  async torch(on) { await this.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] }); }
  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach(t => t.stop());
  }
}
function decodeWithJsQR(src, canvas = document.createElement('canvas')) {
  const w0 = src.videoWidth || src.naturalWidth || src.width, h0 = src.videoHeight || src.naturalHeight || src.height;
  if (!w0 || !h0 || !window.jsQR) return null;
  const scale = Math.min(1, 900 / Math.max(w0, h0));
  canvas.width = Math.round(w0 * scale); canvas.height = Math.round(h0 * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data || null;
}
async function decodePhoto(file) {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  try {
    if ('BarcodeDetector' in window) {
      const r = await new BarcodeDetector().detect(img).catch(() => []);
      if (r.length) return r[0].rawValue;
    }
    return decodeWithJsQR(img);
  } finally { URL.revokeObjectURL(img.src); }
}

const scannerMarkup = `
  <div class="scanner" id="scanBox"><video id="scanVideo" playsinline muted></video><div class="frame" id="scanFrame"></div>
    <div class="tools"><button type="button" id="torchBtn" style="display:none">🔦</button></div>
    <div class="msg" id="scanMsg">Starting camera…</div></div>`;
function insecureMsg() {
  return `<div>📷 The live camera needs a secure (https) connection on phones.</div>
    <div class="small" style="opacity:.8">Use <b>Take photo</b> below instead — it works everywhere — or open the app over https.</div>`;
}
async function mountScanner(onCode) {
  const msg = $('#scanMsg');
  let last = '', lastAt = 0;
  const sc = new Scanner($('#scanVideo'), code => {
    const now = Date.now();
    if (code === last && now - lastAt < 3000) return; // ignore the same code while it stays in frame
    last = code; lastAt = now;
    navigator.vibrate?.(60);
    $('#scanFrame')?.classList.add('hit');
    setTimeout(() => $('#scanFrame')?.classList.remove('hit'), 400);
    onCode(code);
  });
  try {
    await sc.start();
    msg.style.display = 'none';
    if (sc.torchSupported) {
      let on = false;
      $('#torchBtn').style.display = '';
      $('#torchBtn').onclick = async () => { on = !on; await sc.torch(on).catch(() => {}); };
    }
  } catch (e) {
    $('#scanBox').classList.add('off');
    msg.innerHTML = e.message === 'insecure' ? insecureMsg()
      : `<div>📷 Camera unavailable</div><div class="small" style="opacity:.8">${esc(e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in your browser settings, or use Take photo below.' : e.message)}</div>`;
  }
  return sc;
}

// Pop-up scanner used from forms (e.g. "scan EUI" on the add-device page)
function scanOnce(onParsed) {
  let sc;
  modal(`<h2>Scan device code</h2>${scannerMarkup}
    <div class="modal-actions"><label class="btn sec" style="margin-right:auto">📷 Take photo<input type="file" accept="image/*" capture="environment" hidden id="photoIn"></label>
    <button type="button" class="sec" data-x>Close</button></div>`, async m => {
    const done = async code => {
      sc?.stop(); closeModal();
      const { parsed } = await api('/lookup?code=' + encodeURIComponent(code));
      onParsed(parsed);
    };
    m.querySelector('[data-x]').onclick = () => { sc?.stop(); closeModal(); };
    m.querySelector('#photoIn').onchange = async e => {
      const code = e.target.files[0] && await decodePhoto(e.target.files[0]);
      code ? done(code) : toast('No code found in that photo', true);
    };
    sc = await mountScanner(done);
  });
  const stopOnClose = new MutationObserver(() => {
    if (!$('#modalBackdrop').classList.contains('show')) { sc?.stop(); stopOnClose.disconnect(); }
  });
  stopOnClose.observe($('#modalBackdrop'), { attributes: true, attributeFilter: ['class'] });
}

async function pageScan(params, code) {
  const [ms, locs] = await Promise.all([models(true), locations(true)]);
  let mode = 'lookup';
  try { mode = sessionStorage.getItem('jinv.scanMode') || 'lookup'; } catch {}
  const batch = { log: [] };
  view.innerHTML = `
    <div class="page-head"><div class="grow"><h1>Scan</h1>
      <p class="sub">Point the camera at a device’s QR code — the manufacturer’s LoRaWAN code or a Jasper label.</p></div></div>
    <div class="split">
      <div class="stack">
        <div class="mode-tabs"><button type="button" data-mode="lookup">Look up &amp; update</button><button type="button" data-mode="batch">Receive batch</button></div>
        ${scannerMarkup}
        <div class="inline">
          <form id="manual" class="inline" style="flex:1"><input type="text" name="code" placeholder="…or type an EUI, UID or serial" autocomplete="off" spellcheck="false"><button class="sec">Go</button></form>
          <label class="btn sec" title="Take or choose a photo of the code">📷 Photo<input type="file" accept="image/*" capture="environment" hidden id="photoIn"></label>
        </div>
      </div>
      <div class="stack">
        <div id="batchCfg" class="card" style="display:none"><div class="card-title">Batch defaults</div>
          <p class="small muted" style="margin:0 0 10px">Each new code scanned is added with these details. Codes already in inventory are skipped.</p>
          <form class="form" id="batchForm" style="grid-template-columns:1fr 1fr">
            <div class="field wide"><label>Model</label><select name="model_id">${modelOptions(ms)}</select></div>
            <div class="field wide"><label>Location</label><select name="location_id">${locationOptions(locs, locs.find(l => l.kind === 'warehouse' && !l.archived)?.id)}</select></div>
            <div class="field"><label>Purchase date</label><input type="date" name="purchase_date" value="${new Date().toISOString().slice(0, 10)}"></div>
            <div class="field"><label>PO #</label><input type="text" name="po_number"></div>
            <div class="field"><label>Vendor</label><input type="text" name="vendor"></div>
            <div class="field"><label>Unit cost</label><input type="number" step="0.01" name="cost"></div>
          </form></div>
        <div id="result"></div>
        <div id="batchLog" class="card" style="display:none"><div class="card-title">This session<span class="r muted" id="batchCount"></span></div><ul class="batch-log"></ul></div>
      </div>
    </div>`;
  const setMode = m => {
    mode = m;
    try { sessionStorage.setItem('jinv.scanMode', m); } catch {}
    $$('.mode-tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('#batchCfg').style.display = m === 'batch' ? '' : 'none';
    $('#batchLog').style.display = m === 'batch' && batch.log.length ? '' : 'none';
    $('#result').innerHTML = '';
  };
  $$('.mode-tabs button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  const bf = $('#batchForm');
  wireQuickCreate(bf.model_id, 'model', async () => { bf.model_id.innerHTML = modelOptions(await models()); });
  wireQuickCreate(bf.location_id, 'location', async () => { bf.location_id.innerHTML = locationOptions(await locations()); });
  setMode(mode);

  const handle = async raw => {
    const res = await api('/lookup?code=' + encodeURIComponent(raw)).catch(e => (toast(e.message, true), null));
    if (!res) return;
    mode === 'batch' ? batchAdd(res) : showResult(res);
    if (mode !== 'batch') $('#result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  const showResult = ({ parsed, device: d }) => {
    if (d) {
      $('#result').innerHTML = `<div class="card result" style="--c:${STATUS_COLOR[d.status]}">
        <div class="card-title">Found</div>
        <div style="display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap">
          <div><h2 style="margin:0">${esc(devTitle(d))}</h2><div class="mono small">${esc(d.uid)}</div>
          <div class="small muted">${esc(modelText(d))}</div></div>
          <div style="text-align:right">${pill(d.status)}<div class="small muted">${esc(d.location_name || 'No location')}</div></div></div>
        <div class="qa" style="margin-top:12px">${ACTIONS.map(a => `<button data-act="${a.key}" style="--c:${STATUS_COLOR[a.key]}" class="${d.status === a.key ? 'cur' : ''}"><span class="i">${STATUS_ICON[a.key]}</span>${esc(a.text)}</button>`).join('')}</div>
        <a class="btn sec full" style="margin-top:10px" href="#/d/${d.id}">Open device details ›</a></div>`;
      $$('#result [data-act]').forEach(b => b.onclick = () => transitionModal(d, b.dataset.act, nd => showResult({ parsed, device: nd })));
    } else {
      const what = parsed.eui ? `EUI <span class="mono">${fmtEui(parsed.eui)}</span>` : parsed.uid ? `UID <span class="mono">${esc(parsed.uid)}</span>` : `<span class="mono">${esc(parsed.raw)}</span>`;
      const qs = new URLSearchParams();
      if (parsed.eui) qs.set('eui', parsed.eui);
      if (parsed.join_eui) qs.set('join', parsed.join_eui);
      if (parsed.serial) qs.set('serial', parsed.serial);
      $('#result').innerHTML = `<div class="card result" style="--c:var(--warn)"><div class="card-title">Not in inventory</div>
        <p style="margin:0 0 12px">${what} isn’t tracked yet.</p>
        <a class="btn full" href="#/new?${qs}">＋ Add this device</a></div>`;
    }
  };
  const batchAdd = async ({ parsed, device }) => {
    const li = document.createElement('li');
    const id = parsed.eui || parsed.uid || parsed.raw;
    if (device) {
      li.innerHTML = `<span class="pill" style="--c:var(--muted)">Skipped</span><a class="mono" href="#/d/${device.id}">${esc(device.uid)}</a><span class="muted small">already in inventory</span>`;
    } else if (!parsed.eui) {
      li.innerHTML = `<span class="pill" style="--c:var(--danger)">No EUI</span><span class="mono small">${esc(parsed.raw.slice(0, 40))}</span>`;
    } else {
      const f = formData(bf);
      if (!f.model_id || f.model_id === '__new') { toast('Choose a model for this batch first', true); return; }
      try {
        const d = await api('/devices', { method: 'POST', body: { ...f, eui: parsed.eui, join_eui: parsed.join_eui, serial_number: parsed.serial, status: 'in_stock' } });
        li.innerHTML = `<span class="pill" style="--c:var(--good)">Added</span><a class="mono" href="#/d/${d.id}">${esc(d.uid)}</a>`;
        toast('Added ' + d.uid);
      } catch (e) { li.innerHTML = `<span class="pill" style="--c:var(--danger)">Error</span><span class="small">${esc(e.message)}</span>`; }
    }
    batch.log.unshift(id);
    $('#batchLog ul').prepend(li);
    $('#batchLog').style.display = '';
    $('#batchCount').textContent = `${batch.log.length} scanned`;
  };

  $('#manual').onsubmit = e => { e.preventDefault(); const v = e.target.code.value.trim(); if (v) { handle(v); e.target.code.value = ''; } };
  $('#photoIn').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const c = await decodePhoto(file).catch(() => null);
    c ? handle(c) : toast('No QR code found in that photo — try closer and in focus', true);
  };
  const sc = await mountScanner(handle);
  cleanup = () => sc.stop();
  if (code) handle(code);
}

// ---------- boot ----------
let signedIn = null; // email from Cloudflare Access, when deployed behind it
function renderActor() {
  $('#actorLbl').textContent = signedIn || actor.get() || 'Set name';
}
$('#actorBtn').onclick = () => signedIn ? toast(`Signed in as ${signedIn}`) : modal(`<h2>Who’s using this device?</h2>
  <p class="muted small">Your name is saved on this browser and recorded on history entries you make. (Sign-in comes later.)</p>
  <form class="stack"><input type="text" name="n" value="${esc(actor.get())}" placeholder="Your name">
  <div class="modal-actions"><button type="button" class="sec" data-x>Cancel</button><button>Save</button></div></form>`, m => {
  m.querySelector('[data-x]').onclick = closeModal;
  m.querySelector('form').onsubmit = e => { e.preventDefault(); actor.set(e.target.n.value.trim()); renderActor(); closeModal(); };
});

window.addEventListener('hashchange', router);
(async () => {
  renderActor();
  try {
    [META, { email: signedIn }] = await Promise.all([api('/meta'), api('/me')]);
    renderActor();
  } catch { view.innerHTML = '<div class="card empty">Can’t reach the server.</div>'; return; }
  router();
})();
