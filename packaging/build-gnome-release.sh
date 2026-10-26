#!/usr/bin/env bash
# build-gnome-release.sh — compila e empacota o release de produção do Linux/GNOME.
#
# Gera `etherbit-tiling-gnome.tar.gz` na raiz do repo contendo APENAS os
# artefatos de produção (binário do daemon + bundle da extensão + installer),
# sem código-fonte (.rs/.ts) nem histórico. Chamado pelo semantic-release via
# o prepareCmd em .releaserc.json:
#
#   bash packaging/build-gnome-release.sh <versao>
set -euo pipefail

VERSION="${1:?uso: build-gnome-release.sh <versao>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_NAME="etherbit-tiling-gnome"
STAGE="$ROOT/dist-release/$STAGE_NAME"

echo ">> Limpando staging"
rm -rf "$ROOT/dist-release" "$ROOT/$STAGE_NAME.tar.gz"
mkdir -p "$STAGE/bin" "$STAGE/extension"

echo ">> Compilando daemon (cargo build --release)"
cargo build --release --manifest-path "$ROOT/etherbit-tiling-daemon/Cargo.toml"
install -m 755 \
  "$ROOT/etherbit-tiling-daemon/target/release/etherbit-tiling-daemon" \
  "$STAGE/bin/etherbit-tiling-daemon"

echo ">> Compilando extensão (pnpm build)"
EXT="$ROOT/platform-linux-gnome/extension"
corepack enable
pnpm --dir "$EXT" install --frozen-lockfile
pnpm --dir "$EXT" build

install -m 644 "$EXT/dist/extension.js"     "$STAGE/extension/extension.js"
install -m 644 "$EXT/dist/main.js"          "$STAGE/extension/main.js"
install -m 644 "$EXT/metadata.json"         "$STAGE/extension/metadata.json"
# Opcionais, quando existirem.
[ -f "$EXT/dist/extension.js.map" ] && install -m 644 "$EXT/dist/extension.js.map" "$STAGE/extension/extension.js.map"
[ -f "$EXT/dist/main.js.map" ]      && install -m 644 "$EXT/dist/main.js.map"      "$STAGE/extension/main.js.map"
[ -f "$EXT/stylesheet.css" ]        && install -m 644 "$EXT/stylesheet.css"        "$STAGE/extension/stylesheet.css"
if [ -d "$EXT/schemas" ]; then
  mkdir -p "$STAGE/extension/schemas"
  install -m 644 "$EXT"/schemas/*.gschema.xml "$STAGE/extension/schemas/" 2>/dev/null || true
fi

echo ">> Adicionando installer, uninstaller e VERSION"
install -m 755 "$ROOT/packaging/install-gnome.sh"   "$STAGE/install-gnome.sh"
install -m 755 "$ROOT/packaging/uninstall-gnome.sh" "$STAGE/uninstall-gnome.sh"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"

echo ">> Empacotando $STAGE_NAME.tar.gz"
tar -czf "$ROOT/$STAGE_NAME.tar.gz" -C "$ROOT/dist-release" "$STAGE_NAME"

echo ">> Pronto: $ROOT/$STAGE_NAME.tar.gz (v$VERSION)"
tar -tzf "$ROOT/$STAGE_NAME.tar.gz"
