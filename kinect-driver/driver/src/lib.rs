//! # kinect-driver
//!
//! A lightweight Kinect v2 driver that does not crash.
//!
//! - **USB** through libusb on Windows (libusbK, WinUSB or UsbDk), Linux and macOS, forgiving
//!   with weak USB controllers: lost packets are patched or the frame is delivered with the
//!   frequencies that arrived, a stalled stream restarts itself, an unplugged sensor is picked up
//!   again when it returns.
//! - **Depth and infrared** from the raw time-of-flight data, on the CPU (SIMD, a few threads) or
//!   the GPU (wgpu compute shaders), in two modes: `Compat` (the method of libfreenect2 /
//!   fn2/fast_depth.cpp) and `Extended`: depth over the whole unambiguous range of 18.75 m,
//!   close objects despite saturation (a saturated frequency is rebuilt from its other phases or
//!   left out), and an HDR infrared image instead of a clipped one.
//! - **Pipelines** of stages that can be configured and extended with your own.
//! - Works as a library or as the standalone program `kinect-driver` (also a drop-in capture
//!   worker for kinect-hub).
//!
//! Nothing here panics on purpose; the crate denies `unwrap`, `expect`, `panic!` and unchecked
//! indexing, and catches panics at every thread and stage boundary.

#![deny(unsafe_code)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic))]

pub mod camera;
pub mod consts;
pub mod device;
pub mod driver;
pub mod error;
pub mod frame;
pub mod packet;
pub mod pipeline;
pub mod protocol;
pub mod record;
pub mod sim;
pub mod stages;
pub mod tables;
pub mod tof;
pub mod usb;

pub use camera::{ColorCameraParams, DeviceIdentity, IrCameraParams};
pub use driver::{Driver, DriverConfig, DriverState, Event, Source};
pub use error::{Error, Result};
pub use frame::Frame;
pub use pipeline::{Backend, Pipeline, Stage};
pub use packet::RawDepthPacket;
pub use tables::DeviceTables;
pub use tof::{CpuDecoder, TofConfig, TofMode, TofOutput};
