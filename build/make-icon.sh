#!/bin/bash
# Gera build/icon.icns (ícone do app no Mac) a partir de um SVG.
# Uso: bash build/make-icon.sh build/logo-options/a-green-bold.svg
set -e
SRC="$1"
cd "$(dirname "$0")/.."
SET=build/icon.iconset
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  node -e "require('sharp')(require('fs').readFileSync('$SRC')).resize($s,$s).png().toFile('$SET/icon_${s}x${s}.png')"
  d=$((s*2))
  node -e "require('sharp')(require('fs').readFileSync('$SRC')).resize($d,$d).png().toFile('$SET/icon_${s}x${s}@2x.png')"
done
iconutil -c icns "$SET" -o build/icon.icns
cp "$SRC" build/icon.svg
node -e "require('sharp')(require('fs').readFileSync('$SRC')).resize(256,256).png().toFile('build/icon.png')"
echo "build/icon.icns pronto"
