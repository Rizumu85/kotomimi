#!/usr/bin/env bash
# Publishes the phone app's current version on GitHub, where every installed copy looks for a newer one
# (app/src/main/kotlin/…/Update.kt). Publishing is decided each time by whoever runs this: it only makes it one command.
#
#   android/scripts/publish.sh --notes "一句话，说这一版有什么"         says what it would do, and does nothing
#   android/scripts/publish.sh --notes "一句话，说这一版有什么" --yes   does it
#
#   --notes TEXT   one line, 40 characters at most: the app shows it under "新版本 X.Y.Z"
#   --apk FILE     the package to publish; app/build/outputs/apk/debug/app-debug.apk when not given
#   --yes          publish. Without it nothing on GitHub is changed.
#
# For the version in app/build.gradle.kts it makes two prereleases of Rizumu85/kotomimi, never anything else:
#
#   phone-vX.Y.Z   the package, as Kotomimi-phone-X.Y.Z.apk, tagged at the commit that is checked out
#   phone-latest   one small file, phone.json, replaced at every publish: what the app asks. Made the first time.
#
# Prereleases, never "latest": the repository's latest release is the desktop app's, and its updater looks that up.
#
# It refuses — before touching anything — when:
#   - the package is not the version the build file says, or is signed with another key than the copies in people's
#     hands (Android installs an update only over a copy signed with the same key: such a package nobody could install);
#   - phone-vX.Y.Z is already published with a different package, or is not a prerelease;
#   - phone.json on GitHub already tells of a higher version;
#   - android/ has changes that are not committed, or the commit is not on GitHub (the tag would name another source).
# Run again after a publish that broke off half way, it goes on: what is already there and right is left alone.
#
# Needs: gh (signed in to an account that may write to the repository), node, git, and the Android SDK's build-tools.
set -euo pipefail

REPO=Rizumu85/kotomimi
# The certificate of the key every published copy is signed with, by its SHA-256: this computer's debug key
# (README, "签名"). Not a secret — it is in every package — and what a package is held to here.
SIGNED_BY=0d0db733ff8d3558a71935b3d43a564ef2a6d95ecf939cc4ecff8fc65c68d19f
NOTES_MOST=40

# Paths as Windows programs take them too (gh, the SDK's tools), whatever the shell would have made of them.
norm() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
here="$(norm "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)")"
notes=""; apk=""; yes=""
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) notes="${2:-}"; shift 2 ;;
    --apk) apk="${2:-}"; shift 2 ;;
    --yes) yes=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
die() { echo "Refused: $*" >&2; exit 1; }
for tool in gh node git; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed."; done

# ── What is to be published ─────────────────────────────────────────────────────────────────────────────────────
gradle="$here/app/build.gradle.kts"
version="$(tr -d '\r' < "$gradle" | sed -n 's/^[[:space:]]*versionName = "\(.*\)"$/\1/p')"
code="$(tr -d '\r' < "$gradle" | sed -n 's/^[[:space:]]*versionCode = \([0-9]*\)$/\1/p')"
[ -n "$version" ] && [ -n "$code" ] || die "no versionName and versionCode in $gradle."
shown="$(tr -d '\r' < "$here/app/src/main/kotlin/io/github/rizumu85/kotomimi/node/SelfCheck.kt" | sed -n 's/^[[:space:]]*const val VERSION = "\(.*\)"$/\1/p')"
[ "$shown" = "$version" ] || die "the app would call itself $shown (BuildConfigLite.VERSION) and the build file says $version."

apk="$(norm "${apk:-$here/app/build/outputs/apk/debug/app-debug.apk}")"
[ -f "$apk" ] || die "no package at $apk: build it first (cd android && ./gradlew assembleDebug)."

sdk="${ANDROID_SDK:-${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}}"
if [ -z "$sdk" ]; then
  for guess in "${LOCALAPPDATA:-}/Android/Sdk" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [ -d "$guess" ]; then sdk="$guess"; break; fi
  done
fi
tools="$(ls -d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"; tools="${tools%/}"
exe=""; bat=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=".exe"; bat=".bat";; esac
[ -x "$tools/aapt2$exe" ] && [ -f "$tools/apksigner$bat" ] || die "no build-tools with aapt2 and apksigner under ${sdk:-the Android SDK}: set ANDROID_SDK."

