#!/usr/bin/env bash
# install.sh — instala/atualiza o System Tray Applet (Plasma/Applet) localmente para desenvolvimento.
#
# Empacota a pasta KPackage (metadata.json + contents/) via kpackagetool6 e reinicia o plasmashell
# para recarregar o applet. É QML PURO — não há build step (diferente do KWin Script, que roda vite).
# Idempotente. O applet aparece na System Tray (categoria Status e Notificações); habilite a
# visibilidade em Config. da Bandeja do Sistema → Entradas, se necessário.
#
# ADR 0059. Para o applet FAZER algo, o KWin Script (que registra EtherbitToggle*) e o daemon precisam
# estar instalados/rodando — em dev, veja platform-linux-kde/kwin-script/scripts/install.sh.
set -euo pipefail

ID="dev.ediano.etherbit.tiling"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$HERE/metadata.json" ]; then
  echo "erro: $HERE/metadata.json ausente." >&2
  exit 1
fi
if [ ! -f "$HERE/contents/ui/main.qml" ]; then
  echo "erro: $HERE/contents/ui/main.qml ausente." >&2
  exit 1
fi

command -v kpackagetool6 >/dev/null || {
  echo "erro: kpackagetool6 não encontrado (precisa de Plasma 6)." >&2
  exit 1
}

# Recompila o catálogo pt-BR (ADR 0032) para o .mo embarcado no pacote, se houver msgfmt. O domínio do
# .mo DEVE casar com o id do applet (plasma_applet_<id>) para o i18n() do QML resolver.
if command -v msgfmt >/dev/null && [ -f "$HERE/contents/po/pt_BR.po" ]; then
  mkdir -p "$HERE/contents/locale/pt_BR/LC_MESSAGES"
  msgfmt "$HERE/contents/po/pt_BR.po" \
    -o "$HERE/contents/locale/pt_BR/LC_MESSAGES/plasma_applet_${ID}.mo" || true
fi

# Instala (ou atualiza, se já existir) o pacote no diretório local do usuário
# (~/.local/share/plasma/plasmoids/$ID/).
if kpackagetool6 --type=Plasma/Applet -s "$ID" >/dev/null 2>&1; then
  echo ">> Atualizando Plasma Applet $ID"
  kpackagetool6 --type=Plasma/Applet -u "$HERE"
else
  echo ">> Instalando Plasma Applet $ID"
  kpackagetool6 --type=Plasma/Applet -i "$HERE"
fi

# Recarrega o plasmashell para pegar o applet novo/atualizado (sem logout).
if command -v kquitapp6 >/dev/null && command -v kstart6 >/dev/null; then
  echo ">> Reiniciando plasmashell"
  kquitapp6 plasmashell >/dev/null 2>&1 || true
  kstart6 plasmashell >/dev/null 2>&1 &
elif command -v systemctl >/dev/null; then
  systemctl --user restart plasma-plasmashell.service 2>/dev/null || \
    echo "aviso: recarregue o plasmashell manualmente para ver o applet."
else
  echo "aviso: recarregue o plasmashell manualmente para ver o applet."
fi

echo "Instalado: $ID"
echo "Adicione à bandeja: Config. da Bandeja do Sistema → Entradas → Etherbit Tiling → Mostrar."
