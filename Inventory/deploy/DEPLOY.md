# Deploying JasperInventory (free tier)

This guide runs the app on a **Google Cloud always-free e2-micro VM**. **Cloudflare
Tunnel** gives it an https address, and **Cloudflare Access** puts a sign-in
screen in front of it. Backups go to a Cloud Storage bucket each night.

```
phone / laptop ──https──▶ Cloudflare (Access sign-in) ──tunnel──▶ e2-micro VM
                                                                 ├─ cloudflared
                                                                 ├─ node server  (127.0.0.1:8790)
                                                                 └─ SQLite  /var/lib/jasperinventory
                                                                       └─ nightly ▶ gs://<bucket>/daily/
```

The VM accepts no inbound web traffic. The tunnel connects out to Cloudflare, so
there are no firewall ports to open and no certificates to manage.

**You need:** a Google account with billing turned on (it stays at $0 within the
free limits), and a domain on a free Cloudflare account. A subdomain such as
`inventory.yourdomain.com` is fine.

Allow about 45 minutes the first time. You can do steps 1–3 in the Google Cloud
console, or run the `gcloud` commands in [Cloud Shell](https://shell.cloud.google.com).

---

## 1. Google Cloud project and budget alert

1. Create a project, e.g. `jasper-inventory`, and link a billing account.
2. **Billing → Budgets & alerts → Create budget**: set the amount to **$1** and
   email alerts at 50% and 100%. If anything starts billing, you'll know within a day.
   The budget must use the billing account's own currency (e.g. `1CAD` for a Canadian
   account); `gcloud billing budgets create` rejects a mismatched currency with a
   bare "invalid argument".

```sh
gcloud config set project jasper-inventory
gcloud services enable compute.googleapis.com storage.googleapis.com
```

## 2. Backup bucket

Bucket names are global, so add something unique. A US region keeps it in the free 5 GB.

```sh
BUCKET=jasper-inventory-backups-$RANDOM
gcloud storage buckets create gs://$BUCKET --location=us-central1 \
  --default-storage-class=STANDARD --uniform-bucket-level-access
# delete backups older than 90 days
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":90}}]}' > /tmp/lc.json
gcloud storage buckets update gs://$BUCKET --lifecycle-file=/tmp/lc.json
echo $BUCKET   # note this for step 5
```

## 3. The VM

These settings matter for staying free: **e2-micro**, one of **us-central1 / us-west1 / us-east1**,
**Standard persistent disk** (not Balanced) of at most 30 GB.

```sh
gcloud compute instances create jasper-inventory \
  --zone=us-central1-a --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --scopes=default,storage-rw
```

`storage-rw` lets the VM write backups to the bucket.

> In the console: Compute Engine → VM instances → Create. Machine type
> e2-micro; Boot disk: Debian 12, *Standard persistent disk*, 30 GB; Access
> scopes → *Set access for each API* → Storage: **Read Write**.

## 4. Cloudflare Tunnel

1. Add your domain to Cloudflare if it isn't there yet.
2. First time only: **Zero Trust → Get started → Zero Trust Free** ($0, up to 50 users).
   Cloudflare asks you to accept its terms and keep a card on file.
3. Go to **Networking → Tunnels → Create Tunnel**. Name it `jasper-inventory`.
4. On the install screen, copy the **token**: the long string after
   `cloudflared service install` (use the copy button; the dashboard masks it on
   screen). You'll paste it in step 5. Skip running their install command,
   because the setup script does it.
5. **Public hostname**: subdomain `inventory`, your domain, service **HTTP**,
   URL `localhost:8790`. Save.

## 5. Install the app on the VM

```sh
gcloud compute ssh jasper-inventory --zone=us-central1-a
```

Then, on the VM:

```sh
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/ryankstrom/jasperpower.git /opt/jasperpower
sudo PUBLIC_URL=https://inventory.yourdomain.com \
     BACKUP_BUCKET=<bucket from step 2> \
     TUNNEL_TOKEN=<token from step 4> \
     /opt/jasperpower/Inventory/deploy/setup-vm.sh
```

