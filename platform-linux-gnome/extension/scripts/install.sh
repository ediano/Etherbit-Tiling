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

UUID="tiling@etherbit.org"
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

echo "Instalada em $DEST"
echo "Wayland: faça logout/login para recarregar o Shell."
echo "Depois, habilite o motor: gnome-extensions enable $UUID"
