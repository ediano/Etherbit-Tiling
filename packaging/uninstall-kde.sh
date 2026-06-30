#!/usr/bin/env bash
# uninstall-kde.sh — remove o Etherbit Tiling (daemon + KWin Script + serviço) do usuário (KDE).
# Reverte exatamente o que o install-kde.sh fez. Idempotente; ausências são toleradas.
#
# Por padrão PRESERVA a configuração do usuário (TOML do daemon + chaves no kwinrc). Para apagar
# também, defina ETHERBIT_PURGE=1:
#   curl -sSL .../uninstall-kde.sh | ETHERBIT_PURGE=1 bash
set -euo pipefail

# --- i18n (inline) -------------------------------------------------------------
# Distribuído isolado via `curl ... | bash`: i18n inline. Inglês default global;
# pt-BR só quando o locale for pt_BR (ADR 0032). Ref: packaging/i18n-reference.sh.
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
  pt_BR*|pt-BR*|pt_br*) ETB_LANG=pt ;;
  *)                    ETB_LANG=en ;;
esac
t() {
  local k="$1"; shift
  local en="" pt=""
  case "$k" in
    disabling_kwin)  en='>> Disabling KWin Script %s in kwinrc\n'
                     pt='>> Desabilitando KWin Script %s no kwinrc\n' ;;
    removing_kwin)   en='>> Removing KWin Script %s\n'
                     pt='>> Removendo KWin Script %s\n' ;;
    stopping_service) en='>> Stopping and disabling service %s\n'
                     pt='>> Parando e desabilitando serviço %s\n' ;;
    removing_files)  en='>> Removing daemon, preview helper and unit\n'
                     pt='>> Removendo daemon, helper de preview e unit\n' ;;
    purge_config)    en='>> ETHERBIT_PURGE=1 — removing user configuration\n'
                     pt='>> ETHERBIT_PURGE=1 — removendo configuração do usuário\n' ;;
    config_kept)     en='>> Configuration preserved (%s). Use ETHERBIT_PURGE=1 to remove it.\n'
                     pt='>> Configuração preservada (%s). Use ETHERBIT_PURGE=1 para remover.\n' ;;
    done_title)      en='\nUninstall complete.\n'
                     pt='\nDesinstalação concluída.\n' ;;
    done_note)       en='Note: if you also use the GNOME layer, the daemon is shared — reinstall it if needed.\n'
                     pt='Nota: se você também usa a camada GNOME, o daemon é compartilhado — reinstale-a se necessário.\n' ;;
  esac
  if [ "$ETB_LANG" = pt ] && [ -n "$pt" ]; then printf -- "$pt" "$@"; else printf -- "$en" "$@"; fi
}

ID="etherbit-tiling"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="etherbit-tiling-daemon.service"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/etherbit-tiling"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/etherbit.tiling@ediano.dev.desktop"

# --- KWin Script (desabilitar + remover) ---------------------------------------
if command -v kwriteconfig6 >/dev/null; then
  t disabling_kwin "$ID"
  kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" false || true
fi
if command -v kpackagetool6 >/dev/null; then
  t removing_kwin "$ID"
  kpackagetool6 --type=KWin/Script -r "$ID" 2>/dev/null || true
fi
QDBUS="$(command -v qdbus6 || command -v qdbus-qt6 || command -v qdbus || true)"
if [ -n "$QDBUS" ]; then
  "$QDBUS" org.kde.KWin /KWin reconfigure || true
fi

# --- Serviço systemd (--user) --------------------------------------------------
if command -v systemctl >/dev/null; then
  t stopping_service "$SERVICE"
  systemctl --user disable --now "$SERVICE" 2>/dev/null || true
fi

# --- Remoção de arquivos -------------------------------------------------------
t removing_files
rm -f "$BIN_DIR/etherbit-tiling-daemon"
rm -f "$SYSTEMD_DIR/$SERVICE"
# Helper de preview translúcido (KDE-only) + sua ativação D-Bus.
rm -f "$BIN_DIR/etherbit-tiling-preview"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services/dev.ediano.etherbit.Preview.service"

# Marcador de versão (estado da instalação; agnóstico de DE — daemon compartilhado).
rm -f "${XDG_STATE_HOME:-$HOME/.local/state}/etherbit-tiling/version"
rmdir "${XDG_STATE_HOME:-$HOME/.local/state}/etherbit-tiling" 2>/dev/null || true

if command -v systemctl >/dev/null; then
  systemctl --user daemon-reload 2>/dev/null || true
fi

# --- Configuração do usuário (opcional) ----------------------------------------
if [ "${ETHERBIT_PURGE:-0}" = "1" ]; then
  t purge_config
  rm -rf "$CONFIG_DIR"
  rm -f  "$AUTOSTART"
  if command -v kwriteconfig6 >/dev/null; then
    kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" --delete || true
  fi
else
  t config_kept "$CONFIG_DIR"
fi

# --- Fim -----------------------------------------------------------------------
t done_title
t done_note
