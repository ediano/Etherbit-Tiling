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

UUID="etherbit.tiling@ediano.dev"
REPO="${ETHERBIT_RELEASE_REPO:-ediano/etherbit-tiling-releases}"
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
  HERE="$TMP/etherbit-tiling-gnome"
fi

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
echo ">> Habilitando a extensão no perfil do usuário ($UUID)"
enable_extension || echo "aviso: não foi possível habilitar agora; habilite com 'gnome-extensions enable $UUID'."

# --- Marcador de versão --------------------------------------------------------
# Registra a versão instalada — base de comparação do próximo run (upgrade idempotente).
if [ -n "$NEW_VERSION" ]; then
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$NEW_VERSION" > "$VERSION_FILE"
fi

# --- Fim -----------------------------------------------------------------------
echo
echo "Instalação concluída."
echo "  • Daemon:    $BIN_DIR/etherbit-tiling-daemon"
echo "  • Extensão:  $EXT_DIR (habilitada no perfil)"
echo "  • Serviço:   $SYSTEMD_DIR/$SERVICE"
echo
echo "Wayland: faça logout/login — a extensão e o daemon sobem automaticamente, sem passo manual."
