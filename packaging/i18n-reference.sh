#!/usr/bin/env bash
# i18n-reference.sh — CATÁLOGO DE REFERÊNCIA (NÃO É DISTRIBUÍDO, NÃO É EXECUTADO).
#
# Os instaladores (install-*.sh / uninstall-*.sh) são entregues ISOLADOS via
# `curl ... | bash`, então a função `t()` e o catálogo vivem INLINE em cada script
# (não dá para `source` um arquivo vizinho). Este arquivo existe só para humanos
# manterem as 4 cópias em sincronia: a fonte de verdade são os scripts. Ao mudar
# uma string, atualize-a em todos os scripts que usam a chave e reflita aqui.
#
# Convenções (ADR 0032):
#   • Inglês é o DEFAULT GLOBAL; pt-BR só quando o locale do sistema for pt_BR.
#   • Strings são printf-style: `%s` são interpolados; `\n` faz parte da mensagem.
#   • Mensagens de erro/aviso vão para stderr no call site (`t chave ... >&2`).
#
# Detecção de idioma (idêntica em todos os scripts):
#   case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
#     pt_BR*|pt-BR*|pt_br*) ETB_LANG=pt ;;
#     *)                    ETB_LANG=en ;;
#   esac
#
# ── Chaves por script ─────────────────────────────────────────────────────────
#
# COMPARTILHADAS (install-gnome.sh + install-kde.sh):
#   skip_de_check, err_wrong_env*, warn_env_unknown*, prompt_continue*,
#   proceed_user, cancelled, abort_noninteractive, payload_missing, err_need_tar,
#   err_need_curl_wget, install_clean, version_missing, same_version, upgrading,
#   downgrade_forced, warn_older_pkg, err_daemon_missing, bin_install,
#   service_install, warn_no_start, warn_no_systemctl, done_title, done_daemon,
#   done_service
#   (* = texto difere entre GNOME e KDE — "GNOME"/"KDE", install-kde.sh/install-gnome.sh)
#
# SÓ install-gnome.sh:
#   err_ext_incomplete, ext_install, enabling_ext, warn_enable_failed, done_ext,
#   done_wayland
#
# SÓ install-kde.sh:
#   err_kwin_incomplete, err_no_kpackagetool, preview_install, warn_no_preview,
#   kwin_install, applet_install, warn_no_applet, warn_no_qdbus, ping_ok, warn_ping_fail,
#   done_preview, done_kwin, done_applet, done_config
#
# COMPARTILHADAS (uninstall-gnome.sh + uninstall-kde.sh):
#   stopping_service, removing_files (texto difere), purge_config, config_kept,
#   done_title
#
# SÓ uninstall-gnome.sh:
#   disabling_ext, done_wayland
#
# SÓ uninstall-kde.sh:
#   disabling_kwin, removing_kwin, done_note
#
# Para inspecionar o catálogo real de um script:
#   sed -n '/^t() {/,/^}/p' packaging/install-gnome.sh
