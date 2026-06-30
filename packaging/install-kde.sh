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

# --- i18n (inline) -------------------------------------------------------------
# Distribuído isolado via `curl ... | bash`: a i18n NÃO pode depender de arquivos
# vizinhos — fica inline. Inglês é o default global; pt-BR só quando o locale for
# pt_BR (ADR 0032). Catálogo de referência: packaging/i18n-reference.sh.
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
  pt_BR*|pt-BR*|pt_br*) ETB_LANG=pt ;;
  *)                    ETB_LANG=en ;;
esac
# t <chave> [args...] — imprime a string traduzida (printf-style). Fallback estrito ao inglês.
t() {
  local k="$1"; shift
  local en="" pt=""
  case "$k" in
    skip_de_check)   en='>> ETHERBIT_SKIP_DE_CHECK=1 — environment guard disabled.\n'
                     pt='>> ETHERBIT_SKIP_DE_CHECK=1 — trava de ambiente desativada.\n' ;;
    err_wrong_env)   en='error: this is the KDE installer, but the current environment looks like GNOME.\n       Use install-gnome.sh. To force: ETHERBIT_SKIP_DE_CHECK=1 bash <this-script>.\n'
                     pt='erro: este é o instalador do KDE, mas o ambiente atual parece ser o GNOME.\n       Use o install-gnome.sh. Para forçar: ETHERBIT_SKIP_DE_CHECK=1 bash <este-script>.\n' ;;
    warn_env_unknown) en="warning: could not confirm the environment is KDE/Plasma (XDG_CURRENT_DESKTOP='%s').\n"
                     pt="aviso: não foi possível confirmar que o ambiente é o KDE/Plasma (XDG_CURRENT_DESKTOP='%s').\n" ;;
    prompt_continue) en='Continue the KDE install anyway? [y/N] '
                     pt='Continuar a instalação do KDE mesmo assim? [s/N] ' ;;
    proceed_user)    en='>> Proceeding at the user request.\n'
                     pt='>> Prosseguindo a pedido do usuário.\n' ;;
    cancelled)       en='Installation cancelled.\n'
                     pt='Instalação cancelada.\n' ;;
    abort_noninteractive) en='       Non-interactive session — aborting for safety. To force: ETHERBIT_SKIP_DE_CHECK=1 bash <this-script>.\n'
                     pt='       Sessão não interativa — abortando por segurança. Para forçar: ETHERBIT_SKIP_DE_CHECK=1 bash <este-script>.\n' ;;
    payload_missing) en='>> Local payload missing; downloading release from %s\n'
                     pt='>> Payload local ausente; baixando release de %s\n' ;;
    err_need_tar)    en="error: 'tar' is required.\n"
                     pt="erro: 'tar' é necessário.\n" ;;
    err_need_curl_wget) en="error: install 'curl' or 'wget' to download the release.\n"
                     pt="erro: instale 'curl' ou 'wget' para baixar o release.\n" ;;
    install_clean)   en='>> Clean installation%s.\n'
                     pt='>> Instalação limpa%s.\n' ;;
    version_missing) en='>> VERSION missing in package — forced reinstall over v%s.\n'
                     pt='>> VERSION ausente no pacote — reinstalação forçada sobre v%s.\n' ;;
    same_version)    en='>> Same version (v%s) — reapplying files (idempotent).\n'
                     pt='>> Mesma versão (v%s) — reaplicando arquivos (idempotente).\n' ;;
    upgrading)       en='>> Upgrading v%s → v%s.\n'
                     pt='>> Atualizando v%s → v%s.\n' ;;
    downgrade_forced) en='>> ETHERBIT_FORCE=1 — downgrade v%s → v%s.\n'
                     pt='>> ETHERBIT_FORCE=1 — downgrade v%s → v%s.\n' ;;
    warn_older_pkg)  en='warning: the package (v%s) is older than the installed one (v%s); keeping the current one.\n       To force the downgrade: ETHERBIT_FORCE=1 bash <this-script>\n'
                     pt='aviso: o pacote (v%s) é mais antigo que o instalado (v%s); mantendo o atual.\n       Para forçar o downgrade: ETHERBIT_FORCE=1 bash <este-script>\n' ;;
    err_daemon_missing) en='error: %s/bin/etherbit-tiling-daemon missing.\n'
                     pt='erro: %s/bin/etherbit-tiling-daemon ausente.\n' ;;
    err_kwin_incomplete) en='error: KWin Script package incomplete in %s/kwin-script/.\n'
                     pt='erro: pacote do KWin Script incompleto em %s/kwin-script/.\n' ;;
    err_no_kpackagetool) en='error: kpackagetool6 not found (KDE Plasma 6 required).\n'
                     pt='erro: kpackagetool6 não encontrado (precisa de KDE Plasma 6).\n' ;;
    bin_install)     en='>> Installing daemon in %s\n'
                     pt='>> Instalando daemon em %s\n' ;;
    preview_install) en='>> Installing preview helper in %s\n'
                     pt='>> Instalando helper de preview em %s\n' ;;
    warn_no_preview) en='warning: bin/etherbit-tiling-preview missing — preview will fall back to the native outline (no alpha).\n'
                     pt='aviso: bin/etherbit-tiling-preview ausente — preview ficará só com o outline nativo (sem alpha).\n' ;;
    kwin_install)    en='>> Installing KWin Script %s\n'
                     pt='>> Instalando KWin Script %s\n' ;;
    warn_no_qdbus)   en='warning: qdbus6/qdbus-qt6 not found — reload KWin manually (requires Plasma 6/Qt 6).\n'
                     pt='aviso: qdbus6/qdbus-qt6 não encontrado — recarregue o KWin manualmente (requer Plasma 6/Qt 6).\n' ;;
    service_install) en='>> Installing systemd --user service (%s)\n'
                     pt='>> Instalando serviço systemd --user (%s)\n' ;;
    warn_no_start)   en='warning: could not start now (session without systemd --user?). It will start on next login.\n'
                     pt='aviso: não foi possível iniciar agora (sessão sem systemd --user?). Será iniciado no próximo login.\n' ;;
    warn_no_systemctl) en='warning: systemctl unavailable — service installed but not enabled.\n'
                     pt='aviso: systemctl indisponível — serviço instalado, mas não habilitado.\n' ;;
    ping_ok)         en='>> Daemon ACTIVE and responding (Ping ok).\n'
                     pt='>> Daemon ATIVO e respondendo (Ping ok).\n' ;;
    warn_ping_fail)  en='WARNING: the daemon did not respond to Ping — tiling may stay inert. Diagnose with:\n         systemctl --user status %s\n         journalctl --user -u %s -b 0\n'
                     pt='AVISO: o daemon não respondeu ao Ping — o tiling pode ficar inerte. Diagnostique com:\n         systemctl --user status %s\n         journalctl --user -u %s -b 0\n' ;;
    done_title)      en='\nInstallation complete.\n'
                     pt='\nInstalação concluída.\n' ;;
    done_daemon)     en='  • Daemon:      %s/etherbit-tiling-daemon\n'
                     pt='  • Daemon:      %s/etherbit-tiling-daemon\n' ;;
    done_preview)    en='  • Preview:     %s/etherbit-tiling-preview (translucent, D-Bus-activated on drag)\n'
                     pt='  • Preview:     %s/etherbit-tiling-preview (translúcido, ativado por D-Bus no drag)\n' ;;
    done_kwin)       en='  • KWin Script: %s (enabled in kwinrc)\n'
                     pt='  • KWin Script: %s (habilitado no kwinrc)\n' ;;
    done_service)    en='  • Service:     %s\n'
                     pt='  • Serviço:     %s\n' ;;
    done_config)     en='\nConfig: System Settings → KWin Scripts → Etherbit Tiling (⚙).\nIf tiling does not start, check in KWin Scripts that it is enabled.\n'
                     pt='\nConfig: Configurações do Sistema → KWin Scripts → Etherbit Tiling (⚙).\nSe o tiling não iniciar, verifique em KWin Scripts se está habilitado.\n' ;;
  esac
  if [ "$ETB_LANG" = pt ] && [ -n "$pt" ]; then printf -- "$pt" "$@"; else printf -- "$en" "$@"; fi
}

