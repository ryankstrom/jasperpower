#!/usr/bin/env bash
# One-time setup of JasperInventory on a fresh Debian 12 VM (e.g. a Google Cloud e2-micro).
# Safe to re-run. See deploy/DEPLOY.md for the full walkthrough.
#
#   sudo PUBLIC_URL=https://inventory.example.com \
#        TUNNEL_TOKEN=<cloudflare tunnel token> \
#        BACKUP_BUCKET=<gcs bucket name> \
#        /opt/jasperpower/Inventory/deploy/setup-vm.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ryankstrom/jasperpower.git}"
BRANCH="${BRANCH:-main}"
SRC=/opt/jasperpower
APP="$SRC/Inventory"
DATA=/var/lib/jasperinventory
ENV_FILE=/etc/jasperinventory.env

[[ $EUID -eq 0 ]] || { echo "Run with sudo"; exit 1; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

step "Swap (the e2-micro only has 1 GB RAM)"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "System packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg >/dev/null

step "Node.js 22"
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -e 'require("node:sqlite")' || { echo "This Node build lacks node:sqlite (need 22.13+)"; exit 1; }
echo "node $(node -v)"

step "App user and folders"
id jasper &>/dev/null || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin jasper
mkdir -p "$DATA" && chown jasper:jasper "$DATA" && chmod 750 "$DATA"

step "Code from $REPO_URL ($BRANCH)"
if [[ ! -d "$SRC/.git" ]]; then
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$SRC"
fi
chown -R jasper:jasper "$SRC"
sudo -u jasper git -C "$SRC" fetch --quiet origin "$BRANCH"
sudo -u jasper git -C "$SRC" reset --quiet --hard "origin/$BRANCH"
(cd "$APP" && sudo -u jasper npm ci --omit=dev --no-audit --no-fund)

step "Config ($ENV_FILE)"
touch "$ENV_FILE" && chmod 640 "$ENV_FILE" && chgrp jasper "$ENV_FILE"
setenv() { # set KEY=VALUE, keeping any existing value unless a new one is given
  local key=$1 val=$2
  if grep -q "^$key=" "$ENV_FILE"; then
    [[ -n "$val" ]] && sed -i "s|^$key=.*|$key=$val|" "$ENV_FILE"
  else
    echo "$key=$val" >> "$ENV_FILE"
  fi
}
setenv NODE_ENV production
setenv PORT 8790
setenv HOST 127.0.0.1               # only the Cloudflare tunnel (on this machine) can reach the app
setenv DB_PATH "$DATA/inventory.db"
setenv TRUST_ACCESS_HEADER 1        # record the Cloudflare Access email on history entries
setenv PUBLIC_URL "${PUBLIC_URL:-}"
setenv BACKUP_BUCKET "${BACKUP_BUCKET:-}"
cat "$ENV_FILE"

step "Services"
install -m 644 "$APP"/deploy/jasperinventory*.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now jasperinventory jasperinventory-backup.timer
systemctl restart jasperinventory
sleep 2
curl -fsS http://127.0.0.1:8790/api/meta >/dev/null && echo "App is running on 127.0.0.1:8790"

if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
  step "Cloudflare Tunnel"
  if ! command -v cloudflared >/dev/null; then
    mkdir -p --mode=0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
      > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -qq && apt-get install -y -qq cloudflared >/dev/null
  fi
  if systemctl list-unit-files cloudflared.service &>/dev/null && systemctl is-enabled cloudflared &>/dev/null; then
    echo "cloudflared service already installed (to change the token: sudo cloudflared service uninstall, then re-run)"
  else
    cloudflared service install "$TUNNEL_TOKEN"
  fi
  systemctl is-active --quiet cloudflared && echo "Tunnel connected"
else
  echo; echo "No TUNNEL_TOKEN given — skipping Cloudflare Tunnel. Re-run with TUNNEL_TOKEN=... to add it."
fi

step "Done"
echo "Logs:     journalctl -u jasperinventory -f"
echo "Update:   sudo $APP/deploy/update.sh"
echo "Backup:   sudo systemctl start jasperinventory-backup   (runs nightly)"
