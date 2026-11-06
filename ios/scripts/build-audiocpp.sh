#!/bin/sh
# Builds audio.cpp v0.9.0 (the desktop app's recognition engine) for iOS devices and the simulator, with Metal, as
# its C library (include/audiocpp.h) made into a framework: Kotomimi.app links llama.cpp's ggml already, and
# audio.cpp carries a ggml of its own that differs from it. A framework keeps its own inside — on Apple a library
# binds its references when it is linked, and this one exports audiocpp_* alone (src/capi/audiocpp.symbols).
# Output: ../audiocpp/audiocpp.xcframework beside this ios/ folder (project.yml looks there).
# Run on the Mac: scripts/build-audiocpp.sh
set -e
export PATH=/opt/homebrew/bin:$PATH
cd "$(dirname "$0")/../.."
[ -d audio.cpp ] || git clone --depth 1 --branch v0.9.0 https://github.com/0xShug0/audio.cpp.git audio.cpp
# The recognition models the app lends: the desktop's Qwen3-ASR and Confucius4 R2T2 (and Nemotron's, which costs
# little to have built).
MODELS="qwen3_asr,confucius4_r2t2,nemotron_asr"
# sentencepiece names its iOS programs' bundles with a helper it does not define (set_xcode_property, from the
# ios-cmake toolchain): none of them is built here.
mkdir -p audiocpp
echo 'function(set_xcode_property)
endfunction()' > audiocpp/ios-shims.cmake
for target in ios sim; do
  if [ $target = ios ]; then sysroot=iphoneos; else sysroot=iphonesimulator; fi
  build=build-audiocpp-$target
  cmake -S audio.cpp -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=$sysroot -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=26.0 \
    -DCMAKE_PROJECT_INCLUDE="$PWD/audiocpp/ios-shims.cmake" -DAUDIOCPP_BUILD_C_API=ON -DENGINE_ENABLE_METAL=ON -DENGINE_ENABLE_OPENMP=OFF -DENGINE_ENABLE_NATIVE_CPU=OFF \
    -DENGINE_ENABLE_VULKAN=OFF -DENGINE_ENABLE_CUDA=OFF -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_BLAS=OFF \
    -DAUDIOCPP_DEPLOYMENT_BUILD=ON -DAUDIOCPP_MODEL_SET=custom -DAUDIOCPP_MODELS="$MODELS" \
    > $build.cfg.log 2>&1
  cmake --build $build --target audiocpp -j 6 > $build.log 2>&1
  lib=$(find $build -name "libaudiocpp*.dylib" -type f | head -1)
  out=audiocpp/$target/audiocpp.framework
  rm -rf $out && mkdir -p $out/Headers $out/Modules
  cp "$lib" $out/audiocpp
  install_name_tool -id @rpath/audiocpp.framework/audiocpp $out/audiocpp
  cp audio.cpp/include/audiocpp.h $out/Headers/
  printf 'framework module audiocpp {\n  header "audiocpp.h"\n  export *\n}\n' > $out/Modules/module.modulemap
  cat > $out/Info.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>audiocpp</string>
<key>CFBundleIdentifier</key><string>io.github.rizumu85.kotomimi.audiocpp</string>
<key>CFBundleName</key><string>audiocpp</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>CFBundleShortVersionString</key><string>0.9.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>MinimumOSVersion</key><string>26.0</string>
<key>CFBundleSupportedPlatforms</key><array><string>$( [ $target = ios ] && echo iPhoneOS || echo iPhoneSimulator )</string></array>
</dict></plist>
PLIST
  echo "$target: $(du -sh $out | cut -f1), $(nm -gU $out/audiocpp | grep -c ' _audiocpp_') audiocpp_ symbols, $(nm -gU $out/audiocpp | grep -vc ' _audiocpp_') others"
done
# One for the device and the simulator, for Xcode to take the right one of.
rm -rf audiocpp/audiocpp.xcframework
xcodebuild -create-xcframework -framework audiocpp/ios/audiocpp.framework -framework audiocpp/sim/audiocpp.framework -output audiocpp/audiocpp.xcframework
