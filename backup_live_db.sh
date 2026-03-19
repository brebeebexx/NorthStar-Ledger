#!/bin/bash
set -euo pipefail

APP_DIR="/home/breadmin/northstar-ledger-live"
BACKUP_DIR="/home/breadmin/backups/northstar-ledger/daily"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

choose_db() {
  if [ -f "$APP_DIR/data-live.db" ]; then
    printf '%s
' "$APP_DIR/data-live.db"
  elif [ -f "$APP_DIR/data.db" ]; then
    printf '%s
' "$APP_DIR/data.db"
  else
    return 1
  fi
}

DB_PATH="$(choose_db)"
DB_NAME="$(basename "$DB_PATH")"
OUT="$BACKUP_DIR/${DB_NAME%.db}_backup_${STAMP}.db"
TMP="$OUT.tmp"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".timeout 5000" ".backup '$TMP'"
else
  cp -p "$DB_PATH" "$TMP"
fi

mv "$TMP" "$OUT"
chmod 600 "$OUT"

echo "Created backup: $OUT"
/home/breadmin/git-autopush/push-northstar-db-backup.sh
