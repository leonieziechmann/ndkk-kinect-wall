//! Commands to the Kinect v2 and the "response complete" message that ends every answer.
//!
//! A command goes to bulk endpoint 0x02 as `magic | sequence | max_response | id | 0 | params`
//! (little-endian u32). If the command returns data, it comes from bulk endpoint 0x81 first; then
//! a 16-byte "response complete" with the sequence number ends the transaction. The command ids
//! and parameters are those libfreenect2 found (protocol/command.h); the LED and color settings
//! follow Microsoft's NuiSensor library.

use super::bytes::{PutLe, u32_at};

/// First word of every command.
pub const COMMAND_MAGIC: u32 = 0x0602_2009;
/// First word of the message that ends every transaction.
pub const RESPONSE_COMPLETE_MAGIC: u32 = 0x0A6F_E000;
/// Length of that message.
pub const RESPONSE_COMPLETE_LEN: usize = 16;

/// Command ids.
pub mod id {
    /// firmware versions of the subsystems
    pub const READ_FIRMWARE_VERSIONS: u32 = 0x02;
    /// before streaming
    pub const INIT_STREAMS: u32 = 0x09;
    /// observed in the stop sequence
    pub const STOP: u32 = 0x0A;
    /// hardware revision
    pub const READ_HARDWARE_INFO: u32 = 0x14;
    /// status words (0x090000 = sensor ready)
    pub const READ_STATUS: u32 = 0x16;
    /// serial number, camera parameters, P0 tables
    pub const READ_DATA_PAGE: u32 = 0x22;
    /// streaming on/off
    pub const SET_STREAMING: u32 = 0x2B;
    /// color camera settings
    pub const COLOR_SETTING: u32 = 0x3E;
    /// mode (also used for the LED)
    pub const SET_MODE: u32 = 0x4B;
    /// reboots the device (it drops off the bus for a few seconds)
    pub const SHUTDOWN: u32 = 0x00;
}

/// Pages of [`id::READ_DATA_PAGE`].
pub mod page {
    /// serial number (UTF-16)
    pub const SERIAL: u32 = 0x01;
    /// P0 phase tables (depth calibration)
    pub const P0_TABLES: u32 = 0x02;
    /// depth camera intrinsics and distortion
    pub const DEPTH_PARAMS: u32 = 0x03;
    /// color camera parameters and depth-to-color mapping
    pub const COLOR_PARAMS: u32 = 0x04;
}

/// The response buffer size libfreenect2 uses for the large data pages.
pub const LARGE_PAGE: u32 = 0x1C_0000;

/// One command. `min_response` is what the driver needs to make sense of the answer (shorter
/// answers are rejected; the device is allowed to send less than `max_response`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Command {
    /// for logs
    pub name: &'static str,
    /// command id
    pub id: u32,
    /// size of the data phase buffer; 0 = the command returns no data
    pub max_response: u32,
    /// shortest acceptable answer
    pub min_response: u32,
    /// parameters (0, 1 or 4 words)
    pub params: Vec<u32>,
    /// some commands always carry sequence 0 (LED, color settings)
    pub fixed_sequence: Option<u32>,
}

impl Command {
    fn new(name: &'static str, id: u32, max_response: u32, min_response: u32, params: Vec<u32>) -> Command {
        Command { name, id, max_response, min_response, params, fixed_sequence: None }
    }

    /// The bytes sent to endpoint 0x02.
    pub fn encode(&self, sequence: u32) -> Vec<u8> {
        let mut out = Vec::with_capacity(20 + 4 * self.params.len());
        out.put_u32(COMMAND_MAGIC);
        out.put_u32(self.fixed_sequence.unwrap_or(sequence));
        out.put_u32(self.max_response);
        out.put_u32(self.id);
        out.put_u32(0);
        for p in &self.params {
            out.put_u32(*p);
        }
        out
    }

