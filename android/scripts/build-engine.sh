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
#
# The Vulkan backend is built too, for the phone's graphics chip. Its shaders are turned into code by a small program
# that runs here, on the computer doing the build, so a C++ compiler for this computer is needed as well: on Windows
# Visual Studio's (found and set up below when `cl` is not already on the PATH), elsewhere gcc or clang.
set -euo pipefail

AUDIOCPP_TAG=v0.9.0
# The Vulkan headers audio.cpp's own releases are built against.
VULKAN_TAG=vulkan-sdk-1.4.357.0
# The model families the desktop app offers: Qwen3-ASR (both sizes), Nemotron, Confucius4 R2T2.
MODELS="qwen3_asr,nemotron_asr,confucius4_r2t2"
ABI=arm64-v8a
API=28

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$here/.engine"
libs="$here/app/src/main/jniLibs/$ABI"
assets="$here/app/src/main/assets"
mkdir -p "$work"

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
glslc="$(ls "$ndk"/shader-tools/*/glslc"$exe" | head -1)"

src="${AUDIOCPP_SRC:-$work/audio.cpp}"
if [ ! -f "$src/CMakeLists.txt" ]; then
  git clone --depth 1 --branch "$AUDIOCPP_TAG" https://github.com/0xShug0/audio.cpp.git "$src"
fi
src="$(norm "$src")"
build="$(norm "$work")/build-$ABI"

# Vulkan's C++ headers and SPIR-V's: the NDK has the C headers and the library, not these.
headers="$work/vulkan-headers"
if [ ! -f "$headers/include/vulkan/vulkan.hpp" ]; then
  git clone --depth 1 --branch "$VULKAN_TAG" https://github.com/KhronosGroup/Vulkan-Headers.git "$headers"
fi
if [ ! -f "$headers/include/spirv/unified1/spirv.hpp" ]; then
  git clone --depth 1 --branch "$VULKAN_TAG" https://github.com/KhronosGroup/SPIRV-Headers.git "$work/spirv-headers"
  cp -r "$work/spirv-headers/include/spirv" "$headers/include/"
fi
headers="$(norm "$headers")"

# The compiler for this computer. On Windows: Visual Studio's environment, taken from its own script.
if [ -n "$exe" ] && ! command -v cl >/dev/null 2>&1; then
  vcvars="$(ls "/c/Program Files"*/"Microsoft Visual Studio"/*/*/VC/Auxiliary/Build/vcvars64.bat 2>/dev/null | sort | tail -1)"
  [ -n "$vcvars" ] || { echo "No Visual Studio C++ compiler found: the Vulkan shaders need one to be built." >&2; exit 1; }
  ask="$work/vcvars-env.bat"
  printf '@echo off\r\ncall "%s" >nul\r\nset\r\n' "$(cygpath -w "$vcvars")" > "$ask"
  while IFS='=' read -r name value; do
    case "$name" in
      PATH|Path) export PATH="$(cygpath -up "$value")" ;;
      INCLUDE|LIB|LIBPATH) export "$name=$value" ;;
    esac
  done < <(cmd //c "$(cygpath -w "$ask")" | tr -d '\r')
  command -v cl >/dev/null 2>&1 || { echo "Visual Studio's environment did not give a compiler." >&2; exit 1; }
fi
# The shader program's own build looks for Ninja on the PATH.
if command -v cygpath >/dev/null 2>&1; then PATH="$(cygpath -u "$cmake_dir/bin"):$PATH"; else PATH="$cmake_dir/bin:$PATH"; fi
export PATH

echo "audio.cpp: $src"
echo "NDK:       $ndk"

"$cmake" -S "$src" -B "$build" -G Ninja -DCMAKE_MAKE_PROGRAM="$ninja" \
  -DCMAKE_TOOLCHAIN_FILE="$ndk/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="$ABI" -DANDROID_PLATFORM="android-$API" -DCMAKE_BUILD_TYPE=Release \
  -DENGINE_ENABLE_CPU_ALL_VARIANTS=ON \
  -DENGINE_ENABLE_VULKAN=ON -DVulkan_INCLUDE_DIR="$headers/include" -DVulkan_GLSLC_EXECUTABLE="$glslc" \
  -DVulkan_LIBRARY="$host/sysroot/usr/lib/aarch64-linux-android/$API/libvulkan.so" \
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
  name="$(basename "$lib")"
  # Under its own name ggml would load the Vulkan backend for every run, and a phone whose driver cannot take it
  # would lose the processor too. Under another, it is loaded only where the app asks (GGML_BACKEND_PATH).
  [ "$name" = libggml-vulkan.so ] && name=libkotomimi-vulkan.so
  "$strip" -o "$libs/$name" "$lib"; found=$((found + 1))
done < <(find "$build" -name 'lib*.so' -not -path '*/CMakeFiles/*')
omp="$(find "$host/lib/clang" -path '*aarch64/libomp.so' | head -1)"
cp "$omp" "$libs/libomp.so"

# The self-check's recording: fourteen seconds of read English from LibriSpeech (CC BY 4.0), as audio.cpp ships it.
cp "$src/assets/asr_validation/librispeech/librispeech_test_clean_6930-75918-0001.wav" "$assets/selfcheck.wav"

echo "Engine in $libs ($found libraries):"
ls -la "$libs"