# The package itself is asked what it is: one built before the version was raised is not this version.
badging="$("$tools/aapt2$exe" dump badging "$apk" | tr -d '\r')"
in_apk() { printf '%s\n' "$badging" | sed -n "s/.*$1'\([^']*\)'.*/\1/p" | head -1; }
[ "$(in_apk "versionName=")" = "$version" ] && [ "$(in_apk "versionCode=")" = "$code" ] ||
  die "the package is $(in_apk "versionName=") (code $(in_apk "versionCode=")), the build file says $version (code $code): build again."
sdk_least="$(printf '%s\n' "$badging" | sed -n "s/^minSdkVersion:'\([0-9]*\)'.*/\1/p" | head -1)"
[ -n "$sdk_least" ] || die "the package does not say the oldest Android it installs on."

signed_by="$("$tools/apksigner$bat" verify --print-certs "$apk" | tr -d '\r' | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')"
[ "$signed_by" = "$SIGNED_BY" ] ||
  die "the package is signed with another key (${signed_by:-none}) than the copies in people's hands ($SIGNED_BY). Nobody could install it over theirs. Build it on the computer that holds that key."

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
bytes="$(wc -c < "$apk" | tr -d ' ')"
sha256="$(sha256_of "$apk")"

[ -n "$notes" ] || die "say what is new in one line: --notes \"…\"."
long="$(node -e 'const s = process.argv[1]; process.stdout.write(/[\r\n]/.test(s) ? "lines" : String([...s].length))' "$notes")"
[ "$long" != lines ] || die "the notes are one line."
[ "$long" -le "$NOTES_MOST" ] || die "the notes are $long characters; the app shows $NOTES_MOST."

tag="phone-v$version"
name="Kotomimi-phone-$version.apk"
at="https://github.com/$REPO/releases/download"
json="$here/app/build/outputs/phone.json"
# Written by a program that knows how to quote: the notes are anybody's words.
node -e '
  const [file, version, code, apk, bytes, sha256, sdk, notes] = process.argv.slice(1);
  require("fs").writeFileSync(file, JSON.stringify({ version, code: Number(code), apk, bytes: Number(bytes), sha256, sdk: Number(sdk), notes }) + "\n");
' "$json" "$version" "$code" "$at/$tag/$name" "$bytes" "$sha256" "$sdk_least" "$notes"

# ── What would stop it, all of it said at once ──────────────────────────────────────────────────────────────────
problems=()
commit="$(git -C "$here" rev-parse HEAD)"
[ -z "$(git -C "$here" status --porcelain -- "$here")" ] || problems+=("android/ has changes that are not committed: the tag would name a source this package was not built from.")
[ -n "$(git -C "$here" branch -r --contains "$commit" 2>/dev/null)" ] || problems+=("commit ${commit:0:9} is not on GitHub: push it first, the tag is put on it.")

# Asks GitHub of a release; "absent" when there is none. Anything else that goes wrong stops the script: a GitHub
# that did not answer is not a release that is not there.
release() {
  local out
  if out="$(gh release view "$1" --repo "$REPO" --json "$2" --jq "$3" 2>&1)"; then printf '%s' "$out"
  elif printf '%s' "$out" | grep -qi 'release not found'; then printf 'absent'
  else echo "GitHub could not be asked about $1: $out" >&2; exit 1; fi
}

there="$(release "$tag" isPrerelease,isDraft '"\(.isPrerelease) \(.isDraft)"')"
package=new
if [ "$there" != absent ]; then
  [ "$there" = "true false" ] || problems+=("$tag is on GitHub and is not a published prerelease (prerelease, draft: $there): put that right by hand.")
  had="$(release "$tag" assets ".assets[] | select(.name == \"$name\") | \"\(.size) \(.digest // \"\")\"")"
  if [ -z "$had" ]; then package=missing
  else
    had_sha="${had#* }"; had_sha="${had_sha#sha256:}"
    if [ -z "$had_sha" ]; then
      # A GitHub that does not say the checksum: the file itself is fetched and looked at.
      scratch="$(norm "$(mktemp -d)")"; gh release download "$tag" --repo "$REPO" --pattern "$name" --dir "$scratch"; had_sha="$(sha256_of "$scratch/$name")"; rm -rf "$scratch"
    fi
    if [ "$had_sha" = "$sha256" ]; then package=same
    else die "$tag is already published with a different package (sha256 $had_sha; this one is $sha256). A published version is not replaced: raise the version."; fi
  fi
