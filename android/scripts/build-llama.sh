#!/usr/bin/env bash
# Builds llama.cpp's two programs for Android arm64 and puts them where the app's build picks them up, beside
# audio.cpp's engine (build-engine.sh). Nothing it makes is committed.
#
#   llama-mtmd-cli  reads one recording and ends: the self-check reads the same recording with both engines and says
#                   which is faster on the phone
#   llama-server    stays up and is asked over HTTP: what the phone is lent with when a llama.cpp model is shared
#
#   android/scripts/build-llama.sh            the three the app is packed with: v80, v82, v86
#   android/scripts/build-llama.sh v82 vulkan  only these
#
#   v80     plain armv8-a (NEON): runs on every arm64 phone
#   v82     ggml's CPU code compiled for armv8.2-a with dot product and half floats
#   v86     the same for armv8.6-a with the 8-bit matrix multiply (i8mm) too
#   vulkan  plain armv8-a with ggml's Vulkan backend linked in, for the graphics chip; needs the phone's libvulkan.so
#
#   kleidiai-v82  the v82 build with Arm's KleidiAI kernels beside ggml's own
#   kleidiai-v86  the v86 build with them
#   opencl        the v82 build with ggml's OpenCL backend linked in, for Qualcomm's Adreno graphics chips; needs the
#                 phone's own libOpenCL.so
#
# The processor builds make both programs. The Vulkan build makes the reader alone: on the phones tried the graphics
# chip is slower than the processor or ends the program, so the phone is never lent with it, and a server for it
# would be ten megabytes of package nobody runs.
#
# The last three make the reader alone too. They were packed up to phone 0.9.3 for the self-check to measure on
# phones nobody here has; three phones answered (2026-10-12 to 10-28) and none was a way to lend (`Llama.kt`), so
# they are built only when named, and not packed by the app's self-check any more: to measure one again, build it
# and run it by hand over adb.
#
# KleidiAI is not a level of processor but a second set of kernels for the language model's quantized matrix
# products, which picks among its own at run time (dot product, i8mm, SME, SME2) whatever the build was compiled
# for. The rest of the reading — all of the part that hears, which is about half of the time — stays ggml's own
# code, and that is as fast as the level it was compiled for. So there is one KleidiAI build for each level a plain
# build is measured at beside it: the two then differ by KleidiAI and by nothing else. There is none for v80: every
# kernel KleidiAI has for these models (Q8_0) needs the dot product at least.
#
# The OpenCL build is v82 beneath: what the graphics chip does not take falls to the processor, and every phone with
# an Adreno this backend accepts has dot product and half floats.
#
# Each is one self-contained program (libc, libm and libdl only): unlike audio.cpp's engine it cannot choose its CPU
# code at run time, so the app chooses the program (Llama.kt). They are not built as shared libraries because
# llama.cpp's libggml*.so have the very names of audio.cpp's and are not the same ggml (0.25.3 against 0.12.0): the
# two cannot lie in one folder.
#
# Needs the Android SDK with an NDK and its CMake (Android Studio installs both). Reads:
#   ANDROID_SDK   the SDK folder; found in the usual places when unset
#   LLAMA_SRC     a llama.cpp source tree at the tag below; cloned into android/.engine when unset
#   TARGETS       the programs to build, where not all of a build's: "llama-server" or "llama-mtmd-cli"
#
# The Vulkan build turns its shaders into code with a small program that runs here, on the computer doing the build,
# so it needs a C++ compiler for this computer too: on Windows Visual Studio's (found and set up below when `cl` is
# not already on the PATH), elsewhere gcc or clang.
set -euo pipefail

LLAMA_TAG=b11401
# The Vulkan headers audio.cpp is built against (build-engine.sh).
VULKAN_TAG=vulkan-sdk-1.4.357.0
# Khronos's OpenCL headers, and its loader: only to link against (the phone's own libOpenCL.so is what runs).
OPENCL_TAG=v2025.07.22
ABI=arm64-v8a
API=28

# The programs of a build, and the name each is packed under: one Android unpacks and lets the app run (lib*.so), as
# audio.cpp's programs are.
targets_of() { case "$1" in vulkan|kleidiai-*|opencl) echo "llama-mtmd-cli" ;; *) echo "llama-mtmd-cli llama-server" ;; esac; }
# (kleidiai-v82 is packed as libllama_mtmd_kleidiai_v82.so.)
packed_as() { case "$1" in llama-mtmd-cli) echo "libllama_mtmd_${2//-/_}.so" ;; llama-server) echo "libllama_server_${2//-/_}.so" ;; esac; }
for target in ${TARGETS:-}; do
  case "$target" in llama-mtmd-cli|llama-server) ;; *) echo "Unknown program: $target (llama-mtmd-cli or llama-server)." >&2; exit 1 ;; esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$here/.engine"
