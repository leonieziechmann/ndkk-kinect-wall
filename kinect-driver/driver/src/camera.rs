//! Camera parameters and device identity as the Kinect reports them.

/// Intrinsics and distortion of the depth/IR camera (read from the device, page 3).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IrCameraParams {
    /// focal length x, pixels
    pub fx: f32,
    /// focal length y, pixels
    pub fy: f32,
    /// principal point x, pixels
    pub cx: f32,
    /// principal point y, pixels
    pub cy: f32,
    /// radial distortion
    pub k1: f32,
    /// radial distortion
    pub k2: f32,
    /// radial distortion
    pub k3: f32,
    /// tangential distortion (always 0 so far)
    pub p1: f32,
    /// tangential distortion (always 0 so far)
    pub p2: f32,
}

impl IrCameraParams {
    /// Typical values of a Kinect v2, for the simulator and as a last resort.
    pub const TYPICAL: IrCameraParams = IrCameraParams {
        fx: 365.456,
        fy: 365.456,
        cx: 254.878,
        cy: 205.395,
        k1: 0.090_547_4,
        k2: -0.268_19,
        k3: 0.095_086_2,
        p1: 0.0,
        p2: 0.0,
    };

    /// Plausibility check: anything else would produce NaN tables or nonsense geometry.
    pub fn validate(&self) -> Result<(), String> {
        let all = [self.fx, self.fy, self.cx, self.cy, self.k1, self.k2, self.k3, self.p1, self.p2];
        if all.iter().any(|v| !v.is_finite()) {
            return Err(format!("non-finite camera parameters {self:?}"));
        }
        if !(100.0..=1000.0).contains(&self.fx) || !(100.0..=1000.0).contains(&self.fy) {
            return Err(format!("implausible focal length {} / {}", self.fx, self.fy));
        }
        if !(0.0..=512.0).contains(&self.cx) || !(0.0..=424.0).contains(&self.cy) {
            return Err(format!("implausible principal point {} / {}", self.cx, self.cy));
        }
        if [self.k1, self.k2, self.k3, self.p1, self.p2].iter().any(|k| k.abs() > 10.0) {
            return Err("implausible distortion coefficients".to_string());
        }
        Ok(())
    }
}

/// Color camera parameters and the depth-to-color mapping polynomial (page 4).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ColorCameraParams {
    /// focal length x, pixels
    pub fx: f32,
    /// focal length y, pixels
    pub fy: f32,
    /// principal point x
    pub cx: f32,
    /// principal point y
    pub cy: f32,
    /// depth shift for the mapping
    pub shift_d: f32,
    /// depth shift for the mapping
    pub shift_m: f32,
    /// x mapping polynomial: x3y0, x0y3, x2y1, x1y2, x2y0, x0y2, x1y1, x1y0, x0y1, x0y0
    pub mx: [f32; 10],
    /// y mapping polynomial, same order
    pub my: [f32; 10],
}

/// Who the device is.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct DeviceIdentity {
    /// serial number as the device reports it
    pub serial: String,
    /// main firmware version, e.g. "2.3.7697.0"
    pub firmware: String,
    /// USB product id (0x02D8 retail, 0x02C4 preview)
    pub product_id: u16,
    /// "bus-port.port" or similar, for logs
    pub usb_path: String,
}