# --- Trava de ambiente gráfico (fail-safe) -------------------------------------
# Impede execução cruzada: rodar o instalador do KDE sob GNOME (ou vice-versa)
# embaralharia configs/serviços de DEs distintos. Detecção via sinais freedesktop
# ($XDG_CURRENT_DESKTOP pode ser lista separada por ':', ex. "ubuntu:GNOME").
#   - KDE/Plasma detectado   → segue.
#   - GNOME detectado         → erro + exit 1 (a trava principal).
#   - Ambiente indeterminado  → pergunta [s/N] (padrão: parar); sem TTY, aborta.
# Bypass total: ETHERBIT_SKIP_DE_CHECK=1.
guard_desktop() {
  if [ "${ETHERBIT_SKIP_DE_CHECK:-0}" = "1" ]; then
    t skip_de_check
    return 0
  fi
  local signals
  signals="$(printf '%s:%s:%s' \
    "${XDG_CURRENT_DESKTOP:-}" "${XDG_SESSION_DESKTOP:-}" "${DESKTOP_SESSION:-}" \
    | tr '[:upper:]' '[:lower:]')"
  case "$signals" in
    *kde*|*plasma*) return 0 ;;  # KDE/Plasma detectado — segue.
  esac
  case "$signals" in
    *gnome*)
      t err_wrong_env >&2
      exit 1
      ;;
  esac
  t warn_env_unknown "${XDG_CURRENT_DESKTOP:-}" >&2
  if [ -t 0 ]; then
    t prompt_continue >&2
    local resp=""
    read -r resp || resp=""
    case "$resp" in
      [sSyY]*) t proceed_user; return 0 ;;
      *) t cancelled >&2; exit 1 ;;
    esac
  fi
  t abort_noninteractive >&2
  exit 1
}
guard_desktop

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
  t payload_missing "$REPO"
  command -v tar >/dev/null || { t err_need_tar >&2; exit 1; }
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if command -v curl >/dev/null; then
    curl -fsSL "$ASSET_URL" -o "$TMP/$TARBALL"
  elif command -v wget >/dev/null; then
    wget -qO "$TMP/$TARBALL" "$ASSET_URL"
  else
    t err_need_curl_wget >&2
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
  t err_daemon_missing "$HERE" >&2
  exit 1
