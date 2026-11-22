#!/usr/bin/env bash
# Instala cloudflared (Cloudflare) para los túneles de FRAP: quick tunnels https://*.trycloudflare.com,
# sin cuenta y sin límite de tiempo. Baja el binario oficial de GitHub (cloudflare/cloudflared).
#
#   bash scripts/install-cloudflared.sh
#
# Queda en $FRAP_HOME/bin/cloudflared (por defecto ~/.config/frap/bin). Para desinstalar, borra ese archivo.
set -euo pipefail

FRAP_HOME="${FRAP_HOME:-$HOME/.config/frap}"
DEST="$FRAP_HOME/bin"
BASE="https://github.com/cloudflare/cloudflared/releases/latest/download"
command -v curl >/dev/null || { echo "Falta 'curl': instálalo y vuelve a intentar." >&2; exit 1; }

os="$(uname -s)"; arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  armv7l|armv6l) arch=arm ;;
  i386|i686) arch=386 ;;
  *) echo "Arquitectura no soportada: $arch" >&2; exit 1 ;;
esac
mkdir -p "$DEST"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
case "$os" in
  Linux)
    echo "→ Descargando cloudflared-linux-$arch…"
    curl -fL --progress-bar -o "$tmp/cloudflared" "$BASE/cloudflared-linux-$arch" ;;
  Darwin)
    echo "→ Descargando cloudflared-darwin-$arch…"
    curl -fL --progress-bar -o "$tmp/cf.tgz" "$BASE/cloudflared-darwin-$arch.tgz"
    tar -xzf "$tmp/cf.tgz" -C "$tmp" ;;
  *) echo "Sistema no soportado: $os (descárgalo de https://github.com/cloudflare/cloudflared/releases)" >&2; exit 1 ;;
esac
chmod +x "$tmp/cloudflared"
"$tmp/cloudflared" --version >/dev/null || { echo "El binario descargado no funciona en este equipo" >&2; exit 1; }
mv "$tmp/cloudflared" "$DEST/cloudflared"
echo "✓ $("$DEST/cloudflared" --version | head -1)"
echo "  Instalado en $DEST/cloudflared. En FRAP: Túneles → el proveedor «Cloudflare» ya está disponible."
