#!/bin/sh
# Builds the worker, tools and DLLs against the patched libfreenect2 in ../third_party (w64devkit gcc).
# From a worktree: T=/c/.../kinect/third_party sh fn2/build.sh (the main checkout has third_party).
set -e
cd "$(dirname "$0")"
T=${T:-../third_party}
mkdir -p bin
g++ -O2 -std=c++17 -Wall fn2_reconnect.cpp -o bin/fn2_reconnect.exe \
  -I$T/libfreenect2/include -I$T/fn2-build -I$T/fn2-build/libfreenect2 \
  -L$T/fn2-build/lib -lfreenect2
cp -u $T/fn2-build/bin/libfreenect2.dll $T/libusb/MinGW64/dll/libusb-1.0.dll $T/jpeg/bin/libturbojpeg.dll bin/
g++ -O2 -std=c++17 -Wall -shared fn2capi.cpp -o bin/fn2capi.dll \
  -I$T/libfreenect2/include -I$T/fn2-build -I$T/fn2-build/libfreenect2 \
  -L$T/fn2-build/lib -lfreenect2 -static-libgcc -static-libstdc++
g++ -O3 -ffast-math -std=c++17 -Wall -shared cloudsplat.cpp -o bin/cloudsplat.dll -static-libgcc -static-libstdc++ -static
# the CPU depth decoder: AVX2/FMA and fast math in this file only (the worker checks the CPU)
g++ -O3 -mavx2 -mfma -ffast-math -std=c++20 -Wall -c fast_depth.cpp -o bin/fast_depth.o
g++ -O2 -std=c++20 -Wall fn2_capture.cpp bin/fast_depth.o -o bin/fn2_capture.exe \
  -I$T/libfreenect2/include -I$T/fn2-build -I$T/fn2-build/libfreenect2 \
  -L$T/fn2-build/lib -lfreenect2 -static-libgcc -static-libstdc++
# tools for the depth decoder: record raw packets (needs the Kinect), compare decoders offline
g++ -O2 -std=c++17 -Wall fn2_rawdump.cpp -o bin/fn2_rawdump.exe \
  -I$T/libfreenect2/include -I$T/fn2-build -I$T/fn2-build/libfreenect2 \
  -L$T/fn2-build/lib -lfreenect2 -static-libgcc -static-libstdc++
g++ -O2 -std=c++20 -Wall depth_bench.cpp bin/fast_depth.o -o bin/depth_bench.exe \
  -I$T/libfreenect2/include -I$T/libfreenect2/include/internal -I$T/fn2-build -I$T/fn2-build/libfreenect2 \
  -L$T/fn2-build/lib -lfreenect2 -static-libgcc -static-libstdc++
