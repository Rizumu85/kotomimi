#!/bin/bash
# Fork: build the Mac's speech helper and put it where the app loads it.
#
# The helper is a bundle — the system gives its speech recognition only to a
# program with a bundle identifier — written under resources/bin, which both
# packagers ship whole and which is not committed: CI builds it before
# packaging (.github/workflows/kotomimi-release.yml), and so does anyone
# packaging by hand on a Mac.
#
# It needs the macOS 26 SDK (SpeechAnalyzer). Where that is missing the build
# says so and leaves nothing behind: the app then simply does not offer the
# system's recognizer.
set -euo pipefail
cd "$(dirname "$0")"

DEST="../../resources/bin/darwin-arm64/Kotomimi Speech Helper.app"
rm -rf out "$DEST"
mkdir -p "out/Kotomimi Speech Helper.app/Contents/MacOS"
cp Info.plist "out/Kotomimi Speech Helper.app/Contents/Info.plist"
if ! swiftc -O -parse-as-library -target arm64-apple-macosx26.0 SpeechHelper.swift -o "out/Kotomimi Speech Helper.app/Contents/MacOS/speech-helper"; then
  echo "BUILD SKIPPED: the speech helper needs the macOS 26 SDK; the app will not offer the system's recognizer."
  exit 0
fi
# Ad hoc, so that it runs as built; packaging signs it again with the app's own identity.
codesign --force -s - "out/Kotomimi Speech Helper.app"
mkdir -p "$(dirname "$DEST")"
cp -R "out/Kotomimi Speech Helper.app" "$DEST"
echo "BUILD OK: $DEST"
