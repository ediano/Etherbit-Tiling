#!/usr/bin/env bash
# install.sh — instala o bundle da extensão na pasta local de extensões do GNOME.
#
# Copia (não bundla) dist/extension.js (loader) + dist/main.js (impl) + metadata.json para
# ~/.local/share/gnome-shell/extensions/<uuid>/. Idempotente.
# Use via `pnpm run install:ext`, que roda `vite build` antes.
#
# Hot-reload (ADR 0071): a impl vai para `impl/dev-<timestamp>/` e `impl/current` aponta para ela;
# o loader já carregado troca de versão ao vivo, sem logout. Logout só na primeira instalação ou
# quando o próprio loader (src/loader.ts) ou o metadata.json mudam. Se o daemon estiver rodando
# como serviço, ele também é reiniciado para não ficar com o binário velho em memória.
set -euo pipefail

UUID="etherbit.tiling@ediano.dev"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if [ ! -f "$HERE/dist/extension.js" ] || [ ! -f "$HERE/dist/main.js" ]; then
  echo "erro: $HERE/dist/{extension,main}.js ausente — rode 'pnpm build' antes." >&2
  exit 1
fi
if [ ! -f "$HERE/metadata.json" ]; then
  echo "erro: $HERE/metadata.json ausente." >&2
  exit 1
fi

# Anti-obsolescência: se algum fonte for mais novo que o bundle, o dist está VELHO — rebuild antes.
# Instalar um dist obsoleto é uma armadilha clássica (a extensão "carrega", mas roda código antigo).
if [ -n "$(find "$HERE/src" -name '*.ts' -newer "$HERE/dist/extension.js" -print -quit 2>/dev/null)" ]; then
  echo "erro: dist/extension.js está mais velho que o código em src/ — rode 'pnpm build' antes" >&2
  echo "       (ou use 'pnpm run install:ext', que reconstrói automaticamente)." >&2
  exit 1
fi

NEEDS_LOGOUT=0
if ! cmp -s "$HERE/dist/extension.js" "$DEST/extension.js" 2>/dev/null \
   || ! cmp -s "$HERE/metadata.json" "$DEST/metadata.json" 2>/dev/null; then
  NEEDS_LOGOUT=1
fi
IMPL_VERSION="dev-$(date +%s)"
mkdir -p "$DEST/impl/$IMPL_VERSION"
install -m 644 "$HERE/dist/main.js" "$DEST/impl/$IMPL_VERSION/main.js"
[ -f "$HERE/dist/main.js.map" ] && install -m 644 "$HERE/dist/main.js.map" "$DEST/impl/$IMPL_VERSION/main.js.map"
install -m 644 "$HERE/dist/extension.js" "$DEST/extension.js"
install -m 644 "$HERE/metadata.json" "$DEST/metadata.json"

# Opcionais, quando existirem.
[ -f "$HERE/dist/extension.js.map" ] && install -m 644 "$HERE/dist/extension.js.map" "$DEST/extension.js.map"
[ -f "$HERE/stylesheet.css" ] && install -m 644 "$HERE/stylesheet.css" "$DEST/stylesheet.css"
if [ -d "$HERE/schemas" ]; then
  mkdir -p "$DEST/schemas"
  install -m 644 "$HERE"/schemas/*.gschema.xml "$DEST/schemas/" 2>/dev/null || true
  command -v glib-compile-schemas >/dev/null && glib-compile-schemas "$DEST/schemas"
fi

# Habilitação blindada: injeta o UUID no perfil para o Shell carregar a extensão
# automaticamente no próximo login Wayland (idempotente). Ver ADR rules/0016.
command -v gsettings >/dev/null && gsettings set org.gnome.shell disable-user-extensions false 2>/dev/null || true
if command -v gnome-extensions >/dev/null && gnome-extensions enable "$UUID" 2>/dev/null; then
  :
elif command -v gsettings >/dev/null; then
  current="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo '@as []')"
  case "$current" in
    *"'$UUID'"*) : ;;
    *)
      list="${current#@as }"
      if [ "$list" = "[]" ] || [ -z "$list" ]; then
        gsettings set org.gnome.shell enabled-extensions "['$UUID']" 2>/dev/null || true
      else
        gsettings set org.gnome.shell enabled-extensions "${list%]}, '$UUID']" 2>/dev/null || true
      fi
      ;;
  esac
fi

# Daemon de dev: se o serviço existe, reinicia para assumir o binário recém-compilado.
if command -v systemctl >/dev/null && systemctl --user is-active --quiet etherbit-tiling-daemon.service 2>/dev/null; then
  systemctl --user restart etherbit-tiling-daemon.service || true
fi

# Troca ao vivo (escrita atômica de `current`) e limpeza: mantém as 2 versões mais novas.
printf '%s\n' "$IMPL_VERSION" > "$DEST/impl/current.tmp"
mv -f "$DEST/impl/current.tmp" "$DEST/impl/current"
find "$DEST/impl" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +3 \
  | cut -d' ' -f2- | while IFS= read -r d; do rm -rf -- "$d"; done

echo "Instalada e habilitada em $DEST (impl $IMPL_VERSION)"
if [ "$NEEDS_LOGOUT" = 1 ]; then
  echo "Loader novo: faça logout/login uma vez — depois disso os updates recarregam ao vivo."
else
  echo "Recarregada ao vivo — sem logout."
fi
