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
         "$STAGE/kwin-script/contents/config" "$STAGE/kwin-script/contents/ui" \
         "$STAGE/kwin-script/contents/locale/pt_BR/LC_MESSAGES" \
         "$STAGE/plasmoid/contents/ui" \
         "$STAGE/plasmoid/contents/locale/pt_BR/LC_MESSAGES"

# --- Daemon + helper de preview (workspace compartilhado) ----------------------
# O daemon é PURO geometria (sem framework visual, ADR 0029). A camada visual do preview do KDE vive
# num HELPER SEPARADO (`etherbit-tiling-preview`): um cliente wlr-layer-shell que desenha o retângulo
# TRANSLÚCIDO (alpha 0.3–0.4) — o KWin Script só faz `showOutline` (contorno opaco, fallback). GNOME e
# KDE compartilham o MESMO binário do daemon; o helper de preview é KDE-only (layer-shell).
echo ">> Compilando daemon + preview (cargo build --release)"
cargo build --release --manifest-path "$ROOT/etherbit-tiling-daemon/Cargo.toml"
install -m 755 \
  "$ROOT/etherbit-tiling-daemon/target/release/etherbit-tiling-daemon" \
  "$STAGE/bin/etherbit-tiling-daemon"
install -m 755 \
  "$ROOT/etherbit-tiling-daemon/target/release/etherbit-tiling-preview" \
  "$STAGE/bin/etherbit-tiling-preview"

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

# --- Tradução (gettext) da UI de config — ADR 0032 -----------------------------
# Strings-fonte em inglês (default global); catálogo pt_BR compilado para .mo e
# embarcado no pacote (contents/locale/). Sem msgfmt, segue só com o inglês.
if command -v msgfmt >/dev/null; then
  echo ">> Compilando catálogo pt-BR (msgfmt)"
  msgfmt "$KS/contents/po/pt_BR.po" \
    -o "$STAGE/kwin-script/contents/locale/pt_BR/LC_MESSAGES/etherbit-tiling.mo"
else
  echo "aviso: msgfmt ausente — pacote sem tradução pt-BR (UI ficará em inglês)."
fi

# --- System Tray Applet (Plasma/Applet, QML puro — ADR 0059) -------------------
# Sem build step: só copia o KPackage (metadata.json + contents/ui/*.qml) e compila o .mo pt-BR (o
# domínio DEVE ser plasma_applet_<id> para o i18n() do QML resolver). O applet dá acesso rápido na
# bandeja (toggles por monitor/workspace + abrir config), disparando as ações do KWin Script.
echo ">> Estagiando Plasma Applet"
PL="$ROOT/platform-linux-kde/plasmoid"
PL_ID="dev.ediano.etherbit.tiling"
install -m 644 "$PL/metadata.json"              "$STAGE/plasmoid/metadata.json"
install -m 644 "$PL/contents/ui/main.qml"       "$STAGE/plasmoid/contents/ui/main.qml"
install -m 644 "$PL/contents/ui/EtherbitDBus.qml" "$STAGE/plasmoid/contents/ui/EtherbitDBus.qml"
if command -v msgfmt >/dev/null; then
  msgfmt "$PL/contents/po/pt_BR.po" \
    -o "$STAGE/plasmoid/contents/locale/pt_BR/LC_MESSAGES/plasma_applet_${PL_ID}.mo"
fi

# --- Installer / uninstaller / VERSION -----------------------------------------
echo ">> Adicionando installer, uninstaller e VERSION"
install -m 755 "$ROOT/packaging/install-kde.sh"   "$STAGE/install-kde.sh"
install -m 755 "$ROOT/packaging/uninstall-kde.sh" "$STAGE/uninstall-kde.sh"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"

echo ">> Empacotando $STAGE_NAME.tar.gz"
tar -czf "$ROOT/$STAGE_NAME.tar.gz" -C "$ROOT/dist-release" "$STAGE_NAME"

echo ">> Pronto: $ROOT/$STAGE_NAME.tar.gz (v$VERSION)"
tar -tzf "$ROOT/$STAGE_NAME.tar.gz"
