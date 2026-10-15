#!/usr/bin/env bash
# Reproducible Android build.  Usage: scripts/build-android.sh [debug|release] [apk|aab]
#   debug   -> android/app/build/outputs/apk/debug/app-debug.apk        (signed with the Android debug key; for testing only)
#   release -> android/app/build/outputs/{apk,bundle}/release/...        (signed ONLY if a keystore is provided, see docs/BUILD.md)
# Requirements: Node >= 20, JDK 17+ (21 tested), Android SDK with platform 36 + build-tools 36 (ANDROID_HOME or ANDROID_SDK_ROOT).
set -euo pipefail
cd "$(dirname "$0")/.."
VARIANT="${1:-debug}"; FORMAT="${2:-apk}"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK" ] || [ ! -d "$SDK" ]; then echo "ERROR: set ANDROID_HOME to an Android SDK (platforms;android-36, build-tools;36.0.0)"; exit 2; fi
echo "sdk.dir=$SDK" > android/local.properties

npm ci --no-audit --no-fund
npx vitest run                       # physics/AI/track tests must pass before packaging
npm run build
[ -d android ] || npx cap add android
npx cap sync android

cd android
case "$VARIANT:$FORMAT" in
  debug:apk)    ./gradlew --no-daemon assembleDebug;  OUT=app/build/outputs/apk/debug/app-debug.apk ;;
  release:apk)  ./gradlew --no-daemon assembleRelease; OUT=app/build/outputs/apk/release/app-release.apk ;;
  release:aab)  ./gradlew --no-daemon bundleRelease;   OUT=app/build/outputs/bundle/release/app-release.aab ;;
  *) echo "unsupported: $VARIANT $FORMAT"; exit 2 ;;
esac
[ -f "$OUT" ] || { [ "$VARIANT" = release ] && OUT="${OUT/app-release./app-release-unsigned.}"; }
echo; echo "Built: android/$OUT"; ls -l "android/$OUT" 2>/dev/null || ls -l "$OUT"
if [ "$VARIANT" = release ] && [[ "$OUT" == *unsigned* ]]; then
  echo "WARNING: release artifact is UNSIGNED (no keystore configured). It cannot be installed or published until signed."
fi
