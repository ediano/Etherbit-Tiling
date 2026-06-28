#!/usr/bin/env bash
# uninstall-gnome.sh — remove o Etherbit Tiling (daemon + extensão GNOME + serviço)
# do usuário atual. Reverte exatamente o que o install-gnome.sh fez.
#
# Idempotente — pode rodar várias vezes; ausências são toleradas. Roda no espaço
# do usuário (sem sudo). Não baixa nada: opera só sobre o que já está instalado.
#
# Por padrão PRESERVA a configuração do usuário. Para apagá-la também, defina
# ETHERBIT_PURGE=1 (env), já que `curl ... | bash` é não-interativo:
#   curl -sSL .../uninstall-gnome.sh | ETHERBIT_PURGE=1 bash
set -euo pipefail

UUID="tiling@etherbit.org"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="etherbit-tiling-daemon.service"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/etherbit-tiling"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/$UUID.desktop"

# --- Extensão (desabilitar antes de remover) -----------------------------------
if command -v gnome-extensions >/dev/null; then
  echo ">> Desabilitando extensão $UUID"
  gnome-extensions disable "$UUID" 2>/dev/null || true
fi

# --- Serviço systemd (--user) --------------------------------------------------
if command -v systemctl >/dev/null; then
  echo ">> Parando e desabilitando serviço $SERVICE"
  systemctl --user disable --now "$SERVICE" 2>/dev/null || true
fi

# --- Remoção de arquivos -------------------------------------------------------
echo ">> Removendo daemon, extensão e unit"
rm -f  "$BIN_DIR/etherbit-tiling-daemon"
rm -rf "$EXT_DIR"
rm -f  "$SYSTEMD_DIR/$SERVICE"

if command -v systemctl >/dev/null; then
  systemctl --user daemon-reload 2>/dev/null || true
fi

# --- Configuração do usuário (opcional) ----------------------------------------
if [ "${ETHERBIT_PURGE:-0}" = "1" ]; then
  echo ">> ETHERBIT_PURGE=1 — removendo configuração do usuário"
  rm -rf "$CONFIG_DIR"
  rm -f  "$AUTOSTART"
else
  echo ">> Configuração preservada ($CONFIG_DIR). Use ETHERBIT_PURGE=1 para remover."
fi

# --- Fim -----------------------------------------------------------------------
echo
echo "Desinstalação concluída."
echo "Wayland: faça logout/login para o GNOME Shell descarregar a extensão."
