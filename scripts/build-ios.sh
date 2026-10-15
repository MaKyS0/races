#!/usr/bin/env bash
# iOS IPA build.  MUST run on macOS with Xcode 16+ and an Apple Developer account. It cannot run on Linux/Windows.
# Usage: APPLE_TEAM_ID=ABCDE12345 scripts/build-ios.sh [development|ad-hoc|app-store-connect]
# Signing: automatic signing via your Xcode login, or provide a profile name via PROFILE_NAME (manual signing, as used in CI).
# NOTE: this script was written on Linux and has NOT been executed on a Mac. Expect to adjust it on first run.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname)" = "Darwin" ] || { echo "ERROR: building an IPA requires macOS + Xcode. Use the GitHub Actions workflow (.github/workflows/ios.yml) or a Mac."; exit 2; }
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID to your 10-character Apple Developer Team ID}"
METHOD="${1:-development}"
BUNDLE_ID="com.apexgp.simulator"
OUT="build-output/ios"; mkdir -p "$OUT"

npm ci --no-audit --no-fund
npx vitest run
npm run build
npx cap sync ios

EXPORT_PLIST="$OUT/ExportOptions.plist"
sed -e "s/__TEAM_ID__/$APPLE_TEAM_ID/g" -e "s/__METHOD__/$METHOD/g" -e "s/__BUNDLE_ID__/$BUNDLE_ID/g" -e "s/__PROFILE__/${PROFILE_NAME:-}/g" ios/signing/ExportOptions.plist.template > "$EXPORT_PLIST"
if [ -z "${PROFILE_NAME:-}" ]; then /usr/libexec/PlistBuddy -c "Delete :provisioningProfiles" "$EXPORT_PLIST" || true; /usr/libexec/PlistBuddy -c "Set :signingStyle automatic" "$EXPORT_PLIST"; fi

ARCHIVE="$OUT/App.xcarchive"
XCARGS=(-project ios/App/App.xcodeproj -scheme App -configuration Release -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" DEVELOPMENT_TEAM="$APPLE_TEAM_ID")
[ -z "${PROFILE_NAME:-}" ] && XCARGS+=(-allowProvisioningUpdates)
xcodebuild archive "${XCARGS[@]}"
EXPORTARGS=(-exportArchive -archivePath "$ARCHIVE" -exportPath "$OUT" -exportOptionsPlist "$EXPORT_PLIST")
[ -z "${PROFILE_NAME:-}" ] && EXPORTARGS+=(-allowProvisioningUpdates)
xcodebuild "${EXPORTARGS[@]}"
ls -l "$OUT"/*.ipa