fi

latest="$(release phone-latest isPrerelease,isDraft '"\(.isPrerelease) \(.isDraft)"')"
told=""
if [ "$latest" != absent ]; then
  [ "$latest" = "true false" ] || problems+=("phone-latest is on GitHub and is not a published prerelease (prerelease, draft: $latest): put that right by hand.")
  holds="$(release phone-latest assets '.assets[] | select(.name == "phone.json") | .name')"
  if [ -n "$holds" ]; then
    now="$(gh release download phone-latest --repo "$REPO" --pattern phone.json --output -)"
    told="$(node -e 'try { const j = JSON.parse(process.argv[1]); process.stdout.write(`${j.code} ${j.version}`); } catch { process.stdout.write("0 unreadable"); }' "$now")"
    [ "${told%% *}" -le "$code" ] || problems+=("phone.json on GitHub already tells of ${told#* } (code ${told%% *}), higher than $version (code $code): publishing this would be a step back.")
  fi
fi

# ── What it comes to ────────────────────────────────────────────────────────────────────────────────────────────
echo "Kotomimi 手机端 $version (code $code), for Android API $sdk_least and later"
echo "  package   $apk"
echo "            $bytes bytes, sha256 $sha256"
echo "            signed with the key the published copies are signed with"
echo "  notes     $notes"
echo "  commit    $commit"
echo
echo "On GitHub ($REPO):"
case "$package" in
  new)     echo "  1. create the prerelease $tag at that commit, holding $name" ;;
  missing) echo "  1. $tag is there without its package: upload $name to it" ;;
  same)    echo "  1. $tag already holds this very package: left as it is" ;;
esac
if [ "$latest" = absent ]; then echo "  2. create the prerelease phone-latest (the first publish), holding phone.json"
else echo "  2. replace phone.json in phone-latest${told:+ (it tells of ${told#* }, code ${told%% *}, now)}"; fi
echo "     $(cat "$json")"
echo "  Nothing is marked latest; nothing else is touched."
echo
if [ ${#problems[@]} -gt 0 ]; then
  echo "Refused as things are:" >&2
  for problem in "${problems[@]}"; do echo "  - $problem" >&2; done
  exit 1
fi
if [ -z "$yes" ]; then
  echo "Nothing was done. To publish, run it again with --yes."
  exit 0
fi

# ── Doing it ────────────────────────────────────────────────────────────────────────────────────────────────────
# The package first, and seen to be there whole, before any phone is told of it.
if [ "$package" != same ]; then
  scratch="$(norm "$(mktemp -d)")"; cp "$apk" "$scratch/$name"
  if [ "$package" = new ]; then
    gh release create "$tag" "$scratch/$name" --repo "$REPO" --prerelease --latest=false --target "$commit" --title "Kotomimi 手机端 $version" --notes "$notes"
  else
    gh release upload "$tag" "$scratch/$name" --repo "$REPO"
  fi
  rm -rf "$scratch"
fi
[ "$(release "$tag" isPrerelease,isDraft,assets "\"\(.isPrerelease) \(.isDraft) \([.assets[] | select(.name == \"$name\") | .size] | first)\"")" = "true false $bytes" ] ||
  die "$tag is not on GitHub as it should be (a published prerelease holding $name, $bytes bytes). phone.json was not touched: no phone has been told."

if [ "$latest" = absent ]; then
  gh release create phone-latest "$json" --repo "$REPO" --prerelease --latest=false --target "$commit" --title "Kotomimi 手机端：最新版本" \
    --notes "手机端从这里的 phone.json 得知有没有新版本。不要删除这个发布，也不要改它的标签名：已经装出去的手机端只认这个地址。"
else
  gh release upload phone-latest "$json" --repo "$REPO" --clobber
fi
gh release download phone-latest --repo "$REPO" --pattern phone.json --output - | cmp -s - "$json" ||
  die "phone.json on GitHub is not what was sent. Look at $at/phone-latest/phone.json."

echo
echo "Published. Phones ask $at/phone-latest/phone.json"
echo "and fetch    $at/$tag/$name"
