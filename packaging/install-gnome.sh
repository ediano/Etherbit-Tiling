#!/usr/bin/env bash
# install-gnome.sh — instala o Etherbit Tiling (daemon + extensão GNOME) no usuário atual.
#
# Faz parte do pacote etherbit-tiling-gnome.tar.gz. Estrutura esperada ao lado
# deste script:
#   bin/etherbit-tiling-daemon
#   extension/{extension.js, metadata.json, [extension.js.map], [stylesheet.css], [schemas/]}
#
# Idempotente — pode rodar várias vezes. Instala tudo no espaço do usuário
# (sem sudo). Wayland: o GNOME Shell só recarrega extensões após logout/login.
set -euo pipefail

# --- i18n (inline) -------------------------------------------------------------
# Distribuído isolado via `curl ... | bash`: a i18n NÃO pode depender de arquivos
# vizinhos — fica inline. Inglês é o default global; pt-BR só quando o locale for
# pt_BR (ADR 0032). Catálogo de referência: packaging/i18n-reference.sh.
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
  pt_BR*|pt-BR*|pt_br*) ETB_LANG=pt ;;
  *)                    ETB_LANG=en ;;
esac
# t <chave> [args...] — imprime a string traduzida (printf-style, sem newline
# automático: o `\n` faz parte de cada mensagem). Fallback estrito ao inglês.
t() {
  local k="$1"; shift
  local en="" pt=""
  case "$k" in
    skip_de_check)   en='>> ETHERBIT_SKIP_DE_CHECK=1 — environment guard disabled.\n'
                     pt='>> ETHERBIT_SKIP_DE_CHECK=1 — trava de ambiente desativada.\n' ;;
    err_wrong_env)   en='error: this is the GNOME installer, but the current environment looks like KDE/Plasma.\n       Use install-kde.sh. To force: ETHERBIT_SKIP_DE_CHECK=1 bash <this-script>.\n'
                     pt='erro: este é o instalador do GNOME, mas o ambiente atual parece ser KDE/Plasma.\n       Use o install-kde.sh. Para forçar: ETHERBIT_SKIP_DE_CHECK=1 bash <este-script>.\n' ;;
    warn_env_unknown) en="warning: could not confirm the environment is GNOME (XDG_CURRENT_DESKTOP='%s').\n"
                     pt="aviso: não foi possível confirmar que o ambiente é o GNOME (XDG_CURRENT_DESKTOP='%s').\n" ;;
    prompt_continue) en='Continue the GNOME install anyway? [y/N] '
                     pt='Continuar a instalação do GNOME mesmo assim? [s/N] ' ;;
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
    bin_install)     en='>> Installing daemon in %s\n'
                     pt='>> Instalando daemon em %s\n' ;;
    err_daemon_missing) en='error: %s/bin/etherbit-tiling-daemon missing.\n'
                     pt='erro: %s/bin/etherbit-tiling-daemon ausente.\n' ;;
    err_ext_incomplete) en='error: extension bundle incomplete in %s/extension/.\n'
                     pt='erro: bundle da extensão incompleto em %s/extension/.\n' ;;
    ext_install)     en='>> Installing extension in %s\n'
                     pt='>> Instalando extensão em %s\n' ;;
    service_install) en='>> Installing systemd --user service (%s)\n'
                     pt='>> Instalando serviço systemd --user (%s)\n' ;;
    warn_no_start)   en='warning: could not start now (session without systemd --user?). It will start on next login.\n'
                     pt='aviso: não foi possível iniciar agora (sessão sem systemd --user?). Será iniciado no próximo login.\n' ;;
    warn_no_systemctl) en='warning: systemctl unavailable — service installed but not enabled.\n'
                     pt='aviso: systemctl indisponível — serviço instalado, mas não habilitado.\n' ;;
    enabling_ext)    en='>> Enabling the extension in the user profile (%s)\n'
                     pt='>> Habilitando a extensão no perfil do usuário (%s)\n' ;;
    warn_enable_failed) en="warning: could not enable now; enable it with 'gnome-extensions enable %s'.\n"
                     pt="aviso: não foi possível habilitar agora; habilite com 'gnome-extensions enable %s'.\n" ;;
    done_title)      en='\nInstallation complete.\n'
                     pt='\nInstalação concluída.\n' ;;
    done_daemon)     en='  • Daemon:     %s/etherbit-tiling-daemon\n'
                     pt='  • Daemon:     %s/etherbit-tiling-daemon\n' ;;
    done_ext)        en='  • Extension:  %s (enabled in profile)\n'
                     pt='  • Extensão:   %s (habilitada no perfil)\n' ;;
    done_service)    en='  • Service:    %s\n'
                     pt='  • Serviço:    %s\n' ;;
    done_wayland)    en='\nWayland: log out/in — the extension and daemon come up automatically, no manual step.\n'
                     pt='\nWayland: faça logout/login — a extensão e o daemon sobem automaticamente, sem passo manual.\n' ;;
  esac
  if [ "$ETB_LANG" = pt ] && [ -n "$pt" ]; then printf -- "$pt" "$@"; else printf -- "$en" "$@"; fi
}

