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
    echo ">> ETHERBIT_SKIP_DE_CHECK=1 — trava de ambiente desativada."
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
      echo "erro: este é o instalador do KDE, mas o ambiente atual parece ser o GNOME." >&2
      echo "       Use o install-gnome.sh. Para forçar: ETHERBIT_SKIP_DE_CHECK=1 bash <este-script>." >&2
      exit 1
      ;;
  esac
  echo "aviso: não foi possível confirmar que o ambiente é o KDE/Plasma (XDG_CURRENT_DESKTOP='${XDG_CURRENT_DESKTOP:-vazio}')." >&2
  if [ -t 0 ]; then
    printf 'Continuar a instalação do KDE mesmo assim? [s/N] ' >&2
    local resp=""
    read -r resp || resp=""
    case "$resp" in
      [sSyY]*) echo ">> Prosseguindo a pedido do usuário."; return 0 ;;
      *) echo "Instalação cancelada." >&2; exit 1 ;;
    esac
  fi
  echo "       Sessão não interativa — abortando por segurança. Para forçar: ETHERBIT_SKIP_DE_CHECK=1 bash <este-script>." >&2
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
  echo ">> Instalação limpa${NEW_VERSION:+ (v$NEW_VERSION)}."
elif [ -z "$NEW_VERSION" ]; then
  echo ">> VERSION ausente no pacote — reinstalação forçada sobre v$OLD_VERSION."
elif [ "$NEW_VERSION" = "$OLD_VERSION" ]; then
  echo ">> Mesma versão (v$OLD_VERSION) — reaplicando arquivos (idempotente)."
elif version_gt "$NEW_VERSION" "$OLD_VERSION"; then
  echo ">> Atualizando v$OLD_VERSION → v$NEW_VERSION."
elif [ "${ETHERBIT_FORCE:-0}" = "1" ]; then
  echo ">> ETHERBIT_FORCE=1 — downgrade v$OLD_VERSION → v$NEW_VERSION."
else
  echo "aviso: o pacote (v$NEW_VERSION) é mais antigo que o instalado (v$OLD_VERSION); mantendo o atual." >&2
  echo "       Para forçar o downgrade: ETHERBIT_FORCE=1 bash <este-script>" >&2
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

# --- Marcador de versão --------------------------------------------------------
# Registra a versão instalada — base de comparação do próximo run (upgrade idempotente).
if [ -n "$NEW_VERSION" ]; then
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$NEW_VERSION" > "$VERSION_FILE"
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
