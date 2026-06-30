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
    disabling_ext)   en='>> Disabling extension %s\n'
                     pt='>> Desabilitando extensão %s\n' ;;
    stopping_service) en='>> Stopping and disabling service %s\n'
                     pt='>> Parando e desabilitando serviço %s\n' ;;
    removing_files)  en='>> Removing daemon, extension and unit\n'
                     pt='>> Removendo daemon, extensão e unit\n' ;;
    purge_config)    en='>> ETHERBIT_PURGE=1 — removing user configuration\n'
                     pt='>> ETHERBIT_PURGE=1 — removendo configuração do usuário\n' ;;
    config_kept)     en='>> Configuration preserved (%s). Use ETHERBIT_PURGE=1 to remove it.\n'
                     pt='>> Configuração preservada (%s). Use ETHERBIT_PURGE=1 para remover.\n' ;;
    done_title)      en='\nUninstall complete.\n'
                     pt='\nDesinstalação concluída.\n' ;;
    done_wayland)    en='Wayland: log out/in for GNOME Shell to unload the extension.\n'
                     pt='Wayland: faça logout/login para o GNOME Shell descarregar a extensão.\n' ;;
  esac
  if [ "$ETB_LANG" = pt ] && [ -n "$pt" ]; then printf -- "$pt" "$@"; else printf -- "$en" "$@"; fi
}

UUID="etherbit.tiling@ediano.dev"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="etherbit-tiling-daemon.service"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/etherbit-tiling"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/$UUID.desktop"

# --- Extensão (desabilitar antes de remover) -----------------------------------
if command -v gnome-extensions >/dev/null; then
  t disabling_ext "$UUID"
  gnome-extensions disable "$UUID" 2>/dev/null || true
fi

# --- Serviço systemd (--user) --------------------------------------------------
if command -v systemctl >/dev/null; then
  t stopping_service "$SERVICE"
  systemctl --user disable --now "$SERVICE" 2>/dev/null || true
fi

# --- Remoção de arquivos -------------------------------------------------------
t removing_files
rm -f  "$BIN_DIR/etherbit-tiling-daemon"
rm -rf "$EXT_DIR"
rm -f  "$SYSTEMD_DIR/$SERVICE"

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
else
  t config_kept "$CONFIG_DIR"
fi

# --- Fim -----------------------------------------------------------------------
t done_title
t done_wayland
