#!/bin/sh
# Builds fn2_reconnect.exe against the patched libfreenect2 in ../third_party (w64devkit gcc).
set -e
cd "$(dirname "$0")"
T=../third_party
mkdir -p bin
g++ -O2 -std=c++17 -Wall fn2_reconnect.cpp -o bin/fn2_reconnect.exe \
  -I$T/libfreenect2/include -I$T/fn2-build -I$T/fn2-build/libfreenect2 \
  -L$T/fn2-build/lib -lfreenect2
cp -u $T/fn2-build/bin/libfreenect2.dll $T/libusb/MinGW64/dll/libusb-1.0.dll $T/jpeg/bin/libturbojpeg.dll bin/
g++ -O2 -std=c++17 -Wall -shared fn2capi.cpp -o bin/fn2capi.dll \
  -I$T/libfreenect2/include -I$T/fn2-build -I$T/fn2-build/libfreenect2 \
  -L$T/fn2-build/lib -lfreenect2 -static-libgcc -static-libstdc++
g++ -O3 -ffast-math -std=c++17 -Wall -shared cloudsplat.cpp -o bin/cloudsplat.dll -static-libgcc -static-libstdc++ -static
g++ -O2 -std=c++17 -Wall fn2_capture.cpp -o bin/fn2_capture.exe \
  -I$T/libfreenect2/include -I$T/fn2-build -I$T/fn2-build/libfreenect2 \
  -L$T/fn2-build/lib -lfreenect2 -static-libgcc -static-libstdc++
