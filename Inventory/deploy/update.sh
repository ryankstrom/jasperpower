#!/usr/bin/env bash
# Pull the latest code from GitHub and restart. Run on the VM:  sudo /opt/jasperpower/Inventory/deploy/update.sh
set -euo pipefail
SRC=/opt/jasperpower
BRANCH="${BRANCH:-main}"
sudo -u jasper git -C "$SRC" fetch --quiet origin "$BRANCH"
sudo -u jasper git -C "$SRC" reset --quiet --hard "origin/$BRANCH"
(cd "$SRC/Inventory" && sudo -u jasper npm ci --omit=dev --no-audit --no-fund)
install -m 644 "$SRC"/Inventory/deploy/jasperinventory*.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl restart jasperinventory
sleep 2
curl -fsS http://127.0.0.1:8790/api/meta >/dev/null && echo "Updated to $(sudo -u jasper git -C "$SRC" log --oneline -1)"