    /// The sequence number the response complete must carry.
    pub fn sequence_for(&self, sequence: u32) -> u32 {
        self.fixed_sequence.unwrap_or(sequence)
    }

    /// Firmware versions of the subsystems (the main one is entry 3).
    pub fn read_firmware_versions() -> Command {
        Command::new("read firmware versions", id::READ_FIRMWARE_VERSIONS, 0x200, 16, vec![])
    }
    /// Hardware info (libfreenect2 reads it but does not use it).
    pub fn read_hardware_info() -> Command {
        Command::new("read hardware info", id::READ_HARDWARE_INFO, 0x5C, 0, vec![])
    }
    /// Serial number.
    pub fn read_serial() -> Command {
        Command::new("read serial number", id::READ_DATA_PAGE, 0x80, 2, vec![page::SERIAL])
    }
    /// The P0 phase tables (about 1.3 MB).
    pub fn read_p0_tables() -> Command {
        Command::new("read P0 tables", id::READ_DATA_PAGE, LARGE_PAGE, super::response::P0_TABLES_MIN_LEN as u32, vec![page::P0_TABLES])
    }
    /// Depth camera intrinsics and distortion.
    pub fn read_depth_params() -> Command {
        Command::new("read depth camera parameters", id::READ_DATA_PAGE, LARGE_PAGE, super::response::DEPTH_PARAMS_LEN as u32, vec![page::DEPTH_PARAMS])
    }
    /// Color camera parameters.
    pub fn read_color_params() -> Command {
        Command::new("read color camera parameters", id::READ_DATA_PAGE, LARGE_PAGE, super::response::COLOR_PARAMS_MIN_LEN as u32, vec![page::COLOR_PARAMS])
    }
    /// Status word 0x090000; bit 0 = the sensor is ready.
    pub fn read_status_090000() -> Command {
        Command::new("read status 0x090000", id::READ_STATUS, 4, 4, vec![0x0009_0000])
    }
    /// Prepares the streams.
    pub fn init_streams() -> Command {
        Command::new("init streams", id::INIT_STREAMS, 0, 0, vec![])
    }
    /// Streaming on or off.
    pub fn set_streaming(on: bool) -> Command {
        Command::new(if on { "streaming on" } else { "streaming off" }, id::SET_STREAMING, 0, 0, vec![u32::from(on)])
    }
    /// Mode disabled.
    pub fn set_mode_disabled() -> Command {
        Command::new("mode disabled", id::SET_MODE, 0, 0, vec![0, 0, 0, 0])
    }
    /// Mode enabled.
    pub fn set_mode_enabled() -> Command {
        Command::new("mode enabled", id::SET_MODE, 0, 0, vec![1, 0, 0, 0])
    }
    /// Mode enabled with 0x00640064 (part of the start and stop sequences).
    pub fn set_mode_enabled_0064() -> Command {
        Command::new("mode enabled 0x00640064", id::SET_MODE, 0, 0, vec![1, 0x0064_0064, 0, 0])
    }
    /// Stop (part of the stop sequence).
    pub fn stop() -> Command {
        Command::new("stop", id::STOP, 0, 0, vec![])
    }
    /// Reboots the device; it disappears from the bus for ~3 s.
    pub fn shutdown() -> Command {
        Command::new("shutdown (firmware reboot)", id::SHUTDOWN, 0, 0, vec![])
    }
    /// One of the two LEDs: `level` 0..=1000 constant, or blinking between `level` and
    /// `blink_to` every `interval_ms` ms.
    pub fn led(led: Led, level: u16, blink: Option<(u16, u32)>) -> Command {
        let led_id = match led {
            Led::Primary => 0u32,
            Led::Secondary => 1,
        };
        let (mode, stop, interval) = match blink {
            Some((to, ms)) => (1u32, u32::from(to.min(1000)), ms),
            None => (0, u32::from(level.min(1000)), 0),
        };
        let start = u32::from(level.min(1000));
        let mut c = Command::new("LED", id::SET_MODE, 0, 0, vec![led_id | (mode << 16), start | (stop << 16), interval, 0]);
        c.fixed_sequence = Some(0);
        c
    }
    /// A color camera setting (NUISENSOR_RGB_COMMAND_*), `value` as integer or float bits.
    pub fn color_setting(setting: u32, value: u32) -> Command {
        let mut c = Command::new("color setting", id::COLOR_SETTING, 16, 16, vec![1, 0, setting, value]);
        c.fixed_sequence = Some(0);
        c
    }
}