fi
if [ ! -f "$HERE/kwin-script/metadata.json" ] || [ ! -f "$HERE/kwin-script/contents/code/main.js" ]; then
  t err_kwin_incomplete "$HERE" >&2
  exit 1
fi
command -v kpackagetool6 >/dev/null || {
  t err_no_kpackagetool >&2
  exit 1
}

# --- Detecção de versão e upgrade idempotente ----------------------------------
# Fonte de verdade da versão = arquivo VERSION do tarball (semver do semantic-release). O daemon
# (etherbit-tiling-daemon) NÃO tem `--version`; comparamos contra um marcador persistido na
# instalação anterior. Decisão ANTES de copiar/registrar (passo 1 do upgrade).
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/etherbit-tiling"
VERSION_FILE="$STATE_DIR/version"
NEW_VERSION="$([ -f "$HERE/VERSION" ] && tr -d '[:space:]' < "$HERE/VERSION" || true)"
OLD_VERSION="$([ -f "$VERSION_FILE" ] && tr -d '[:space:]' < "$VERSION_FILE" || true)"

# version_gt A B → 0 (true) se A > B em ordem de versão (sort -V, coreutils).
version_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]; }

if [ -z "$OLD_VERSION" ]; then
  t install_clean "${NEW_VERSION:+ (v$NEW_VERSION)}"
elif [ -z "$NEW_VERSION" ]; then
  t version_missing "$OLD_VERSION"
elif [ "$NEW_VERSION" = "$OLD_VERSION" ]; then
  t same_version "$OLD_VERSION"
