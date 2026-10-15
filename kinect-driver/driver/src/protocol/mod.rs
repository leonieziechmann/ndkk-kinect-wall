//! The Kinect v2 wire protocol, without any USB: commands, answers and the reassembly of the
//! depth and color streams. Pure functions and state machines that are fed bytes, so all of it
//! is testable without hardware and none of it can block or crash on malformed input.

pub mod bytes;
pub mod color_stream;
pub mod command;
pub mod depth_stream;
pub mod response;
