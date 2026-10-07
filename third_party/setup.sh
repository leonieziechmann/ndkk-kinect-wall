#!/bin/sh
# Fetches and builds the third-party parts that fn2/ links against, with w64devkit (gcc, cmake,
# ninja) on Windows:
#   - libfreenect2 (pinned commit) + our patches (fast reconnect, OpenCL header fixes)
#   - libusb 1.0.30 (prebuilt MinGW64), libjpeg-turbo 3.2.0 (built here)
#   - OpenCL headers + the legacy C++ bindings cl.hpp that libfreenect2 still needs
# Afterwards build the tools with `sh fn2/build.sh`. Safe to run again; finished steps are skipped.
set -e
cd "$(dirname "$0")"
T=$(pwd)

LIBFREENECT2_COMMIT=fd64c5d9b214df6f6a55b4419357e51083f15d93
LIBUSB_VERSION=1.0.30
JPEG_VERSION=3.2.0
CLHPP_REMOVED_CL_HPP=432b551   # this commit removed include/CL/cl.hpp; it is taken from its parent

echo "== libfreenect2"
if [ ! -d libfreenect2 ]; then
  git clone -q -c core.autocrlf=false https://github.com/OpenKinect/libfreenect2.git
  git -C libfreenect2 checkout -q "$LIBFREENECT2_COMMIT"
fi
if git -C libfreenect2 diff --quiet; then
  git -C libfreenect2 apply "$T/libfreenect2-fastreconnect.patch"
  echo "patch applied"
else
  echo "already patched"
fi

echo "== libusb $LIBUSB_VERSION"
if [ ! -f libusb/MinGW64/dll/libusb-1.0.dll ]; then
  curl -sSLO "https://github.com/libusb/libusb/releases/download/v$LIBUSB_VERSION/libusb-$LIBUSB_VERSION.7z"
  mkdir -p libusb
  (cd libusb && /c/Windows/System32/tar.exe -xf "../libusb-$LIBUSB_VERSION.7z")   # Windows tar reads 7z
fi

echo "== libjpeg-turbo $JPEG_VERSION"
if [ ! -f jpeg/bin/libturbojpeg.dll ]; then
  curl -sSLO "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/$JPEG_VERSION/libjpeg-turbo-$JPEG_VERSION.tar.gz"
  tar xzf "libjpeg-turbo-$JPEG_VERSION.tar.gz"
  # no SIMD: w64devkit has no nasm (only colour JPEG decoding uses it; depth is unaffected)
  cmake -S "libjpeg-turbo-$JPEG_VERSION" -B jpeg-build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$T/jpeg" -DWITH_SIMD=OFF -DENABLE_STATIC=OFF > jpeg-configure.log
  ninja -C jpeg-build install > jpeg-build.log
fi

echo "== OpenCL headers"
if [ ! -f ocl-include/CL/cl.hpp ]; then
  [ -d ocl-headers ] || git clone -q --depth 1 https://github.com/KhronosGroup/OpenCL-Headers.git ocl-headers
  [ -d clhpp ] || git clone -q https://github.com/KhronosGroup/OpenCL-CLHPP.git clhpp
  mkdir -p ocl-include/CL
  git -C clhpp show "$CLHPP_REMOVED_CL_HPP^:include/CL/cl.hpp" > ocl-include/CL/cl.hpp
  cp ocl-headers/CL/*.h ocl-include/CL/
fi

echo "== build libfreenect2 (OpenCL + CPU depth pipelines, no OpenGL/CUDA)"
cmake -S libfreenect2 -B fn2-build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$T/fn2" \
  -DCMAKE_DISABLE_FIND_PACKAGE_PkgConfig=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DLibUSB_INCLUDE_DIRS="$T/libusb/include" -DLibUSB_LIBRARIES="$T/libusb/MinGW64/static/libusb-1.0.dll.a" \
  -DLibUSB_DLL="$T/libusb/MinGW64/dll/libusb-1.0.dll" \
  -DTurboJPEG_INCLUDE_DIRS="$T/jpeg/include" -DTurboJPEG_LIBRARIES="$T/jpeg/lib/libturbojpeg.dll.a" \
  -DTurboJPEG_DLL="$T/jpeg/bin/libturbojpeg.dll" \
  -DENABLE_OPENCL=ON -DOpenCL_INCLUDE_DIR="$T/ocl-include" -DOpenCL_LIBRARY=/c/Windows/System32/OpenCL.dll \
  -DENABLE_CUDA=OFF -DENABLE_OPENGL=OFF -DENABLE_VAAPI=OFF -DENABLE_TEGRAJPEG=OFF \
  -DBUILD_OPENNI2_DRIVER=OFF -DENABLE_CXX11=ON > fn2-configure.log
ninja -C fn2-build > fn2-build.log
echo "done: now run   sh fn2/build.sh"
