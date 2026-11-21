#!/usr/bin/env bash
# Instala whisper.cpp + un modelo para el módulo de voz de FRAP (transcripción local, sin internet al usarlo).
#
#   bash scripts/install-whisper.sh [modelo]     # modelo: tiny | base (por defecto) | small | medium
#
# Deja en $FRAP_HOME/whisper (por defecto ~/.config/frap/whisper):
#   whisper-cli        binario de whisper.cpp (v1.7.2: compila con make y g++, no necesita cmake)
#   ggml-<modelo>.bin  modelo multilingüe (base ≈ 142 MB; small ≈ 466 MB, mejor español pero más lento)
# Para desinstalar basta con borrar esa carpeta.
set -euo pipefail

MODEL="${1:-base}"
case "$MODEL" in tiny|base|small|medium) ;; *) echo "Modelo inválido: $MODEL (tiny | base | small | medium)" >&2; exit 1 ;; esac
VERSION="v1.7.2"
FRAP_HOME="${FRAP_HOME:-$HOME/.config/frap}"
DEST="$FRAP_HOME/whisper"

for cmd in git make g++ curl; do
  command -v "$cmd" >/dev/null || { echo "Falta '$cmd': instálalo y vuelve a intentar." >&2; exit 1; }
done
mkdir -p "$DEST"

if [ ! -x "$DEST/whisper-cli" ]; then
  SRC="$(mktemp -d)"
  trap 'rm -rf "$SRC"' EXIT
  echo "→ Descargando whisper.cpp $VERSION…"
  git clone -q --depth 1 --branch "$VERSION" https://github.com/ggerganov/whisper.cpp "$SRC/whisper.cpp"
  echo "→ Compilando (1-2 min)…"
  if ! make -C "$SRC/whisper.cpp" -j"$(nproc 2>/dev/null || echo 4)" main >"$SRC/build.log" 2>&1; then
    tail -20 "$SRC/build.log" >&2
    echo "Falló la compilación de whisper.cpp." >&2
    exit 1
  fi
  install -m 0755 "$SRC/whisper.cpp/main" "$DEST/whisper-cli"
  echo "✓ $DEST/whisper-cli"
else
  echo "✓ Ya instalado: $DEST/whisper-cli"
fi

FILE="$DEST/ggml-$MODEL.bin"
if [ ! -s "$FILE" ]; then
  echo "→ Descargando el modelo $MODEL…"
  curl -fL --progress-bar -o "$FILE.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
  mv "$FILE.part" "$FILE"
fi
echo "✓ $FILE"
echo "Listo. En FRAP, el módulo de voz (panel derecho) ya puede transcribir."
