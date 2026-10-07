"""Minimal ctypes binding to the Kinect for Windows SDK 2.0 runtime (Kinect20.dll).

Only what is needed for the color and depth feeds. The interfaces are COM-style
vtables; the indices below come from the SDK header (inc/Kinect.h) and count the
three IUnknown methods (QueryInterface, AddRef, Release) as 0..2.
"""

import ctypes
from ctypes import POINTER, WINFUNCTYPE, byref, c_float, c_int, c_long, c_uint, c_ubyte, c_ushort, c_void_p

import cv2
import numpy as np

E_PENDING = -2147483638  # 0x8000000A: no new frame since the last call

COLOR_IMAGE_FORMAT_BGRA = 3
COLOR_IMAGE_FORMAT_YUY2 = 5


class KinectError(RuntimeError):
    pass


def _check(hr, what):
    if hr < 0:
        raise KinectError(f"{what} fehlgeschlagen (HRESULT 0x{hr & 0xFFFFFFFF:08X})")
    return hr


def _method(index, *argtypes):
    proto = WINFUNCTYPE(c_long, c_void_p, *argtypes)

    def call(this, *args):
        vtbl = ctypes.cast(this, POINTER(POINTER(c_void_p)))[0]
        return proto(vtbl[index])(this, *args)

    return call


# IUnknown
_Release = _method(2)

# IKinectSensor
_Sensor_Open = _method(6)
_Sensor_Close = _method(7)
_Sensor_get_IsAvailable = _method(9, POINTER(c_ubyte))
_Sensor_get_ColorFrameSource = _method(10, POINTER(c_void_p))
_Sensor_get_DepthFrameSource = _method(11, POINTER(c_void_p))

# IColorFrameSource / IDepthFrameSource
_ColorSource_OpenReader = _method(7, POINTER(c_void_p))
_ColorSource_CreateFrameDescription = _method(8, c_int, POINTER(c_void_p))
_DepthSource_OpenReader = _method(7, POINTER(c_void_p))
_DepthSource_get_DepthMinReliableDistance = _method(8, POINTER(c_ushort))
_DepthSource_get_DepthMaxReliableDistance = _method(9, POINTER(c_ushort))
_DepthSource_get_FrameDescription = _method(10, POINTER(c_void_p))

# IColorFrameReader / IDepthFrameReader
_Reader_AcquireLatestFrame = _method(6, POINTER(c_void_p))

# IColorFrame
_ColorFrame_get_RawColorImageFormat = _method(3, POINTER(c_int))
_ColorFrame_AccessRawUnderlyingBuffer = _method(6, POINTER(c_uint), POINTER(POINTER(c_ubyte)))
_ColorFrame_CopyConvertedFrameDataToArray = _method(7, c_uint, POINTER(c_ubyte), c_int)

# IDepthFrame
_DepthFrame_CopyFrameDataToArray = _method(3, c_uint, POINTER(c_ushort))

# IFrameDescription
_Desc_get_Width = _method(3, POINTER(c_int))
_Desc_get_Height = _method(4, POINTER(c_int))
_Desc_get_HorizontalFieldOfView = _method(5, POINTER(c_float))
_Desc_get_VerticalFieldOfView = _method(6, POINTER(c_float))


class _Com:
    """Owns one reference to a COM-style interface pointer."""

    def __init__(self, ptr):
        self.ptr = ptr.value if isinstance(ptr, c_void_p) else ptr

    def release(self):
        if self.ptr:
            _Release(self.ptr)
            self.ptr = None

    def __del__(self):
        try:
            self.release()
        except Exception:  # interpreter shutdown
            pass


def _get(fn, this, ctype, what):
    value = ctype()
    _check(fn(this, byref(value)), what)
    return value.value


def _frame_description(desc_ptr):
    desc = _Com(desc_ptr)
    try:
        return (
            _get(_Desc_get_Width, desc.ptr, c_int, "IFrameDescription::get_Width"),
            _get(_Desc_get_Height, desc.ptr, c_int, "IFrameDescription::get_Height"),
            _get(_Desc_get_HorizontalFieldOfView, desc.ptr, c_float, "IFrameDescription::get_HorizontalFieldOfView"),
            _get(_Desc_get_VerticalFieldOfView, desc.ptr, c_float, "IFrameDescription::get_VerticalFieldOfView"),
        )
    finally:
        desc.release()


def _load_runtime():
    try:
        return ctypes.WinDLL("Kinect20.dll")
    except OSError as e:
        raise KinectError(
            "Kinect20.dll nicht gefunden - ist die Kinect for Windows Runtime/SDK 2.0 installiert?"
        ) from e


