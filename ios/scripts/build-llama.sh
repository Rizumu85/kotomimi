#!/bin/sh
# Builds llama.cpp b11401 (the desktop app's version) as static libraries for iOS devices and the simulator, with
# Metal, and its common library (chat templates, sampling). Output: ../llama/{ios,sim}/lib/*.a and include/, beside
# this ios/ folder (project.yml looks there). Run on the Mac: scripts/build-llama.sh
set -e
export PATH=/opt/homebrew/bin:$PATH
cd "$(dirname "$0")/../.."
[ -d llama.cpp ] || git clone --depth 1 --branch b11401 https://github.com/ggml-org/llama.cpp.git llama.cpp
for target in ios sim; do
  if [ $target = ios ]; then sysroot=iphoneos; else sysroot=iphonesimulator; fi
  cmake -S llama.cpp -B build-llama-$target -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=$sysroot -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=26.0 \
    -DBUILD_SHARED_LIBS=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=OFF -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_APP=OFF -DLLAMA_BUILD_HTML=OFF \
    -DLLAMA_BUILD_COMMON=ON -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_HTTPLIB=OFF \
    -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_BLAS=OFF -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF \
    > build-llama-$target.cfg.log 2>&1
  cmake --build build-llama-$target --config Release -j 8 --target llama llama-common > build-llama-$target.log 2>&1
  mkdir -p llama/$target/lib llama/$target/include/common
  find build-llama-$target -name "*.a" -exec cp {} llama/$target/lib/ \;
  cp llama.cpp/include/*.h llama.cpp/ggml/include/*.h llama/$target/include/
  cp llama.cpp/common/*.h llama/$target/include/common/
  [ -d llama.cpp/common/jinja ] && mkdir -p llama/$target/include/common/jinja && cp llama.cpp/common/jinja/*.h* llama/$target/include/common/jinja/ 2>/dev/null || true
  cp -R llama.cpp/vendor llama/$target/include/ 2>/dev/null || true
done
ls llama/ios/lib llama/sim/lib