# --- Trava de ambiente gráfico (fail-safe) -------------------------------------
# Impede execução cruzada: rodar o instalador do GNOME sob KDE (ou vice-versa)
# embaralharia configs/serviços de DEs distintos. Detecção via sinais freedesktop
# ($XDG_CURRENT_DESKTOP pode ser lista separada por ':', ex. "ubuntu:GNOME").
#   - GNOME detectado        → segue.
#   - KDE/Plasma detectado    → erro + exit 1 (a trava principal).
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
    *gnome*) return 0 ;;  # GNOME detectado — segue.
  esac
  case "$signals" in
    *kde*|*plasma*)
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

UUID="etherbit.tiling@ediano.dev"
REPO="${ETHERBIT_RELEASE_REPO:-ediano/Etherbit-Tiling}"
TARBALL="etherbit-tiling-gnome.tar.gz"
ASSET_URL="https://github.com/$REPO/releases/latest/download/$TARBALL"

# Diretório deste script. Via `curl ... | bash` o script vem do stdin e
# BASH_SOURCE fica vazio — o `:-` evita o "unbound variable" sob set -u.
SOURCE="${BASH_SOURCE[0]:-}"
if [ -n "$SOURCE" ]; then
  HERE="$(cd "$(dirname "$SOURCE")" && pwd)"
else
  HERE=""
fi

# Bootstrap: se o payload (daemon) não está ao lado do script — caso do
# `curl | bash`, em que só o install-gnome.sh chega — baixa e extrai o tarball de
# release num diretório temporário e segue a instalação a partir dele.
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
  HERE="$TMP/etherbit-tiling-gnome"
fi

BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE="etherbit-tiling-daemon.service"

# --- Validação -----------------------------------------------------------------
if [ ! -f "$HERE/bin/etherbit-tiling-daemon" ]; then
  t err_daemon_missing "$HERE" >&2
  exit 1
fi
if [ ! -f "$HERE/extension/extension.js" ] || [ ! -f "$HERE/extension/metadata.json" ]; then
  t err_ext_incomplete "$HERE" >&2
  exit 1
fi

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

# --- Daemon --------------------------------------------------------------------
t bin_install "$BIN_DIR"
mkdir -p "$BIN_DIR"
install -m 755 "$HERE/bin/etherbit-tiling-daemon" "$BIN_DIR/etherbit-tiling-daemon"

# --- Extensão ------------------------------------------------------------------
t ext_install "$EXT_DIR"
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
t service_install "$SERVICE"
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
    t warn_no_start
else
  t warn_no_systemctl
fi

# --- Habilitação blindada da extensão ------------------------------------------
# Injeta o UUID no perfil do GNOME (gsettings) para que o Shell carregue a extensão
# AUTOMATICAMENTE no próximo login Wayland — sem passo manual. Idempotente.
enable_extension() {
  # 1) Não bloquear extensões de usuário (o GNOME pode tê-las desabilitado em massa).
  if command -v gsettings >/dev/null; then
    gsettings set org.gnome.shell disable-user-extensions false 2>/dev/null || true
  fi
  # 2) Caminho preferido: gnome-extensions ajusta o gsettings correto e valida o UUID.
  if command -v gnome-extensions >/dev/null && gnome-extensions enable "$UUID" 2>/dev/null; then
    return 0
  fi
  # 3) Fallback: injeta o UUID em `enabled-extensions` de forma idempotente.
  if command -v gsettings >/dev/null; then
    local current list
    current="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo '@as []')"
    case "$current" in
      *"'$UUID'"*) return 0 ;; # já presente
    esac
    list="${current#@as }"
    if [ "$list" = "[]" ] || [ -z "$list" ]; then
      gsettings set org.gnome.shell enabled-extensions "['$UUID']" 2>/dev/null || true
    else
      gsettings set org.gnome.shell enabled-extensions "${list%]}, '$UUID']" 2>/dev/null || true
    fi
  fi
}
t enabling_ext "$UUID"
enable_extension || t warn_enable_failed "$UUID"

# --- Marcador de versão --------------------------------------------------------
# Registra a versão instalada — base de comparação do próximo run (upgrade idempotente).
if [ -n "$NEW_VERSION" ]; then
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$NEW_VERSION" > "$VERSION_FILE"
fi

# --- Fim -----------------------------------------------------------------------
t done_title
t done_daemon "$BIN_DIR"
t done_ext "$EXT_DIR"
t done_service "$SYSTEMD_DIR/$SERVICE"
t done_wayland
