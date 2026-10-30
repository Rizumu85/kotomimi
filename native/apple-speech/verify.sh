#!/bin/bash
# Run the real macOS text-language recognizer against paired-selection regression cases.
set -euo pipefail
cd "$(dirname "$0")"
TEST_BINARY="$(mktemp "${TMPDIR:-/tmp}/kotomimi-speech-pair.XXXXXX")"
trap 'rm -f "$TEST_BINARY"' EXIT
swiftc -parse-as-library SpeechPairSelection.swift SpeechPairSelectionTests.swift -o "$TEST_BINARY"
"$TEST_BINARY"
