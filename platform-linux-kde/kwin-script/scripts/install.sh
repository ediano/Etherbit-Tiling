#!/usr/bin/env bash
# install.sh — instala/atualiza o KWin Script localmente para desenvolvimento.
#
# Empacota a pasta KPackage (metadata.json + contents/) via kpackagetool6, habilita o
# script no kwinrc e pede ao KWin para recarregar — sem logout. Idempotente.
# Use via `pnpm run install:script`, que roda `vite build` antes (gera contents/code/main.js).
#
# Wayland: `qdbus ... reconfigure` recarrega os scripts do KWin no lugar do Alt+F2 r (só X11).
set -euo pipefail

ID="etherbit-tiling"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$HERE/contents/code/main.js" ]; then
  echo "erro: $HERE/contents/code/main.js ausente — rode 'pnpm build' antes." >&2
  exit 1
fi
if [ ! -f "$HERE/metadata.json" ]; then
  echo "erro: $HERE/metadata.json ausente." >&2
  exit 1
fi

command -v kpackagetool6 >/dev/null || {
  echo "erro: kpackagetool6 não encontrado (precisa de Plasma 6)." >&2
  exit 1
}

# Instala (ou atualiza, se já existir) o pacote no diretório local do usuário
# (~/.local/share/kwin/scripts/$ID/).
if kpackagetool6 --type=KWin/Script -s "$ID" >/dev/null 2>&1; then
  echo ">> Atualizando KWin Script $ID"
  kpackagetool6 --type=KWin/Script -u "$HERE"
else
  echo ">> Instalando KWin Script $ID"
  kpackagetool6 --type=KWin/Script -i "$HERE"
fi

# Habilita no kwinrc e recarrega o KWin.
if command -v kwriteconfig6 >/dev/null; then
  kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" true
fi

QDBUS="$(command -v qdbus6 || command -v qdbus-qt6 || command -v qdbus || true)"
if [ -n "$QDBUS" ]; then
  "$QDBUS" org.kde.KWin /KWin reconfigure || true
fi

echo "Instalado e habilitado: $ID"
echo "Logs: journalctl -f QT_CATEGORY=kwin_scripting"
echo "Config: Configurações do Sistema → KWin Scripts → Etherbit Tiling (⚙)"