elif version_gt "$NEW_VERSION" "$OLD_VERSION"; then
  t upgrading "$OLD_VERSION" "$NEW_VERSION"
elif [ "${ETHERBIT_FORCE:-0}" = "1" ]; then
  t downgrade_forced "$OLD_VERSION" "$NEW_VERSION"
else
  t warn_older_pkg "$NEW_VERSION" "$OLD_VERSION" >&2
  exit 0
fi

# Parada segura ANTES da sobrescrita: o `enable --now` adiante NÃO reinicia um serviço já ativo
# (`start` é no-op num unit ativo). Sem parar aqui, o `install` troca os bytes em disco mas o daemon
# ANTIGO segue em memória — binário novo no disco, código velho rodando — até um logout/restart. A
# sequência parar → sobrescrever → start garante que o daemon NOVO assuma. No-op inofensivo na
# instalação limpa (unit ainda ausente).
if command -v systemctl >/dev/null; then
  systemctl --user stop "$SERVICE" 2>/dev/null || true
fi

# --- Daemon (reuso; mesmo binário/serviço da camada GNOME) ---------------------
t bin_install "$BIN_DIR"
mkdir -p "$BIN_DIR"
install -m 755 "$HERE/bin/etherbit-tiling-daemon" "$BIN_DIR/etherbit-tiling-daemon"

# --- Helper de preview translúcido (KDE-only, ativado por D-Bus) ----------------
# Cliente wlr-layer-shell que desenha o retângulo TRANSLÚCIDO do preview (alpha 0.3–0.4). É opcional:
# se ausente no payload (build antigo) ou se o overlay não subir, o KWin Script cai no `showOutline`
# nativo (contorno opaco) — o tiling não depende dele. Lazy-start por ATIVAÇÃO D-Bus: o primeiro
# `ShowPreview` (no drag) sobe o helper; ele fica vivo e ocioso fora do arrasto.
if [ -f "$HERE/bin/etherbit-tiling-preview" ]; then
  t preview_install "$BIN_DIR"
  install -m 755 "$HERE/bin/etherbit-tiling-preview" "$BIN_DIR/etherbit-tiling-preview"
  DBUS_SERVICES_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services"
  mkdir -p "$DBUS_SERVICES_DIR"
  cat > "$DBUS_SERVICES_DIR/dev.ediano.etherbit.Preview.service" <<PREVIEW
[D-BUS Service]
Name=dev.ediano.etherbit.Preview
Exec=${BIN_DIR}/etherbit-tiling-preview
PREVIEW
else
  t warn_no_preview
fi

# --- KWin Script ---------------------------------------------------------------
t kwin_install "$ID"
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
  t warn_no_qdbus
fi

# --- Serviço systemd (--user) --------------------------------------------------
t service_install "$SERVICE"
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
    t warn_no_start
else
  t warn_no_systemctl
fi

# Health-check: o KWin Script é só o CLIENTE; sem o daemon respondendo, o tiling fica INERTE. Confirma
# que o daemon detém o nome e responde ao Ping (a chamada também dispara a ativação D-Bus, se preciso).
if command -v busctl >/dev/null; then
  if busctl --user call dev.ediano.etherbit.Tiling /dev/ediano/etherbit/Tiling \
       dev.ediano.etherbit.Tiling Ping >/dev/null 2>&1; then
    t ping_ok
  else
    t warn_ping_fail "$SERVICE" "$SERVICE"
  fi
fi

# --- Marcador de versão --------------------------------------------------------
# Registra a versão instalada — base de comparação do próximo run (upgrade idempotente).
if [ -n "$NEW_VERSION" ]; then
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$NEW_VERSION" > "$VERSION_FILE"
fi

# --- Fim -----------------------------------------------------------------------
t done_title
t done_daemon "$BIN_DIR"
if [ -f "$BIN_DIR/etherbit-tiling-preview" ]; then
  t done_preview "$BIN_DIR"
fi
t done_kwin "$ID"
t done_service "$SYSTEMD_DIR/$SERVICE"
t done_config
