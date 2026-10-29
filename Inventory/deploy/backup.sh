#!/usr/bin/env bash
# Snapshot the SQLite database, keep 14 days locally, and copy to Cloud Storage if BACKUP_BUCKET is set.
set -euo pipefail
: "${DB_PATH:?DB_PATH is not set}"
dir="$(dirname "$DB_PATH")/backups"
mkdir -p "$dir"
out="$dir/inventory-$(date -u +%Y%m%d-%H%M%S).db"

# VACUUM INTO gives a consistent copy while the app keeps running
node -e '
  const { DatabaseSync } = require("node:sqlite");
  new DatabaseSync(process.argv[1]).exec(`VACUUM INTO '\''${process.argv[2]}'\''`);
' "$DB_PATH" "$out"
gzip "$out"
find "$dir" -name 'inventory-*.db.gz' -mtime +14 -delete

if [[ -n "${BACKUP_BUCKET:-}" ]]; then
  gcloud storage cp --quiet "$out.gz" "gs://${BACKUP_BUCKET}/daily/"
fi
echo "Backup written: $out.gz"
