#!/bin/bash
# Monta o app Android e instala no celular ligado por cabo (ou pelo adb sem fio).
# Uso: bash android/build.sh            (monta e instala)
#      bash android/build.sh --no-install
set -e
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"

# 1. Motor Node para Android (nodejs-mobile), baixado uma vez.
NM=vendor/nodejs-mobile
if [ ! -f "$NM/bin/arm64-v8a/libnode.so" ]; then
  mkdir -p vendor
  curl -sL -o vendor/nodejs-mobile-android.zip \
    https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip
  unzip -q -o vendor/nodejs-mobile-android.zip -d "$NM"
fi
mkdir -p app/src/main/jniLibs/arm64-v8a app/src/main/assets
cp "$NM/bin/arm64-v8a/libnode.so" app/src/main/jniLibs/arm64-v8a/

# 2. Código do servidor e da tela, com só as dependências que o celular usa.
STAGE=build/nodejs-project
mkdir -p "$STAGE"
rsync -a --delete "$ROOT/server/" "$STAGE/server/"
rsync -a --delete "$ROOT/ui/" "$STAGE/ui/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --loglevel=error)
# Nada de módulo nativo do Mac pode ir para o celular.
if find "$STAGE/node_modules" -name "*.node" | grep -q .; then
  echo "Módulo nativo encontrado:"; find "$STAGE/node_modules" -name "*.node"; exit 1
fi
rm -f app/src/main/assets/nodejs-project.zip
(cd "$STAGE" && zip -qr -X ../../app/src/main/assets/nodejs-project.zip .)
echo "Código do servidor: $(du -h app/src/main/assets/nodejs-project.zip | cut -f1)"

# 3. Monta o APK.
[ -f gradlew ] || gradle wrapper --gradle-version 9.9.2 -q
./gradlew -q assembleRelease
APK=app/build/outputs/apk/release/app-release.apk
echo "APK: $APK ($(du -h "$APK" | cut -f1))"

# 4. Instala no celular.
if [ "$1" != "--no-install" ]; then
  adb install -r "$APK"
fi
