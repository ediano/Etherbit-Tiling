#!/usr/bin/env bash
# install-kde.sh — instala o Etherbit Tiling (daemon + KWin Script) no usuário atual (KDE/Wayland).
#
# Faz parte do pacote etherbit-tiling-kde.tar.gz. Estrutura esperada ao lado deste script:
#   bin/etherbit-tiling-daemon
#   kwin-script/{metadata.json, contents/...}
#
# Idempotente — pode rodar várias vezes. Instala tudo no espaço do usuário (sem sudo).
# O daemon é o MESMO da camada GNOME (agnóstico de DE); se já estiver instalado, é só atualizado.
set -euo pipefail

ID="etherbit-tiling"
REPO="${ETHERBIT_RELEASE_REPO:-ediano/etherbit-tiling-releases}"
TARBALL="etherbit-tiling-kde.tar.gz"
ASSET_URL="https://github.com/$REPO/releases/latest/download/$TARBALL"

# Diretório deste script. Via `curl ... | bash`, BASH_SOURCE fica vazio.
SOURCE="${BASH_SOURCE[0]:-}"
if [ -n "$SOURCE" ]; then
  HERE="$(cd "$(dirname "$SOURCE")" && pwd)"
else
  HERE=""
fi

# Bootstrap: se o payload não está ao lado do script (caso do `curl | bash`), baixa o tarball.
if [ -z "$HERE" ] || [ ! -f "$HERE/bin/etherbit-tiling-daemon" ]; then
  echo ">> Payload local ausente; baixando release de $REPO"
  command -v tar >/dev/null || { echo "erro: 'tar' é necessário." >&2; exit 1; }
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if command -v curl >/dev/null; then
    curl -fsSL "$ASSET_URL" -o "$TMP/$TARBALL"
  elif command -v wget >/dev/null; then
    wget -qO "$TMP/$TARBALL" "$ASSET_URL"
  else
    echo "erro: instale 'curl' ou 'wget' para baixar o release." >&2
    exit 1
  fi
  tar -xzf "$TMP/$TARBALL" -C "$TMP"
  HERE="$TMP/etherbit-tiling-kde"
fi

BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="etherbit-tiling-daemon.service"

# --- Validação -----------------------------------------------------------------
if [ ! -f "$HERE/bin/etherbit-tiling-daemon" ]; then
  echo "erro: $HERE/bin/etherbit-tiling-daemon ausente." >&2
  exit 1
fi
if [ ! -f "$HERE/kwin-script/metadata.json" ] || [ ! -f "$HERE/kwin-script/contents/code/main.js" ]; then
  echo "erro: pacote do KWin Script incompleto em $HERE/kwin-script/." >&2
  exit 1
fi
command -v kpackagetool6 >/dev/null || {
  echo "erro: kpackagetool6 não encontrado (precisa de KDE Plasma 6)." >&2
  exit 1
}

# --- Daemon (reuso; mesmo binário/serviço da camada GNOME) ---------------------
echo ">> Instalando daemon em $BIN_DIR"
mkdir -p "$BIN_DIR"
install -m 755 "$HERE/bin/etherbit-tiling-daemon" "$BIN_DIR/etherbit-tiling-daemon"

# --- KWin Script ---------------------------------------------------------------
echo ">> Instalando KWin Script $ID"
if kpackagetool6 --type=KWin/Script -s "$ID" >/dev/null 2>&1; then
  kpackagetool6 --type=KWin/Script -u "$HERE/kwin-script"
else
  kpackagetool6 --type=KWin/Script -i "$HERE/kwin-script"
fi

if command -v kwriteconfig6 >/dev/null; then
  kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" true
fi

# Linha de corte Qt6/Plasma6: só qdbus6/qdbus-qt6 (o `qdbus` puro pode ser o do Qt5). Ver ADR 0013.
QDBUS="$(command -v qdbus6 || command -v qdbus-qt6 || true)"
if [ -n "$QDBUS" ]; then
  "$QDBUS" org.kde.KWin /KWin reconfigure || true
else
  echo "aviso: qdbus6/qdbus-qt6 não encontrado — recarregue o KWin manualmente (requer Plasma 6/Qt 6)."
fi

# --- Serviço systemd (--user) --------------------------------------------------
echo ">> Instalando serviço systemd --user ($SERVICE)"
mkdir -p "$SYSTEMD_DIR"
# `ExecStart` usa o $BIN_DIR REAL (não o hardcode %h/.local/bin): respeita XDG_BIN_HOME e evita um
# serviço que aponta para um binário inexistente — daemon que não sobe = tiling inerte.
cat > "$SYSTEMD_DIR/$SERVICE" <<UNIT
[Unit]
Description=Etherbit Tiling Daemon
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=${BIN_DIR}/etherbit-tiling-daemon
Restart=on-failure
RestartSec=2

[Install]
WantedBy=graphical-session.target
UNIT

if command -v systemctl >/dev/null; then
  systemctl --user daemon-reload || true
  systemctl --user enable --now "$SERVICE" || \
    echo "aviso: não foi possível iniciar agora (sessão sem systemd --user?). Será iniciado no próximo login."
else
  echo "aviso: systemctl indisponível — serviço instalado, mas não habilitado."
fi

# Health-check: o KWin Script é só o CLIENTE; sem o daemon respondendo, o tiling fica INERTE. Confirma
# que o daemon detém o nome e responde ao Ping (a chamada também dispara a ativação D-Bus, se preciso).
if command -v busctl >/dev/null; then
  if busctl --user call dev.ediano.etherbit.Tiling /dev/ediano/etherbit/Tiling \
       dev.ediano.etherbit.Tiling Ping >/dev/null 2>&1; then
    echo ">> Daemon ATIVO e respondendo (Ping ok)."
  else
    echo "AVISO: o daemon não respondeu ao Ping — o tiling pode ficar inerte. Diagnostique com:"
    echo "         systemctl --user status $SERVICE"
    echo "         journalctl --user -u $SERVICE -b 0"
  fi
fi

# --- Fim -----------------------------------------------------------------------
echo
echo "Instalação concluída."
echo "  • Daemon:      $BIN_DIR/etherbit-tiling-daemon"
echo "  • KWin Script: $ID (habilitado no kwinrc)"
echo "  • Serviço:     $SYSTEMD_DIR/$SERVICE"
echo
echo "Config: Configurações do Sistema → KWin Scripts → Etherbit Tiling (⚙)."
echo "Se o tiling não iniciar, verifique em KWin Scripts se está habilitado."
