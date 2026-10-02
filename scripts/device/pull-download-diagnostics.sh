#!/usr/bin/env bash
# Copy download diagnostics off a USB-connected iPhone without foregrounding
# the app, then run the acceptance checks.
#
#   SUBSTREAMER_DEVICE=<udid> SUBSTREAMER_BUNDLE_ID=<bundle id> \
#     scripts/device/pull-download-diagnostics.sh <label> [navidrome.log]
#
# Requires a build prebuilt with SUBSTREAMER_DOWNLOAD_DIAGNOSTICS=1.
# `xcrun devicectl list devices` shows the udid.
set -euo pipefail

DEVICE=${SUBSTREAMER_DEVICE:?set SUBSTREAMER_DEVICE to the device udid}
APP=${SUBSTREAMER_BUNDLE_ID:?set SUBSTREAMER_BUNDLE_ID to the installed bundle id}
LABEL=${1:?usage: pull-download-diagnostics.sh <label> [navidrome.log]}
NAVIDROME_LOG=${2:-}
OUT=${SUBSTREAMER_DIAGNOSTICS_DIR:-/tmp/substreamer-diagnostics}/$LABEL
HERE=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$OUT"

copy() {
  xcrun devicectl device copy from --device "$DEVICE" \
    --domain-type appDataContainer --domain-identifier "$APP" \
    --source "$1" --destination "$OUT/$2" > "$OUT/$2.copy.log" 2>&1 \
    || echo "warning: could not copy $1 (see $OUT/$2.copy.log)"
}

copy Documents/download-diagnostics.jsonl download-diagnostics.jsonl
# The database is in WAL mode: copy the WAL too or recent writes are missing.
copy Documents/SQLite/substreamer7.db substreamer7.db
copy Documents/SQLite/substreamer7.db-wal substreamer7.db-wal
copy Documents/SQLite/substreamer7.db-shm substreamer7.db-shm

xcrun devicectl device info files --device "$DEVICE" \
  --domain-type appDataContainer --domain-identifier "$APP" \
  --subdirectory Documents/music-cache --json-output "$OUT/music-cache.json" \
  > "$OUT/music-cache.command.log" 2>&1 \
  || echo "warning: could not list music-cache (see $OUT/music-cache.command.log)"

if [[ -n "$NAVIDROME_LOG" ]]; then
  cp "$NAVIDROME_LOG" "$OUT/navidrome.log"
fi

python3 "$HERE/check-download-acceptance.py" "$OUT"
