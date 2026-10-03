#!/usr/bin/env bash
# Fork: makes the certificate the macOS build is signed with, and stores it in
# the repository's secrets (FORK.md, "macOS 的签名"). Run once, by the
# repository's owner, with Git Bash:
#
#   bash scripts/kotomimi-mac-signing-cert.sh [owner/repo]
#
# From PowerShell:
#
#   & "C:\Program Files\Git\bin\bash.exe" <path to this file>
#
# The certificate, its key and the password are written beside this script
# when it is copied into a folder of its own — keep that folder, and keep it
# out of the repository: the same certificate has to sign every release.
# Running it again keeps an existing certificate and only stores it again.
set -euo pipefail
cd "$(dirname "$0")"

REPO="${1:-Rizumu85/kotomimi}"
NAME="Kotomimi Code Signing"

for tool in openssl base64 gh; do
  command -v "$tool" >/dev/null || { echo "Missing: $tool. Run this with Git Bash, with the GitHub CLI installed." >&2; exit 1; }
done
case "$PWD" in
  */scripts) echo "Copy this script into a folder of its own first (e.g. ~/kotomimi-signing): the key must not sit in the repository." >&2; exit 1 ;;
esac

if [ -f signing.p12 ] && [ -s pass.txt ]; then
  echo "Found signing.p12 here: keeping it. (Delete signing.p12 to make a new certificate — that changes the signature.)"
else
  umask 077
  openssl rand -hex 16 > pass.txt
  # MSYS would rewrite "/CN=..." into a Windows path.
  MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes \
    -keyout key.pem -out cert.pem -subj "/CN=$NAME" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null
  # -legacy: macOS cannot import a .p12 encrypted the way OpenSSL 3 does by default.
  openssl pkcs12 -export -legacy -inkey key.pem -in cert.pem -name "$NAME" -out signing.p12 -passout file:pass.txt
  echo "Made a new certificate."
fi

echo "The certificate:"
openssl pkcs12 -legacy -in signing.p12 -passin file:pass.txt -nokeys -clcerts 2>/dev/null | openssl x509 -noout -subject -enddate -fingerprint -sha1 | sed 's/^/  /'

base64 -w0 signing.p12 | gh secret set MACOS_CSC_LINK -R "$REPO"
gh secret set MACOS_CSC_KEY_PASSWORD -R "$REPO" --body "$(cat pass.txt)"

echo
echo "Done. The secrets of $REPO now:"
gh secret list -R "$REPO" | sed 's/^/  /'
echo "Keep this folder ($PWD) somewhere safe: the next release, and every one after it, is signed with it."
