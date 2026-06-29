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

# Anti-obsolescência: instalar um main.js velho é uma armadilha (o script "carrega", mas roda código
# antigo). Se algum fonte for mais novo que o bundle, exige rebuild.
if [ -n "$(find "$HERE/contents/code" -name '*.ts' -newer "$HERE/contents/code/main.js" -print -quit 2>/dev/null)" ]; then
  echo "erro: contents/code/main.js está mais velho que os fontes .ts — rode 'pnpm build' antes" >&2
  echo "       (ou use 'pnpm run install:script', que reconstrói automaticamente)." >&2
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

# Linha de corte Qt6/Plasma6: só qdbus6/qdbus-qt6 (o `qdbus` puro pode ser o do Qt5, falando com o
# KWin errado num sistema misto). Ver ADR rules/0013.
QDBUS="$(command -v qdbus6 || command -v qdbus-qt6 || true)"
if [ -n "$QDBUS" ]; then
  "$QDBUS" org.kde.KWin /KWin reconfigure || true
else
  echo "aviso: qdbus6/qdbus-qt6 não encontrado — recarregue o KWin manualmente (requer Plasma 6/Qt 6)."
fi

# O KWin Script é só o CLIENTE; em DEV o daemon precisa rodar à parte. Avisa se ele não está no bus.
if command -v busctl >/dev/null; then
  if busctl --user status dev.ediano.etherbit.Tiling >/dev/null 2>&1; then
    echo ">> Daemon ATIVO no barramento de sessão."
  else
    echo "AVISO: o daemon NÃO está no barramento — o tiling ficará INERTE. Em dev, rode-o à parte:"
    echo "         RUST_LOG=debug cargo run --manifest-path etherbit-tiling-daemon/Cargo.toml"
    echo "       Ou instale o pacote completo (daemon + systemd --user): bash packaging/install-kde.sh"
  fi
fi

echo "Instalado e habilitado: $ID"
echo "Logs: journalctl -f QT_CATEGORY=kwin_scripting   (ligue a chave 'debug' p/ detalhe por evento)"
echo "Config: Configurações do Sistema → KWin Scripts → Etherbit Tiling (⚙)"