libs="$here/app/src/main/jniLibs/$ABI"
mkdir -p "$work" "$libs"

builds=("$@")
[ ${#builds[@]} -gt 0 ] || builds=(v80 v82 v86)
for name in "${builds[@]}"; do
  case "$name" in
    v80|v82|v86|vulkan|kleidiai-v82|kleidiai-v86|opencl) ;;
    *) echo "Unknown build: $name (v80, v82, v86, vulkan, kleidiai-v82, kleidiai-v86 or opencl)." >&2; exit 1 ;;
  esac
done

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
strip="$host/bin/llvm-strip$exe"

src="${LLAMA_SRC:-$work/llama.cpp}"
if [ ! -f "$src/CMakeLists.txt" ]; then
  git clone --depth 1 --branch "$LLAMA_TAG" https://github.com/ggml-org/llama.cpp.git "$src"
fi
src="$(norm "$src")"
work="$(norm "$work")"

# What every build shares. No web page, no HTTPS client, no tests. ggml's own thread pool instead of OpenMP, as
# llama.cpp's Android release is built. (LLAMA_USE_PREBUILT_UI=OFF: left on, the build fetches a web page from
# Hugging Face.)
common=(
  -G Ninja -DCMAKE_MAKE_PROGRAM="$ninja"
  -DCMAKE_TOOLCHAIN_FILE="$ndk/build/cmake/android.toolchain.cmake"
  -DANDROID_ABI="$ABI" -DANDROID_PLATFORM="android-$API" -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF
  -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF
)

# What the Vulkan build needs besides: headers the NDK does not have, and a compiler for this computer.
prepare_vulkan() {
  # Vulkan's C++ headers: the NDK has the C headers, the library and glslc. build-engine.sh fetches the same ones.
  vk="$work/vulkan-headers"
  if [ ! -f "$vk/include/vulkan/vulkan.hpp" ]; then
    git clone --depth 1 --branch "$VULKAN_TAG" https://github.com/KhronosGroup/Vulkan-Headers.git "$vk"
  fi
  # SPIR-V's headers: llama.cpp asks for them as a CMake package (find_package(SPIRV-Headers CONFIG REQUIRED)), not
  # as the folder of headers audio.cpp is given. So they are installed into a folder of their own: headers and a few
  # small CMake files, nothing compiled.
  spv_package="$work/spirv-headers-package"
  if [ ! -d "$spv_package/share/cmake/SPIRV-Headers" ]; then
    spv="$work/spirv-headers"
    if [ ! -f "$spv/CMakeLists.txt" ]; then
      git clone --depth 1 --branch "$VULKAN_TAG" https://github.com/KhronosGroup/SPIRV-Headers.git "$spv"
    fi
    "$cmake" -S "$spv" -B "$work/build-spirv-headers" -G Ninja -DCMAKE_MAKE_PROGRAM="$ninja" \
      -DCMAKE_TOOLCHAIN_FILE="$ndk/build/cmake/android.toolchain.cmake" -DANDROID_ABI="$ABI" -DANDROID_PLATFORM="android-$API" \
      -DCMAKE_INSTALL_PREFIX="$spv_package" -DSPIRV_HEADERS_ENABLE_TESTS=OFF -DSPIRV_HEADERS_ENABLE_INSTALL=ON
    "$cmake" --install "$work/build-spirv-headers"
  fi
  glslc="$(ls "$ndk"/shader-tools/*/glslc"$exe" | head -1)"
  # The compiler for this computer. On Windows: Visual Studio's environment, taken from its own script.
  if [ -n "$exe" ] && ! command -v cl >/dev/null 2>&1; then
    vcvars="$(ls "/c/Program Files"*/"Microsoft Visual Studio"/*/*/VC/Auxiliary/Build/vcvars64.bat 2>/dev/null | sort | tail -1)"
    [ -n "$vcvars" ] || { echo "No Visual Studio C++ compiler found: the Vulkan shaders need one to be built." >&2; exit 1; }
    ask="$work/vcvars-env.bat"
    printf '@echo off\r\ncall "%s" >nul\r\nset\r\n' "$(cygpath -w "$vcvars")" > "$ask"
    # (`key`, not `name`: the loop over the builds below keeps its own in `name`, and a function shares it.)
    while IFS='=' read -r key value; do
      case "$key" in
        PATH|Path) export PATH="$(cygpath -up "$value")" ;;
        INCLUDE|LIB|LIBPATH) export "$key=$value" ;;
      esac
    done < <(cmd //c "$(cygpath -w "$ask")" | tr -d '\r')
    command -v cl >/dev/null 2>&1 || { echo "Visual Studio's environment did not give a compiler." >&2; exit 1; }
  fi
  # The shader program's own build looks for Ninja on the PATH.
  if command -v cygpath >/dev/null 2>&1; then PATH="$(cygpath -u "$cmake_dir/bin"):$PATH"; else PATH="$cmake_dir/bin:$PATH"; fi
  export PATH
}

