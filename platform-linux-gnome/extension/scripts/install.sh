#!/usr/bin/env bash
# install.sh — instala o bundle da extensão na pasta local de extensões do GNOME.
#
# Copia (não bundla) dist/extension.js + metadata.json para
# ~/.local/share/gnome-shell/extensions/<uuid>/. Idempotente.
# Use via `pnpm run install:ext`, que roda `vite build` antes.
#
# Wayland: o GNOME Shell NÃO recarrega extensões com Alt+F2 r (isso é só X11).
# Para aplicar: faça logout/login, ou teste num Shell aninhado:
#   dbus-run-session -- gnome-shell --nested --wayland
set -euo pipefail

UUID="etherbit.tiling@ediano.dev"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if [ ! -f "$HERE/dist/extension.js" ]; then
  echo "erro: $HERE/dist/extension.js ausente — rode 'pnpm build' antes." >&2
  exit 1
fi
if [ ! -f "$HERE/metadata.json" ]; then
  echo "erro: $HERE/metadata.json ausente." >&2
  exit 1
fi

mkdir -p "$DEST"
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

echo "Instalada e habilitada em $DEST"
echo "Wayland: faça logout/login — a extensão sobe automaticamente, sem 'gnome-extensions enable'."
