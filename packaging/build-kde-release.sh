#!/usr/bin/env bash
# build-kde-release.sh — compila e empacota o release de produção do Linux/KDE (Wayland).
#
# Gera `etherbit-tiling-kde.tar.gz` na raiz do repo contendo APENAS os artefatos de
# produção: o binário do daemon (REUSADO de etherbit-tiling-daemon — é agnóstico de DE) +
# a pasta KPackage do KWin Script + installer/uninstaller, sem código-fonte (.rs/.ts).
#
#   bash packaging/build-kde-release.sh <versao>
set -euo pipefail

VERSION="${1:?uso: build-kde-release.sh <versao>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_NAME="etherbit-tiling-kde"
STAGE="$ROOT/dist-release/$STAGE_NAME"

echo ">> Limpando staging"
rm -rf "$ROOT/dist-release" "$ROOT/$STAGE_NAME.tar.gz"
mkdir -p "$STAGE/bin" "$STAGE/kwin-script/contents/code" \
         "$STAGE/kwin-script/contents/config" "$STAGE/kwin-script/contents/ui"

# --- Daemon (reuso do workspace compartilhado) ---------------------------------
# O daemon é PURO geometria (sem framework visual): o HUD de preview do KDE é o `workspace.showOutline`
# NATIVO do KWin, desenhado pela ponte — ver ADR 0029. GNOME e KDE compartilham o MESMO binário do
# daemon (não há mais feature por DE).
echo ">> Compilando daemon (cargo build --release)"
cargo build --release --manifest-path "$ROOT/etherbit-tiling-daemon/Cargo.toml"
install -m 755 \
  "$ROOT/etherbit-tiling-daemon/target/release/etherbit-tiling-daemon" \
  "$STAGE/bin/etherbit-tiling-daemon"

# --- KWin Script (build do bundle IIFE) ----------------------------------------
echo ">> Compilando KWin Script (pnpm build)"
KS="$ROOT/platform-linux-kde/kwin-script"
corepack enable
pnpm --dir "$KS" install --frozen-lockfile
pnpm --dir "$KS" build

# Stage da pasta KPackage com APENAS o necessário (sem .ts/.test.ts/node_modules).
install -m 644 "$KS/metadata.json"                "$STAGE/kwin-script/metadata.json"
install -m 644 "$KS/contents/code/main.js"        "$STAGE/kwin-script/contents/code/main.js"
install -m 644 "$KS/contents/config/main.xml"     "$STAGE/kwin-script/contents/config/main.xml"
install -m 644 "$KS/contents/ui/config.ui"        "$STAGE/kwin-script/contents/ui/config.ui"

# --- Installer / uninstaller / VERSION -----------------------------------------
echo ">> Adicionando installer, uninstaller e VERSION"
install -m 755 "$ROOT/packaging/install-kde.sh"   "$STAGE/install-kde.sh"
install -m 755 "$ROOT/packaging/uninstall-kde.sh" "$STAGE/uninstall-kde.sh"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"

echo ">> Empacotando $STAGE_NAME.tar.gz"
tar -czf "$ROOT/$STAGE_NAME.tar.gz" -C "$ROOT/dist-release" "$STAGE_NAME"

echo ">> Pronto: $ROOT/$STAGE_NAME.tar.gz (v$VERSION)"
tar -tzf "$ROOT/$STAGE_NAME.tar.gz"
