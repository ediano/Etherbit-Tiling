#!/usr/bin/env bash
# install.sh — instala o Etherbit Tiling (daemon + extensão GNOME) no usuário atual.
#
# Faz parte do pacote etherbit-tiling-linux.tar.gz. Estrutura esperada ao lado
# deste script:
#   bin/etherbit-tiling-daemon
#   extension/{extension.js, metadata.json, [extension.js.map], [stylesheet.css], [schemas/]}
#
# Idempotente — pode rodar várias vezes. Instala tudo no espaço do usuário
# (sem sudo). Wayland: o GNOME Shell só recarrega extensões após logout/login.
set -euo pipefail

UUID="tiling@etherbit.org"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="etherbit-tiling-daemon.service"

# --- Validação -----------------------------------------------------------------
if [ ! -f "$HERE/bin/etherbit-tiling-daemon" ]; then
  echo "erro: $HERE/bin/etherbit-tiling-daemon ausente." >&2
  exit 1
fi
if [ ! -f "$HERE/extension/extension.js" ] || [ ! -f "$HERE/extension/metadata.json" ]; then
  echo "erro: bundle da extensão incompleto em $HERE/extension/." >&2
  exit 1
fi

# --- Daemon --------------------------------------------------------------------
echo ">> Instalando daemon em $BIN_DIR"
mkdir -p "$BIN_DIR"
install -m 755 "$HERE/bin/etherbit-tiling-daemon" "$BIN_DIR/etherbit-tiling-daemon"

# --- Extensão ------------------------------------------------------------------
echo ">> Instalando extensão em $EXT_DIR"
mkdir -p "$EXT_DIR"
install -m 644 "$HERE/extension/extension.js"  "$EXT_DIR/extension.js"
install -m 644 "$HERE/extension/metadata.json" "$EXT_DIR/metadata.json"
[ -f "$HERE/extension/extension.js.map" ] && install -m 644 "$HERE/extension/extension.js.map" "$EXT_DIR/extension.js.map"
[ -f "$HERE/extension/stylesheet.css" ]   && install -m 644 "$HERE/extension/stylesheet.css"   "$EXT_DIR/stylesheet.css"
if [ -d "$HERE/extension/schemas" ]; then
  mkdir -p "$EXT_DIR/schemas"
  install -m 644 "$HERE"/extension/schemas/*.gschema.xml "$EXT_DIR/schemas/" 2>/dev/null || true
  command -v glib-compile-schemas >/dev/null && glib-compile-schemas "$EXT_DIR/schemas"
fi

# --- Serviço systemd (--user) --------------------------------------------------
echo ">> Instalando serviço systemd --user ($SERVICE)"
mkdir -p "$SYSTEMD_DIR"
cat > "$SYSTEMD_DIR/$SERVICE" <<'UNIT'
[Unit]
Description=Etherbit Tiling Daemon
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=%h/.local/bin/etherbit-tiling-daemon
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

# --- Fim -----------------------------------------------------------------------
echo
echo "Instalação concluída."
echo "  • Daemon:    $BIN_DIR/etherbit-tiling-daemon"
echo "  • Extensão:  $EXT_DIR"
echo "  • Serviço:   $SYSTEMD_DIR/$SERVICE"
echo
echo "Wayland: faça logout/login para o GNOME Shell carregar a extensão."
echo "Depois habilite o motor: gnome-extensions enable $UUID"
