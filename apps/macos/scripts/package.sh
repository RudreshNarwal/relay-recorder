#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
relay_build_configuration="${RELAY_CONFIGURATION:-release}"
relay_signing_identity="${RELAY_SIGNING_IDENTITY:--}"
if [[ "${RELAY_SKIP_BUILD:-0}" != "1" ]]; then
  swift build -c "$relay_build_configuration" --arch arm64
fi
relay_bin_path="$(swift build -c "$relay_build_configuration" --arch arm64 --show-bin-path)"
relay_dist="$PWD/dist"
relay_app="$relay_dist/Relay.app"
if [[ -e "$relay_app" ]]; then
  mv "$relay_app" "$relay_dist/Relay.previous.$(date +%s).app"
fi
mkdir -p "$relay_app/Contents/MacOS" "$relay_app/Contents/Resources" "$relay_app/Contents/Frameworks"
cp "$relay_bin_path/Relay" "$relay_app/Contents/MacOS/Relay"
cp Resources/Info.plist "$relay_app/Contents/Info.plist"
shopt -s nullglob
for relay_framework in "$relay_bin_path"/PackageFrameworks/*.framework "$relay_bin_path"/*.framework; do
  ditto "$relay_framework" "$relay_app/Contents/Frameworks/$(basename "$relay_framework")"
done
for relay_library in "$relay_bin_path"/*.dylib; do
  cp "$relay_library" "$relay_app/Contents/Frameworks/"
done
for relay_bundle in "$relay_bin_path"/*.bundle; do
  ditto "$relay_bundle" "$relay_app/Contents/Resources/$(basename "$relay_bundle")"
done
# SwiftPM binaries may search their build directory; add the installed app's framework path.
install_name_tool -add_rpath @executable_path/../Frameworks "$relay_app/Contents/MacOS/Relay" 2>/dev/null || true
if [[ -f .build/checkouts/FluidAudio/LICENSE ]]; then
  cp .build/checkouts/FluidAudio/LICENSE "$relay_app/Contents/Resources/FluidAudio-LICENSE.txt"
fi
swift scripts/make-icon.swift "$relay_dist/Relay-icon.png"
mkdir -p "$relay_dist/Relay.iconset"
for relay_size in 16 32 128 256 512; do
  sips -z "$relay_size" "$relay_size" "$relay_dist/Relay-icon.png" --out "$relay_dist/Relay.iconset/icon_${relay_size}x${relay_size}.png" >/dev/null
  relay_double=$((relay_size * 2))
  sips -z "$relay_double" "$relay_double" "$relay_dist/Relay-icon.png" --out "$relay_dist/Relay.iconset/icon_${relay_size}x${relay_size}@2x.png" >/dev/null
done
iconutil -c icns "$relay_dist/Relay.iconset" -o "$relay_app/Contents/Resources/Relay.icns"
for relay_framework in "$relay_app/Contents/Frameworks"/*.framework; do
  codesign --force --sign "$relay_signing_identity" --options runtime "$relay_framework"
done
for relay_library in "$relay_app/Contents/Frameworks"/*.dylib; do
  codesign --force --sign "$relay_signing_identity" --options runtime "$relay_library"
done
codesign --force --sign "$relay_signing_identity" --options runtime --entitlements Resources/Relay.entitlements "$relay_app"
codesign --verify --deep --strict "$relay_app"
relay_dmg_stage="$(mktemp -d "$relay_dist/dmg-stage.XXXXXX")"
trap 'rm -rf "$relay_dmg_stage"' EXIT
ditto "$relay_app" "$relay_dmg_stage/Relay.app"
ln -s /Applications "$relay_dmg_stage/Applications"
hdiutil create -volname Relay -srcfolder "$relay_dmg_stage" -ov -format UDZO "$relay_dist/Relay.dmg"
if [[ -n "${RELAY_NOTARY_PROFILE:-}" ]]; then
  xcrun notarytool submit "$relay_dist/Relay.dmg" --keychain-profile "$RELAY_NOTARY_PROFILE" --wait
  xcrun stapler staple "$relay_app"
  xcrun stapler staple "$relay_dist/Relay.dmg"
fi
printf 'Built %s\n' "$relay_dist/Relay.dmg"
