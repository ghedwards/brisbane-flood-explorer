#!/usr/bin/env bash
# Install the GeoLibre tool runner: the engine RustGIS uses for its 1,000+
# Whitebox and GeoLibre terrain and hydrology tools. Downloads the release
# archive that RustGIS's own installer uses and checks its SHA-256.
#
# Usage: tests/geolibre/install_geolibre.sh [install-dir]
# Env:   GEOLIBRE_TAG (default below), GH_TOKEN for the GitHub CLI.
set -euo pipefail

TAG="${GEOLIBRE_TAG:-v1.6.0}"
DEST="${1:-$HOME/.local/bin}"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  TARGET=x86_64-unknown-linux-gnu ;;
  Linux-aarch64) TARGET=aarch64-unknown-linux-gnu ;;
  Darwin-arm64)  TARGET=aarch64-apple-darwin ;;
  Darwin-x86_64) TARGET=x86_64-apple-darwin ;;
  *) echo "No GeoLibre runner for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

NAME="geolibre-${TAG}-${TARGET}.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $NAME"
for attempt in 1 2 3 4; do
  if gh release download "$TAG" --repo opengeos/geolibre-rust --clobber \
      --pattern "$NAME" --pattern "$NAME.sha256" --dir "$TMP"; then
    break
  fi
  [ "$attempt" = 4 ] && { echo "Could not download $NAME" >&2; exit 1; }
  echo "Download failed; retrying in $((attempt * 15)) s" >&2
  sleep $((attempt * 15))
done

expected="$(awk '{print tolower($1)}' "$TMP/$NAME.sha256")"
actual="$( (sha256sum "$TMP/$NAME" 2>/dev/null || shasum -a 256 "$TMP/$NAME") | awk '{print $1}')"
if [ "$expected" != "$actual" ]; then
  echo "Checksum mismatch for $NAME" >&2
  exit 1
fi

mkdir -p "$TMP/x" "$DEST"
tar -xzf "$TMP/$NAME" -C "$TMP/x"
EXE="$(find "$TMP/x" -type f -name geolibre | head -n1)"
[ -n "$EXE" ] || { echo "$NAME has no geolibre program" >&2; exit 1; }
install -m 0755 "$EXE" "$DEST/geolibre"
echo "Installed $("$DEST/geolibre" version) to $DEST/geolibre"