class ColorReader:
    """Delivers the newest color frame as a BGR uint8 array (height, width, 3)."""

    def __init__(self, sensor_ptr):
        source = _Com(_get(_Sensor_get_ColorFrameSource, sensor_ptr, c_void_p, "get_ColorFrameSource"))
        try:
            desc = c_void_p()
            _check(
                _ColorSource_CreateFrameDescription(source.ptr, COLOR_IMAGE_FORMAT_BGRA, byref(desc)),
                "IColorFrameSource::CreateFrameDescription",
            )
            self.width, self.height, self.hfov, self.vfov = _frame_description(desc)
            self._reader = _Com(_get(_ColorSource_OpenReader, source.ptr, c_void_p, "IColorFrameSource::OpenReader"))
        finally:
            source.release()

    def latest(self):
        """Return a new frame, or None if none arrived since the last call."""
        frame_ptr = c_void_p()
        hr = _Reader_AcquireLatestFrame(self._reader.ptr, byref(frame_ptr))
        if hr == E_PENDING:
            return None
        _check(hr, "IColorFrameReader::AcquireLatestFrame")
        frame = _Com(frame_ptr)
        try:
            raw_format = _get(_ColorFrame_get_RawColorImageFormat, frame.ptr, c_int, "get_RawColorImageFormat")
            if raw_format == COLOR_IMAGE_FORMAT_YUY2:
                # Convert the raw YUY2 buffer ourselves; OpenCV is faster than the SDK's conversion.
                size, buf = c_uint(), POINTER(c_ubyte)()
                _check(
                    _ColorFrame_AccessRawUnderlyingBuffer(frame.ptr, byref(size), byref(buf)),
                    "IColorFrame::AccessRawUnderlyingBuffer",
                )
                if size.value != self.width * self.height * 2:
                    raise KinectError(f"unerwartete YUY2-Puffergröße {size.value}")
                yuy2 = np.ctypeslib.as_array(buf, shape=(self.height, self.width, 2))
                return cv2.cvtColor(yuy2, cv2.COLOR_YUV2BGR_YUY2)  # copies before the frame is released
            bgra = np.empty((self.height, self.width, 4), np.uint8)
            _check(
                _ColorFrame_CopyConvertedFrameDataToArray(
                    frame.ptr, bgra.nbytes, bgra.ctypes.data_as(POINTER(c_ubyte)), COLOR_IMAGE_FORMAT_BGRA
                ),
                "IColorFrame::CopyConvertedFrameDataToArray",
            )
            return cv2.cvtColor(bgra, cv2.COLOR_BGRA2BGR)
        finally:
            frame.release()

    def close(self):
        self._reader.release()


class DepthReader:
    """Delivers the newest depth frame as uint16 millimetres (height, width); 0 = no measurement."""

    def __init__(self, sensor_ptr):
        source = _Com(_get(_Sensor_get_DepthFrameSource, sensor_ptr, c_void_p, "get_DepthFrameSource"))
        try:
            self.width, self.height, self.hfov, self.vfov = _frame_description(
                _get(_DepthSource_get_FrameDescription, source.ptr, c_void_p, "IDepthFrameSource::get_FrameDescription")
            )
            self.min_reliable_mm = _get(_DepthSource_get_DepthMinReliableDistance, source.ptr, c_ushort, "get_DepthMinReliableDistance")
            self.max_reliable_mm = _get(_DepthSource_get_DepthMaxReliableDistance, source.ptr, c_ushort, "get_DepthMaxReliableDistance")
            self._reader = _Com(_get(_DepthSource_OpenReader, source.ptr, c_void_p, "IDepthFrameSource::OpenReader"))
        finally:
            source.release()

    def latest(self):
        """Return a new frame, or None if none arrived since the last call."""
        frame_ptr = c_void_p()
        hr = _Reader_AcquireLatestFrame(self._reader.ptr, byref(frame_ptr))
        if hr == E_PENDING:
            return None
        _check(hr, "IDepthFrameReader::AcquireLatestFrame")
        frame = _Com(frame_ptr)
        try:
            out = np.empty((self.height, self.width), np.uint16)
            _check(
                _DepthFrame_CopyFrameDataToArray(frame.ptr, out.size, out.ctypes.data_as(POINTER(c_ushort))),
                "IDepthFrame::CopyFrameDataToArray",
            )
            return out
        finally:
            frame.release()

    def close(self):
        self._reader.release()


class KinectSensor:
    """The default Kinect v2. Opening succeeds even when no sensor is plugged in;
    readers simply start delivering frames once `is_available` turns True."""

    def __init__(self):
        ctypes.windll.ole32.CoInitializeEx(None, 2)  # COINIT_APARTMENTTHREADED; ignore "already initialized"
        runtime = _load_runtime()
        runtime.GetDefaultKinectSensor.argtypes = [POINTER(c_void_p)]
        runtime.GetDefaultKinectSensor.restype = c_long
        ptr = c_void_p()
        _check(runtime.GetDefaultKinectSensor(byref(ptr)), "GetDefaultKinectSensor")
        self._sensor = _Com(ptr)
        _check(_Sensor_Open(self._sensor.ptr), "IKinectSensor::Open")
        self._readers = []

    @property
    def is_available(self):
        return bool(_get(_Sensor_get_IsAvailable, self._sensor.ptr, c_ubyte, "get_IsAvailable"))

    def open_color_reader(self):
        reader = ColorReader(self._sensor.ptr)
        self._readers.append(reader)
        return reader

    def open_depth_reader(self):
        reader = DepthReader(self._sensor.ptr)
        self._readers.append(reader)
        return reader

    def close(self):
        for reader in self._readers:
            reader.close()
        self._readers.clear()
        if self._sensor.ptr:
            _Sensor_Close(self._sensor.ptr)
            self._sensor.release()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
