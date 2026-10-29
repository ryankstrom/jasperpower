# JasperInventory

Equipment inventory for the Jasper product: LoRaWAN sensors, gateways, antennas,
power kits and other serialised hardware (not consumables like wire or enclosures).

![Jasper](public/brand/jasper-icon-cyan.svg)

## Features

- **One unique ID per item.** The device EUI (DevEUI / Gateway EUI) is the UID
  whenever there is one. Equipment without an EUI gets a generated
  `JSP-XXXXXXXX` ID and a printable QR label.
- **Status + location tracking**: In Stock, Deployed, In Transit, In Repair,
  Retired, Lost, and where it is (warehouses, sites, vehicles, vendors, customers).
- **Full history** for every device: each status change, move, edit and note is
  logged with time, who did it, and optional phone GPS. Deployment history
  (which sites, from when to when) comes from that log.
- **Phone scanning**: scan the manufacturer's LoRaWAN QR code (LoRa Alliance
  TR005 `LW:D0:…`, vendor JSON, plain EUI text) or a Jasper label, then check the
  device in or out in two taps. **Receive batch** mode adds a whole box of new
  sensors by scanning one after another.
- Purchase info (date, vendor, PO, cost, warranty), an equipment catalog
  (make/model), a dashboard, search and filters, and CSV export.

## Run it

Requires Node 22.13+ (it uses Node's built-in SQLite, so there are no native builds).

```sh
npm install
npm start            # http://localhost:8790
```

Data lives in `data/inventory.db` (SQLite, git-ignored). To try it with demo data
in a throwaway database:

```sh
DB_PATH=/tmp/jinv-demo.db npm run seed
DB_PATH=/tmp/jinv-demo.db npm start
```

Environment variables: `PORT` (default 8790), `DB_PATH`, `PUBLIC_URL` (base URL
printed into QR labels; defaults to the host the request came in on),
`HTTPS_PORT` (default 8791).

## Using it from a phone

Phones only allow live camera access over **https** (or localhost). Over plain
http on your LAN the scanner falls back to **📷 Photo**, which takes a picture and
decodes it. That works everywhere, just one tap slower.

For the live scanner on your LAN, put a trusted certificate in `certs/` and the
server will also listen on https. With [mkcert](https://github.com/FiloSottile/mkcert):

```sh
mkcert -install
mkdir -p certs && mkcert -key-file certs/key.pem -cert-file certs/cert.pem <your-mac-hostname>.local localhost
npm start            # also https://<your-mac-hostname>.local:8791
```

(Install the mkcert root CA on the phone too: see the mkcert README.) In a real
deployment, put the app behind a reverse proxy or host that terminates TLS.

QR labels encode `<PUBLIC_URL>/u/<UID>`, so a phone's own camera app also opens
the device directly. Set `PUBLIC_URL` before printing labels for production.

## Layout

```
server/index.js   Express app, static files, optional https
server/api.js     REST API (/api/...)
server/db.js      SQLite schema + migrations, status/category/location vocab
server/codes.js   EUI normalisation, JSP- ID generation, scanned-code parsing
server/seed.js    demo data
public/           single-page app (no build step), Jasper House styling
```

## API (summary)

| Method | Path | |
|---|---|---|
| GET | `/api/devices?q=&status=&category=&location_id=&model_id=&all=1` | list/search |
| POST | `/api/devices` | create (UID = EUI, else generated) |
| GET/PUT/DELETE | `/api/devices/:id` | detail (+ history) / edit / delete |
| POST | `/api/devices/:id/transition` | change status/location `{status, location_id, note, lat, lon}` |
| POST | `/api/devices/:id/notes` | add a note |
| GET | `/api/devices/:id/qr.svg` | label QR |
| GET | `/api/lookup?code=` | resolve a scanned code to a device |
| GET | `/api/devices.csv` | export |
| CRUD | `/api/locations`, `/api/models` | locations and catalog |
| GET | `/api/stats`, `/api/events` | dashboard |

The `X-Actor` header carries the user's name for history entries until sign-in exists.

## Roadmap

- **Sign-in / SSO**: replace `actorOf()` in `server/api.js` with the
  authenticated user (OIDC: Entra ID, Google Workspace, or Okta) and add roles.
- **Postgres** for multi-user hosting. The schema uses portable SQL.
- **myDevices / network-server sync**: match on EUI to pull last-seen, battery
  and RSSI, and to push new devices to the LNS on receipt.
- CSV import, and bulk label printing from a filtered list.