The script adds swap, installs Node 22, creates a `jasper` service user, installs
the app, starts it with systemd (so it restarts on crash and on reboot), sets up
the nightly backup timer, and installs the Cloudflare tunnel. It's safe to re-run.

You can open `https://inventory.yourdomain.com` now, but **finish step 6 before
telling anyone the address**. Until then, anyone who finds it can edit the inventory.

## 6. Lock it down with Cloudflare Access

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. Name: `Jasper Inventory`. Domain: `inventory.yourdomain.com`. Session: 1 month is
   convenient on phones.
3. Add a policy: **Allow**. Include **Emails ending in** `@yourdomain.com`, and/or
   specific **Emails** for people outside your domain.
4. Login method: a new Zero Trust account only has the **Cloudflare** login, which
   your staff don't have. Add **One-time PIN** under **Integrations → Identity
   providers → Add an identity provider** (Cloudflare emails a code). Then, in the
   application's **Authentication** section, turn off *Accept all available identity
   providers*, choose only **One-time PIN**, and turn on **Apply instant
   authentication** so people go straight to the email box. "Sign in with Google"
   can be added the same way later; Cloudflare walks you through the OAuth client.

5. Branding (optional): **Reusable components → Custom pages → Access login page**.
   Set the organization name, a logo URL, header and message text, and background
   `#34464a` (Jasper slate). The logo must be publicly reachable, and everything on
   the app's hostname is behind Access, so point it at jsDelivr instead, e.g.
   `https://cdn.jsdelivr.net/gh/ryankstrom/jasperpower@<commit>/Inventory/public/brand/jasper-logo-cyan.svg`.
   With a custom background the login card is white, so use the slate (`-cyan`)
   logo, not the white one. The organization name is shown beside the logo and is
   required; to hide it, set it to a single zero-width space (U+200B). A blank or
   ordinary space makes Cloudflare show the team domain there instead. Changes take
   about a minute to appear. Under **Settings → Team domain** you can rename the
   sign-in address (this account uses `jasper-tools.cloudflareaccess.com`).

Access is free for up to 50 users. Once someone signs in, the app records their
email on every history entry, and the "Set name" button shows who's signed in.

## 7. Check it

- On your phone, open the address, sign in, then tap **Scan**. The live camera should start.
- Before printing labels for real equipment, make sure `PUBLIC_URL` was set,
  since that's the address labels point to.
- Add the page to your home screen (Share → Add to Home Screen) for an app-like icon.

---

## Day-to-day

| Task | Command (on the VM) |
|---|---|
| Deploy latest code from GitHub `main` | `sudo /opt/jasperpower/Inventory/deploy/update.sh` |
| App logs | `journalctl -u jasperinventory -f` |
| Restart | `sudo systemctl restart jasperinventory` |
| Run a backup now | `sudo systemctl start jasperinventory-backup` |
| Next scheduled backup | `systemctl list-timers jasperinventory-backup` |
| Change settings | `sudo nano /etc/jasperinventory.env` then restart |

### Restoring a backup

```sh
sudo systemctl stop jasperinventory
gcloud storage cp gs://<bucket>/daily/inventory-YYYYMMDD-HHMMSS.db.gz /tmp/
gunzip /tmp/inventory-*.db.gz
sudo rm -f /var/lib/jasperinventory/inventory.db-wal /var/lib/jasperinventory/inventory.db-shm
sudo install -o jasper -g jasper -m 640 /tmp/inventory-*.db /var/lib/jasperinventory/inventory.db
sudo systemctl start jasperinventory
```

Local copies from the last 14 days are also in `/var/lib/jasperinventory/backups/`.

### Notes

- **Cost**: Google's free-tier terms change from time to time. The $1 budget
  alert is your early warning. The likeliest small charges are network egress
  beyond 1 GB/month (unlikely for this app) or the VM's external IP address.
- **Moving off the free tier later**: the app is just Node and one SQLite file.
  Copy a backup to any host, set `DB_PATH`, and run `npm start`.
- **Security**: the app listens only on 127.0.0.1. Cloudflare Access is what keeps
  strangers out, so don't remove the Access application.
