#!/usr/bin/env bash
# uninstall-kde.sh — remove o Etherbit Tiling (daemon + KWin Script + serviço) do usuário (KDE).
# Reverte exatamente o que o install-kde.sh fez. Idempotente; ausências são toleradas.
#
# Por padrão PRESERVA a configuração do usuário (TOML do daemon + chaves no kwinrc). Para apagar
# também, defina ETHERBIT_PURGE=1:
#   curl -sSL .../uninstall-kde.sh | ETHERBIT_PURGE=1 bash
set -euo pipefail

ID="etherbit-tiling"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="etherbit-tiling-daemon.service"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/etherbit-tiling"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/etherbit.tiling@ediano.dev.desktop"

# --- KWin Script (desabilitar + remover) ---------------------------------------
if command -v kwriteconfig6 >/dev/null; then
  echo ">> Desabilitando KWin Script $ID no kwinrc"
  kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" false || true
fi
if command -v kpackagetool6 >/dev/null; then
  echo ">> Removendo KWin Script $ID"
  kpackagetool6 --type=KWin/Script -r "$ID" 2>/dev/null || true
fi
QDBUS="$(command -v qdbus6 || command -v qdbus-qt6 || command -v qdbus || true)"
if [ -n "$QDBUS" ]; then
  "$QDBUS" org.kde.KWin /KWin reconfigure || true
fi

# --- Serviço systemd (--user) --------------------------------------------------
if command -v systemctl >/dev/null; then
  echo ">> Parando e desabilitando serviço $SERVICE"
  systemctl --user disable --now "$SERVICE" 2>/dev/null || true
fi

# --- Remoção de arquivos -------------------------------------------------------
echo ">> Removendo daemon e unit"
rm -f "$BIN_DIR/etherbit-tiling-daemon"
rm -f "$SYSTEMD_DIR/$SERVICE"

if command -v systemctl >/dev/null; then
  systemctl --user daemon-reload 2>/dev/null || true
fi

# --- Configuração do usuário (opcional) ----------------------------------------
if [ "${ETHERBIT_PURGE:-0}" = "1" ]; then
  echo ">> ETHERBIT_PURGE=1 — removendo configuração do usuário"
  rm -rf "$CONFIG_DIR"
  rm -f  "$AUTOSTART"
  if command -v kwriteconfig6 >/dev/null; then
    kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" --delete || true
  fi
else
  echo ">> Configuração preservada ($CONFIG_DIR). Use ETHERBIT_PURGE=1 para remover."
fi

# --- Fim -----------------------------------------------------------------------
echo
echo "Desinstalação concluída."
echo "Nota: se você também usa a camada GNOME, o daemon é compartilhado — reinstale-a se necessário."