/// The two LEDs of the Kinect v2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Led {
    /// the white power LED on the front
    Primary,
    /// the second LED
    Secondary,
}

/// If `b` is a response-complete message, its sequence number.
pub fn response_complete_sequence(b: &[u8]) -> Option<u32> {
    if b.len() != RESPONSE_COMPLETE_LEN || u32_at(b, 0)? != RESPONSE_COMPLETE_MAGIC {
        return None;
    }
    u32_at(b, 4)
}

/// A response-complete message (for the simulated device).
pub fn encode_response_complete(sequence: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(RESPONSE_COMPLETE_LEN);
    out.put_u32(RESPONSE_COMPLETE_MAGIC);
    out.put_u32(sequence);
    out.put_u32(0);
    out.put_u32(0);
    out
}

/// A command as the device sees it (for the simulated device).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedCommand {
    /// sequence number
    pub sequence: u32,
    /// size of the data phase buffer
    pub max_response: u32,
    /// command id
    pub id: u32,
    /// parameters
    pub params: Vec<u32>,
}

/// Parses a command (the inverse of [`Command::encode`]).
pub fn decode_command(b: &[u8]) -> Option<DecodedCommand> {
    if b.len() < 20 || !b.len().is_multiple_of(4) || u32_at(b, 0)? != COMMAND_MAGIC {
        return None;
    }
    let params = (20..b.len()).step_by(4).filter_map(|at| u32_at(b, at)).collect();
    Some(DecodedCommand { sequence: u32_at(b, 4)?, max_response: u32_at(b, 8)?, id: u32_at(b, 12)?, params })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_matches_libfreenect2_layout() {
        let c = Command::read_status_090000();
        let b = c.encode(7);
        assert_eq!(b.len(), 24);
        assert_eq!(u32_at(&b, 0), Some(COMMAND_MAGIC));
        assert_eq!(u32_at(&b, 4), Some(7));
        assert_eq!(u32_at(&b, 8), Some(4));
        assert_eq!(u32_at(&b, 12), Some(0x16));
        assert_eq!(u32_at(&b, 16), Some(0));
        assert_eq!(u32_at(&b, 20), Some(0x0009_0000));
        let d = decode_command(&b).unwrap();
        assert_eq!(d.id, 0x16);
        assert_eq!(d.params, vec![0x0009_0000]);
    }

    #[test]
    fn mode_commands_have_four_params() {
        for c in [Command::set_mode_disabled(), Command::set_mode_enabled(), Command::set_mode_enabled_0064()] {
            assert_eq!(c.encode(0).len(), 36);
        }
        assert_eq!(Command::set_mode_enabled_0064().params, vec![1, 0x0064_0064, 0, 0]);
    }

    #[test]
    fn led_uses_sequence_zero() {
        let c = Command::led(Led::Primary, 0, None);
        assert_eq!(u32_at(&c.encode(99), 4), Some(0));
        assert_eq!(c.sequence_for(99), 0);
    }

    #[test]
    fn response_complete_roundtrip() {
        let b = encode_response_complete(42);
        assert_eq!(response_complete_sequence(&b), Some(42));
        assert_eq!(response_complete_sequence(&b[..15]), None);
        let mut bad = b.clone();
        bad[0] ^= 1;
        assert_eq!(response_complete_sequence(&bad), None);
    }
}
