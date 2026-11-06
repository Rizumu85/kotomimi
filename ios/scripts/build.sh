#!/bin/sh
# Builds the app on a Mac and installs it on a device paired with that Mac (by cable once, then over Wi-Fi).
#
#   scripts/build.sh              build, and install on the one paired iPad or iPhone
#   scripts/build.sh <device-id>  install on that one (`xcrun devicectl list devices` lists them)
#   scripts/build.sh --build      build only
#
# Signing is the Mac's own Apple Development certificate and its team (KOTOMIMI_TEAM, read from the certificate
# when not set). With a free Apple ID an install runs for seven days; installing again keeps the app's data.
set -eu
cd "$(dirname "$0")/.."

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is needed: brew install xcodegen" >&2
  exit 1
fi
if [ -z "${KOTOMIMI_TEAM:-}" ]; then
  KOTOMIMI_TEAM=$(security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject | sed -n 's/.*OU=\([A-Z0-9]*\).*/\1/p')
fi
export KOTOMIMI_TEAM
echo "team $KOTOMIMI_TEAM"

xcodegen generate --quiet
xcodebuild -project KotomimiNode.xcodeproj -scheme KotomimiNode -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath build -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$KOTOMIMI_TEAM" build | grep -E "error|warning: .*KotomimiNode|BUILD" || true
app=build/Build/Products/Debug-iphoneos/Kotomimi.app
[ -d "$app" ] || { echo "build failed" >&2; exit 1; }
[ "${1:-}" = "--build" ] && exit 0

device=${1:-}
if [ -z "$device" ]; then
  xcrun devicectl list devices --json-output build/devices.json >/dev/null
  device=$(python3 -c 'import json;d=[x for x in json.load(open("build/devices.json"))["result"]["devices"] if x.get("hardwareProperties",{}).get("platform")=="iOS" and x.get("connectionProperties",{}).get("pairingState")=="paired"];print(d[0]["identifier"] if len(d)==1 else "")')
  [ -n "$device" ] || { echo "pair one device, or name it: xcrun devicectl list devices" >&2; exit 1; }
fi
xcrun devicectl device install app --device "$device" "$app"
xcrun devicectl device process launch --device "$device" io.github.rizumu85.kotomimi.node || true
