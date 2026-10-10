#!/usr/bin/env bash
# Builds the recognition engine (audio.cpp, the one the desktop app downloads) for Android arm64 and puts it where
# the app's build picks it up. Nothing it makes is committed.
#
#   android/scripts/build-engine.sh
#
# Needs the Android SDK with an NDK and its CMake (Android Studio installs both). Reads:
#   ANDROID_SDK   the SDK folder; found in the usual places when unset
#   AUDIOCPP_SRC  an audio.cpp source tree at the tag below; cloned into android/.engine when unset
#
# The engine is built with every CPU variant ggml knows for Android (armv8.0 … armv9.2): it loads the best one the
# phone's processor has, so one build is as fast on an old phone as on a new one as a build made for either.
set -euo pipefail

AUDIOCPP_TAG=v0.9.0
# The model families the desktop app offers: Qwen3-ASR (both sizes), Nemotron, Confucius4 R2T2.
MODELS="qwen3_asr,nemotron_asr,confucius4_r2t2"
ABI=arm64-v8a
API=28

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$here/.engine"
libs="$here/app/src/main/jniLibs/$ABI"
assets="$here/app/src/main/assets"

# Paths with forward slashes, for CMake on Windows as elsewhere.
norm() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

sdk="${ANDROID_SDK:-${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}}"
if [ -z "$sdk" ]; then
  for guess in "${LOCALAPPDATA:-}/Android/Sdk" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [ -d "$guess" ]; then sdk="$guess"; break; fi
  done
fi
[ -d "$sdk" ] || { echo "No Android SDK found: set ANDROID_SDK." >&2; exit 1; }
sdk="$(norm "$sdk")"
ndk="$(ls -d "$sdk"/ndk/*/ 2>/dev/null | sort -V | tail -1)"; ndk="${ndk%/}"
cmake_dir="$(ls -d "$sdk"/cmake/*/ 2>/dev/null | sort -V | tail -1)"; cmake_dir="${cmake_dir%/}"
[ -d "$ndk" ] || { echo "No NDK under $sdk/ndk: install one from Android Studio's SDK Manager." >&2; exit 1; }
[ -d "$cmake_dir" ] || { echo "No CMake under $sdk/cmake: install it from Android Studio's SDK Manager." >&2; exit 1; }
exe=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=".exe";; esac
cmake="$cmake_dir/bin/cmake$exe"
ninja="$cmake_dir/bin/ninja$exe"
host="$(ls -d "$ndk"/toolchains/llvm/prebuilt/*/ | head -1)"; host="${host%/}"

src="${AUDIOCPP_SRC:-$work/audio.cpp}"
if [ ! -f "$src/CMakeLists.txt" ]; then
  mkdir -p "$work"
  git clone --depth 1 --branch "$AUDIOCPP_TAG" https://github.com/0xShug0/audio.cpp.git "$src"
fi
src="$(norm "$src")"
build="$(norm "$work")/build-$ABI"

echo "audio.cpp: $src"
echo "NDK:       $ndk"

"$cmake" -S "$src" -B "$build" -G Ninja -DCMAKE_MAKE_PROGRAM="$ninja" \
  -DCMAKE_TOOLCHAIN_FILE="$ndk/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="$ABI" -DANDROID_PLATFORM="android-$API" -DCMAKE_BUILD_TYPE=Release \
  -DENGINE_ENABLE_CPU_ALL_VARIANTS=ON \
  -DAUDIOCPP_DEPLOYMENT_BUILD=ON \
  -DAUDIOCPP_MODEL_SET=custom -DAUDIOCPP_MODELS="$MODELS"
"$cmake" --build "$build" --target audiocpp_cli audiocpp_server -j "${JOBS:-8}"

# Into the app: Android unpacks and lets an app run only files named lib*.so from its library folder, so the two
# programs take that shape, beside the libraries they load.
rm -rf "$libs"; mkdir -p "$libs" "$assets"
strip="$host/bin/llvm-strip$exe"
"$strip" -o "$libs/libaudiocpp_cli.so" "$build/bin/audiocpp_cli"
"$strip" -o "$libs/libaudiocpp_server.so" "$build/bin/audiocpp_server"
found=0
while IFS= read -r lib; do
  "$strip" -o "$libs/$(basename "$lib")" "$lib"; found=$((found + 1))
done < <(find "$build" -name 'lib*.so' -not -path '*/CMakeFiles/*')
omp="$(find "$host/lib/clang" -path '*aarch64/libomp.so' | head -1)"
cp "$omp" "$libs/libomp.so"

# The self-check's recording: fourteen seconds of read English from LibriSpeech (CC BY 4.0), as audio.cpp ships it.
cp "$src/assets/asr_validation/librispeech/librispeech_test_clean_6930-75918-0001.wav" "$assets/selfcheck.wav"

echo "Engine in $libs ($found libraries):"
ls -la "$libs"
