//! Fixed facts about the Kinect v2 (Xbox One Kinect / Kinect for Windows v2).

/// Width of the depth and infrared images.
pub const WIDTH: usize = 512;
/// Height of the depth and infrared images.
pub const HEIGHT: usize = 424;
/// Pixels of the depth and infrared images.
pub const PIXELS: usize = WIDTH * HEIGHT;

/// A raw depth packet has 10 sub-images: three phase steps for each of the three modulation
/// frequencies (sub-images 0-2, 3-5, 6-8) and one more (9) that the classic decoding ignores.
pub const SUBIMAGES: usize = 10;
/// Sub-images that carry the phase measurements.
pub const PHASE_SUBIMAGES: usize = 9;
/// Each sample is 11 bits.
pub const SUBIMAGE_BYTES: usize = PIXELS * 11 / 8;
/// u16 words of one packed row (512 samples of 11 bits).
pub const ROW_WORDS: usize = WIDTH * 11 / 16;
/// Bytes of one packed row.
pub const ROW_BYTES: usize = ROW_WORDS * 2;
/// Bytes of a whole raw depth packet.
pub const PACKET_BYTES: usize = SUBIMAGE_BYTES * SUBIMAGES;
/// All sub-images present.
pub const ALL_SUBIMAGES: u16 = (1 << SUBIMAGES) - 1;
/// Footer the device appends to each sub-image on the wire.
pub const SUBPACKET_FOOTER_BYTES: usize = 152;

/// Modulation frequencies as multiples of the 8 MHz base: 80, 16 and 120 MHz, in the order of
/// the sub-images.
pub const FREQ_MULTIPLES: [u32; 3] = [10, 2, 15];
/// Modulation frequencies in MHz, for display.
pub const FREQ_MHZ: [u32; 3] = [80, 16, 120];
/// The range in which all three frequencies are unambiguous together (half the wavelength of
/// the 8 MHz base frequency), in mm, as the device's calibration uses it.
pub const UNAMBIGUOUS_RANGE_MM: f32 = 18750.0;

/// The sample value that marks a saturated pixel (decoded through the 11-to-16-bit table).
pub const SATURATED: f32 = 32767.0;
/// The 11-bit code that marks a saturated pixel.
pub const SATURATED_CODE: u16 = 1024;

/// USB ids.
pub const VENDOR_ID: u16 = 0x045E;
/// The retail Kinect v2.
pub const PRODUCT_ID: u16 = 0x02D8;
/// The developer preview.
pub const PRODUCT_ID_PREVIEW: u16 = 0x02C4;

/// Interface 0: control and color; interface 1: depth (isochronous).
pub const CONTROL_INTERFACE: u8 = 0;
/// See [`CONTROL_INTERFACE`].
pub const DEPTH_INTERFACE: u8 = 1;
/// Commands go out here.
pub const CONTROL_OUT: u8 = 0x02;
/// Command responses come in here.
pub const CONTROL_IN: u8 = 0x81;
/// JPEG color frames (bulk).
pub const COLOR_IN: u8 = 0x83;
/// Raw depth packets (isochronous).
pub const DEPTH_IN: u8 = 0x84;
/// The smallest isochronous packet size that carries the depth stream (SuperSpeed only).
pub const MIN_DEPTH_ISO_PACKET: usize = 0x8400;

/// Color image size (JPEG).
pub const COLOR_WIDTH: usize = 1920;
/// See [`COLOR_WIDTH`].
pub const COLOR_HEIGHT: usize = 1080;