# What the OpenCL build needs besides: OpenCL's headers, which the NDK does not have, and a libOpenCL.so to link
# against. Android has none of its own: where there is one it is the graphics chip's maker's, in the phone's vendor
# folder, and the program finds it there when it starts. Khronos's loader is built here only for its name and its
# symbols; it is not packed.
prepare_opencl() {
  cl_headers="$work/opencl-headers"
  if [ ! -f "$cl_headers/CL/cl.h" ]; then
    git clone --depth 1 --branch "$OPENCL_TAG" https://github.com/KhronosGroup/OpenCL-Headers.git "$cl_headers"
  fi
  cl_loader="$work/build-opencl-loader"
  if [ ! -f "$cl_loader/libOpenCL.so" ]; then
    if [ ! -f "$work/opencl-loader/CMakeLists.txt" ]; then
      git clone --depth 1 --branch "$OPENCL_TAG" https://github.com/KhronosGroup/OpenCL-ICD-Loader.git "$work/opencl-loader"
    fi
    "$cmake" -S "$work/opencl-loader" -B "$cl_loader" -G Ninja -DCMAKE_MAKE_PROGRAM="$ninja" \
      -DCMAKE_TOOLCHAIN_FILE="$ndk/build/cmake/android.toolchain.cmake" -DANDROID_ABI="$ABI" -DANDROID_PLATFORM="android-$API" \
      -DCMAKE_BUILD_TYPE=Release -DOPENCL_ICD_LOADER_HEADERS_DIR="$cl_headers" -DBUILD_TESTING=OFF
    "$cmake" --build "$cl_loader" --target OpenCL
  fi
}

echo "llama.cpp: $src"
echo "NDK:       $ndk"

for name in "${builds[@]}"; do
  case "$name" in
    v80) extra=() ;;
    # GGML_CPU_ARM_ARCH puts -march on ggml's CPU code only, which is where the time goes.
    v82) extra=(-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16) ;;
    v86) extra=(-DGGML_CPU_ARM_ARCH=armv8.6-a+dotprod+fp16+i8mm) ;;
    # GGML_CPU_KLEIDIAI fetches KleidiAI's source when it is configured (a release archive from GitHub, its checksum
    # in ggml's own build file) and compiles each of its kernels for the processor that kernel is for.
    kleidiai-v82) extra=(-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16 -DGGML_CPU_KLEIDIAI=ON) ;;
    kleidiai-v86) extra=(-DGGML_CPU_ARM_ARCH=armv8.6-a+dotprod+fp16+i8mm -DGGML_CPU_KLEIDIAI=ON) ;;
    opencl)
      prepare_opencl
      extra=(-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16 -DGGML_OPENCL=ON
             -DOpenCL_INCLUDE_DIR="$cl_headers" -DOpenCL_LIBRARY="$cl_loader/libOpenCL.so")
      ;;
    vulkan)
      prepare_vulkan
      extra=(-DGGML_VULKAN=ON
             -DVulkan_INCLUDE_DIR="$vk/include" -DVulkan_GLSLC_EXECUTABLE="$glslc"
             -DVulkan_LIBRARY="$host/sysroot/usr/lib/aarch64-linux-android/$API/libvulkan.so"
             -DSPIRV-Headers_DIR="$spv_package/share/cmake/SPIRV-Headers")
      ;;
  esac
  # A short folder name, and the shortest for Vulkan: the shader program is built in a build of its own six folders
  # down, and on Windows its compiler gives up on a path past 260 letters ("C1083: Cannot open compiler generated
  # file" — met with `build-llama-vulkan` under a deep checkout, 2026-10-12).
  build="$work/llama-$name"
  case "$name" in vulkan) build="$work/llama-vk" ;; kleidiai-v82) build="$work/llama-k82" ;; kleidiai-v86) build="$work/llama-k86" ;; opencl) build="$work/llama-cl" ;; esac
  # Of this build's programs, the ones asked for; all of them where none was.
  targets=()
  for target in $(targets_of "$name"); do
    case " ${TARGETS:-$target} " in *" $target "*) targets+=("$target") ;; esac
  done
  [ ${#targets[@]} -gt 0 ] || { echo "== $name: none of its programs asked for"; continue; }
  echo "== $name (${targets[*]}) -> $build"
  # (An empty list, said so that an old bash with `set -u` takes it.)
  "$cmake" -S "$src" -B "$build" "${common[@]}" ${extra[@]+"${extra[@]}"}
  "$cmake" --build "$build" --target "${targets[@]}" -j "${JOBS:-8}"
  for target in "${targets[@]}"; do
    "$strip" -o "$libs/$(packed_as "$target" "$name")" "$build/bin/$target"
  done
done

echo "llama.cpp's programs in $libs:"
ls -la "$libs"/libllama_*.so
