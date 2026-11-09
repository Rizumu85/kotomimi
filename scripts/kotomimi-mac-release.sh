#!/bin/bash
# Fork: a release's macOS build, made on a Mac and added to the draft the release workflow leaves
# (`.github/workflows/kotomimi-release.yml` builds Windows only: GitHub's macOS arm64 runners were seldom to be had).
#
#   bash scripts/kotomimi-mac-release.sh [checkout of the tag, its node_modules installed]
#
# Run it in a Terminal window on the Mac, not over SSH: the login keychain holding "Kotomimi Code Signing" is locked
# to an SSH session, and signing fails with errSecInternalComponent. It builds, signs with that certificate, checks
# what the updater needs, and leaves in out/make-mac what is uploaded to the draft: the .dmg, the .zip, both .blockmap
# files and latest-mac.yml.
set -euo pipefail
cd "${1:-.}"

# The speech helper is skipped without the macOS 26 SDK, and the app would then not offer the Mac's own recognition.
SDK=$(xcrun --sdk macosx --show-sdk-version)
[ "${SDK%%.*}" -ge 26 ] || { echo "The speech helper needs the macOS 26 SDK; this Mac has $SDK." >&2; exit 1; }

CI=false npm run build
npm run build:audio-host
bash native/apple-speech/build.sh

rm -rf out/make-mac
# Named, or the fuses hook (scripts/electron-builder-fuses.js) signs ad hoc before electron-builder signs.
CI=false CSC_NAME="Kotomimi Code Signing" CSC_IDENTITY_AUTO_DISCOVERY=true \
  npx electron-builder --mac dmg zip --arm64 --publish never -c.directories.output=out/make-mac

# electron-builder says "skipped macOS code signing" and carries on when it finds no identity: a release that looked
# signed and was not would break every update after it.
fail() { echo "$1" >&2; exit 1; }
APP=$(find out/make-mac -name 'Kotomimi.app' -maxdepth 3 | head -1)
[ -n "$APP" ] || fail "No Kotomimi.app under out/make-mac."
DR=$(codesign -d -r- "$APP" 2>&1 | grep 'designated =>' | sed 's/^#* *designated => //')
case "$DR" in
  *"certificate leaf = H"*|*"certificate root = H"*) ;;
  *) fail "Not signed with the certificate (designated requirement: $DR)." ;;
esac
codesign --verify --deep --strict "$APP"
# Read whole before grep: `grep -q` stops reading, and under pipefail the writer's broken pipe would fail the check.
SIGNATURE=$(codesign -dv "$APP" 2>&1)
grep -Eq 'flags=0x[0-9a-f]+\([^)]*runtime' <<<"$SIGNATURE" || fail "Not signed with the Hardened Runtime."
# Under the Hardened Runtime the microphone is refused, with no question asked, to a bundle without this entitlement.
for BUNDLE in "$APP" "$APP"/Contents/Frameworks/*.app; do
  ENTITLEMENTS=$(codesign -d --entitlements - "$BUNDLE" 2>/dev/null)
  grep -q 'com.apple.security.device.audio-input' <<<"$ENTITLEMENTS" || fail "$(basename "$BUNDLE") lacks the audio-input entitlement."
done
ZIP=$(find out/make-mac -maxdepth 1 -name '*.zip' | head -1)
[ -n "$ZIP" ] || fail "No .zip: the updater has nothing to install."
grep -q "$(basename "$ZIP")" out/make-mac/latest-mac.yml || fail "latest-mac.yml does not name the zip."
echo "designated requirement: $DR"
ls out/make-mac
