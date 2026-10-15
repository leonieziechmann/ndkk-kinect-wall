//! Configuration of the depth/IR decoding.

/// Which method decodes depth and infrared.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TofMode {
    /// libfreenect2's method (as fn2/fast_depth.cpp): saturated pixels have no depth, depth only
    /// within `min_depth..max_depth` (default 0.5-4.5 m), infrared clipped at 65535.
    Compat,
    /// Depth over the whole unambiguous range (up to 18.75 m) with a confidence per pixel; a
    /// saturated phase sample is rebuilt from the other two, a frequency that cannot be used is
    /// left out (fewer frequencies, the neighbors decide ambiguous cases); infrared as HDR from all
    /// usable frequencies, clipped areas filled smoothly.
    Extended,
}

/// libfreenect2's depth parameters (`DepthPacketProcessor::Parameters`, same defaults).
#[derive(Clone, Debug, PartialEq)]
pub struct Lf2Params {
    /// amplitude scale
    pub ab_multiplier: f32,
    /// per-frequency amplitude scale (normalizes the three frequencies)
    pub ab_multiplier_per_frq: [f32; 3],
    /// infrared output scale
    pub ab_output_multiplier: f32,
    /// phase steps of the three samples
    pub phase_in_rad: [f32; 3],
    /// bilateral filter: amplitude below which a pixel is "weak"
    pub joint_bilateral_ab_threshold: f32,
    /// bilateral filter: phase dissimilarity that marks an edge
    pub joint_bilateral_max_edge: f32,
    /// bilateral filter: sharpness of the phase similarity weight
    pub joint_bilateral_exp: f32,
    /// bilateral filter: 3 x 3 spatial weights
    pub gaussian_kernel: [f32; 9],
    /// added to the final phase
    pub phase_offset: f32,
    /// mm per phase unit
    pub unambiguous_dist: f32,
    /// smallest amplitude of every frequency
    pub individual_ab_threshold: f32,
    /// smallest sum of the amplitudes
    pub ab_threshold: f32,
    /// unwrapping confidence model
    pub ab_confidence_slope: f32,
    /// unwrapping confidence model
    pub ab_confidence_offset: f32,
    /// unwrapping confidence model
    pub min_dealias_confidence: f32,
    /// unwrapping confidence model
    pub max_dealias_confidence: f32,
    /// edge filter
    pub edge_ab_avg_min_value: f32,
    /// edge filter
    pub edge_ab_std_dev_threshold: f32,
    /// edge filter, mm
    pub edge_close_delta_threshold: f32,
    /// edge filter, mm
    pub edge_far_delta_threshold: f32,
    /// edge filter, mm
    pub edge_max_delta_threshold: f32,
    /// edge filter, mm
    pub edge_avg_delta_threshold: f32,
    /// edge filter
    pub max_edge_count: f32,
}

impl Default for Lf2Params {
    fn default() -> Self {
        Lf2Params {
            ab_multiplier: 0.666_666_7,
            ab_multiplier_per_frq: [1.322581, 1.0, 1.612903],
            ab_output_multiplier: 16.0,
            phase_in_rad: [0.0, 2.094395, 4.18879],
            joint_bilateral_ab_threshold: 3.0,
            joint_bilateral_max_edge: 2.5,
            joint_bilateral_exp: 5.0,
            gaussian_kernel: [0.1069973, 0.1131098, 0.1069973, 0.1131098, 0.1195716, 0.1131098, 0.1069973, 0.1131098, 0.1069973],
            phase_offset: 0.0,
            unambiguous_dist: 2083.333,
            individual_ab_threshold: 3.0,
            ab_threshold: 10.0,
            ab_confidence_slope: -0.533_057_8,
            ab_confidence_offset: 0.769_489_4,
            min_dealias_confidence: 0.349_065_9,
            max_dealias_confidence: 0.610_865_3,
            edge_ab_avg_min_value: 50.0,
            edge_ab_std_dev_threshold: 0.05,
            edge_close_delta_threshold: 50.0,
            edge_far_delta_threshold: 30.0,
            edge_max_delta_threshold: 100.0,
            edge_avg_delta_threshold: 0.0,
            max_edge_count: 5.0,
        }
    }
}

/// Parameters of the extended mode.
#[derive(Clone, Debug, PartialEq)]
pub struct ExtendedParams {
    /// rebuild one saturated phase sample of a frequency from the other two
    pub repair_saturation: bool,
    /// ... only if the rebuilt sample is at least this fraction of the largest other one (a
    /// saturated sample is the brightest of the three)
    pub repair_min_ratio: f32,
    /// samples at the largest code (+-16320) count as saturated too
    pub full_scale_is_saturated: bool,
    /// rebuild a phase sub-image lost on the USB from the other two of its frequency (instead of
    /// dropping the frequency where it is missing)
    pub repair_lost: bool,
    /// phase noise times amplitude per frequency (radians * IR amplitude units): the noise
    /// model that weights the frequencies (from the KDE paper's fit of a real Kinect v2)
    pub noise_coeff: [f32; 3],
    /// phase noise that never goes away (calibration, multipath), radians
    pub noise_floor: f32,
    /// scale of the noise model (larger = more tolerant)
    pub noise_scale: f32,
    /// a frequency weaker than this (IR amplitude units) is ignored
    pub min_amplitude: f32,
    /// depth with lower confidence is dropped (0..1)
    pub min_confidence: f32,
    /// pixels whose frequencies leave several distances open take the one their neighbors agree on
    pub spatial_resolve: bool,
    /// radius of that neighborhood, pixels
    pub spatial_radius: usize,
    /// saturated pixels with a single usable frequency are assumed nearer than this, mm, when
    /// the neighbors do not decide (saturation means close and bright)
    pub near_prior_mm: f32,
    /// the edge filter's thresholds grow with the depth beyond this, mm
    pub edge_scale_mm: f32,
    /// weight of a rebuilt frequency in the HDR infrared
    pub hdr_repaired_weight: f32,
    /// fill infrared where every frequency saturated, from the surroundings
    pub ir_fill_clipped: bool,
    /// brightness factor of filled infrared over its surroundings
    pub ir_fill_gain: f32,
    /// correction of the amplitude of each frequency (from `kinect-driver analyze`)
    pub gain_correction: [f32; 3],
    /// average weak pixels over 5 x 5 neighbors (where the phase agrees) before unwrapping: a
    /// little more range at less resolution far away (off by default: about 1 % more pixels for
    /// a third more decoding time)
    pub weak_boost: bool,
    /// amplitude (IR units) below which a pixel counts as weak for `weak_boost`
    pub weak_threshold: f32,
    /// rule out candidate distances at which the measured brightness would need an impossible
    /// reflectivity (a bright pixel cannot be 4 m away unless it is a reflector; a faint one is
    /// rather an echo from beyond the unambiguous range than a black wall nearby)
    pub plausibility: bool,
    /// infrared (libfreenect2 scale) of a white surface (albedo 1) facing the camera at 1 m;
    /// `kinect-driver analyze` estimates it for a device
    pub brightness_1m: f32,
    /// largest plausible reflectivity (1 = white paper; reflectors are brighter)
    pub max_reflectivity: f32,
    /// how much a candidate distance costs that needs a reflectivity outside [min_reflectivity,
    /// max_reflectivity]: 1 (chi-square unit) at this factor beyond, 4 at its square, 9 at its
    /// cube (glossy paint seen head-on reflects a few times more than white paper; a phantom ten
    /// times farther away than the surface would need a hundred times more)
    pub plausibility_spread: f32,
    /// the illumination of the Kinect (light source and lens) is nearly even in the middle of
    /// the image and falls off steeply towards the edges: to half at this angle off the axis,
    /// degrees (relative illumination 1 / (1 + (tan angle / tan this)^steepness));
    /// `brightness_1m` is the value on the axis. `kinect-driver analyze` estimates both
    pub illumination_angle: f32,
    /// how steeply the illumination falls off beyond `illumination_angle` (0 = even everywhere)
    pub illumination_steepness: f32,
    /// smallest plausible reflectivity
    pub min_reflectivity: f32,
    /// drop depth pixels without enough neighbors at a similar depth (isolated noise)
    pub speckle_filter: bool,
    /// ... neighbors (of 24 in a 5 x 5 window) that must agree
    pub speckle_min_neighbors: u32,
    /// inside an area where every frequency saturated, interpolate the depth from the measured
    /// rim of the same bright object (flag DEPTH_FILLED); otherwise those pixels have no depth
    pub fill_saturated_depth: bool,
    /// lower the confidence where the amplitudes of the frequencies do not fit a single echo
    /// (flag MULTIPATH): light that reached the pixel on two paths, as on a grazing table top,
    /// adds up to phases that can look like a consistent distance far beyond the room
    pub multipath_check: bool,
    /// relative spread of the amplitude ratios of a single echo beyond the noise (pixel to
    /// pixel differences of the gains)
    pub amplitude_floor: f32,
    /// how far (chi-square units) the amplitudes may miss a single echo before the confidence
    /// drops: a weak second echo (light from the wall on the floor) moves the distance by a few
    /// centimeters, a strong one (a mirror image on a glossy floor, a grazing table top) makes it
    /// neither distance. Where the best distance would need an implausible brightness, nothing is
    /// tolerated
    pub multipath_tolerance: f32,
    /// split pixels that one echo does not explain into two echoes and report the first, nearer
    /// one (flag SECOND_ECHO): a glossy floor under the mirror image in it, a grazing table top,
    /// a depth edge
    pub two_echoes: bool,
    /// the two-echo split on the CPU: a pixel whose input has not moved beyond the noise since its
    /// last split takes that split over instead of splitting again (every pixel is split again at
    /// least every 16 frames, in turn). Most of a scene stands still: the split then costs a
    /// fraction, and the depth flickers less
    pub split_reuse: bool,
    /// relative spread of the amplitudes of the frequencies in the two-echo split: the amplitude
    /// ratios are what tells two echoes from one (at 80 MHz a floor and its mirror image nearly
    /// cancel), so tighter than `amplitude_floor`
    pub echo_amplitude_floor: f32,
    /// how much stricter the brightness prior of the two-echo split is than the unwrapping's
    /// (a factor on the penalty): with two echoes, six numbers and four unknowns, an alias far
    /// away (16 and 80 MHz repeat after half the range) fits almost as well as the real pair,
    /// and the brightness has to decide
    pub echo_plausibility: f32,
    /// how much lower (chi-square units) the cost of the best distance must be than that of the
    /// second best before the unwrapping is more sure of it than of the other: the noise model
    /// knows only noise, and the errors it does not know (multipath, stray light) now and then
    /// let a wrong distance win by a few units (0 = trust the model)
    pub margin_prior: f32,
}

impl Default for ExtendedParams {
    fn default() -> Self {
        ExtendedParams {
            repair_saturation: true,
            repair_min_ratio: 0.6,
            full_scale_is_saturated: true,
            repair_lost: true,
            noise_coeff: [3.0, 2.5, 3.5],
            noise_floor: 0.04,
            noise_scale: 1.0,
            min_amplitude: 0.5,
            min_confidence: 0.6,
            spatial_resolve: true,
            spatial_radius: 3,
            near_prior_mm: 1200.0,
            edge_scale_mm: 2500.0,
            hdr_repaired_weight: 0.5,
            ir_fill_clipped: true,
            ir_fill_gain: 1.1,
            gain_correction: [1.0; 3],
            weak_boost: false,
            weak_threshold: 6.0,
            plausibility: true,
            brightness_1m: 25000.0,
            max_reflectivity: 1.5,
            plausibility_spread: 1.15,
            illumination_angle: 31.0,
            illumination_steepness: 7.0,
            min_reflectivity: 0.002,
            speckle_filter: true,
            speckle_min_neighbors: 3,
            fill_saturated_depth: true,
            multipath_check: true,
            amplitude_floor: 0.15,
            multipath_tolerance: 10.0,
            two_echoes: false,
            split_reuse: true,
            echo_amplitude_floor: 0.06,
            echo_plausibility: 16.0,
            margin_prior: 10.0,
        }
    }
}

/// Everything about the decoding.
#[derive(Clone, Debug, PartialEq)]
pub struct TofConfig {
    /// the method
    pub mode: TofMode,
    /// libfreenect2's parameters (used by both modes)
    pub params: Lf2Params,
    /// parameters of the extended mode
    pub ext: ExtendedParams,
    /// nearest depth reported, mm
    pub min_depth: f32,
    /// farthest depth reported, mm
    pub max_depth: f32,
    /// libfreenect2's joint bilateral filter on the phases
    pub bilateral_filter: bool,
    /// libfreenect2's edge-aware filter against flying pixels
    pub edge_filter: bool,
    /// threads for the CPU decoder (0 = automatic)
    pub threads: usize,
}

impl TofConfig {
    /// libfreenect2's method and defaults (0.5-4.5 m).
    pub fn compat() -> TofConfig {
        TofConfig {
            mode: TofMode::Compat,
            params: Lf2Params::default(),
            ext: ExtendedParams::default(),
            min_depth: 500.0,
            max_depth: 4500.0,
            bilateral_filter: true,
            edge_filter: true,
            threads: 0,
        }
    }

    /// The extended method over the whole range (0.1-18.75 m).
    pub fn extended() -> TofConfig {
        TofConfig { mode: TofMode::Extended, min_depth: 100.0, max_depth: crate::consts::UNAMBIGUOUS_RANGE_MM, ..TofConfig::compat() }
    }

    /// Checks the values.
    pub fn validate(&self) -> crate::Result<()> {
        let bad = |m: &str| Err(crate::Error::config(m.to_string()));
        if !(self.min_depth >= 0.0 && self.max_depth > self.min_depth) {
            return bad("min_depth must be >= 0 and below max_depth");
        }
        let p = &self.params;
        let positive = |v: f32| v.is_finite() && v > 0.0;
        if !p.ab_multiplier_per_frq.iter().all(|m| positive(*m)) || !positive(p.ab_multiplier) {
            return bad("amplitude multipliers must be positive");
        }
        let e = &self.ext;
        if !e.noise_coeff.iter().all(|c| positive(*c)) || !positive(e.noise_scale) {
            return bad("noise model must be positive");
        }
        if !(0.0..=1.0).contains(&e.min_confidence) {
            return bad("min_confidence must be within 0..1");
        }
        if e.gain_correction.iter().any(|g| !(g.is_finite() && *g > 0.0)) {
            return bad("gain_correction must be positive");
        }
        if e.spatial_radius > 16 {
            return bad("spatial_radius must be at most 16");
        }
        if !positive(e.brightness_1m) || e.max_reflectivity.partial_cmp(&e.min_reflectivity) != Some(std::cmp::Ordering::Greater) || e.min_reflectivity < 0.0 {
            return bad("brightness_1m must be positive and min_reflectivity < max_reflectivity");
        }
        if !(e.plausibility_spread > 1.0 && e.plausibility_spread.is_finite()) {
            return bad("plausibility_spread must be above 1");
        }
        if !(5.0..=80.0).contains(&e.illumination_angle) || !(0.0..=30.0).contains(&e.illumination_steepness) {
            return bad("illumination_angle must be within 5..80 degrees, illumination_steepness within 0..30");
        }
        if e.speckle_min_neighbors > 24 {
            return bad("speckle_min_neighbors must be at most 24");
        }
        Ok(())
    }

    /// Sets one value by name (`mode`, `min_depth`, `max_depth`, `threads`, `bilateral_filter`,
    /// `edge_filter`, or any field of [`ExtendedParams`]). For command lines and environment
    /// variables: `kinect-driver ... --tof min_confidence=0.7,weak_boost=false`. Call
    /// [`TofConfig::validate`] afterwards ([`TofConfig::apply`] does).
    pub fn set(&mut self, key: &str, value: &str) -> crate::Result<()> {
        let f = || value.trim().parse::<f32>().map_err(|_| crate::Error::config(format!("{key}: {value:?} is not a number")));
        let b = || match value.trim() {
            "1" | "true" | "on" | "yes" => Ok(true),
            "0" | "false" | "off" | "no" => Ok(false),
            _ => Err(crate::Error::config(format!("{key}: {value:?} is not on/off"))),
        };
        let triple = || -> crate::Result<[f32; 3]> {
            let v: Vec<f32> = value.split([':', '/']).map(|p| p.trim().parse::<f32>()).collect::<std::result::Result<_, _>>().map_err(|_| crate::Error::config(format!("{key}: expected a:b:c")))?;
            <[f32; 3]>::try_from(v).map_err(|_| crate::Error::config(format!("{key}: expected three values a:b:c")))
        };
        let e = &mut self.ext;
        match key.trim() {
            "mode" => {
                self.mode = match value.trim() {
                    "compat" | "libfreenect2" => TofMode::Compat,
                    "extended" | "ext" => TofMode::Extended,
                    _ => return Err(crate::Error::config(format!("mode: {value:?} (compat or extended)"))),
                }
            }
            "min_depth" => self.min_depth = f()?,
            "max_depth" => self.max_depth = f()?,
            "threads" => self.threads = f()? as usize,
            "bilateral_filter" => self.bilateral_filter = b()?,
            "edge_filter" => self.edge_filter = b()?,
            "repair_saturation" => e.repair_saturation = b()?,
            "repair_min_ratio" => e.repair_min_ratio = f()?,
            "full_scale_is_saturated" => e.full_scale_is_saturated = b()?,
            "repair_lost" => e.repair_lost = b()?,
            "noise_coeff" => e.noise_coeff = triple()?,
            "noise_floor" => e.noise_floor = f()?,
            "noise_scale" => e.noise_scale = f()?,
            "min_amplitude" => e.min_amplitude = f()?,
            "min_confidence" => e.min_confidence = f()?,
            "spatial_resolve" => e.spatial_resolve = b()?,
            "spatial_radius" => e.spatial_radius = f()? as usize,
            "near_prior_mm" => e.near_prior_mm = f()?,
            "edge_scale_mm" => e.edge_scale_mm = f()?,
            "hdr_repaired_weight" => e.hdr_repaired_weight = f()?,
            "ir_fill_clipped" => e.ir_fill_clipped = b()?,
            "ir_fill_gain" => e.ir_fill_gain = f()?,
            "gain_correction" => e.gain_correction = triple()?,
            "weak_boost" => e.weak_boost = b()?,
            "weak_threshold" => e.weak_threshold = f()?,
            "plausibility" => e.plausibility = b()?,
            "brightness_1m" => e.brightness_1m = f()?,
            "max_reflectivity" => e.max_reflectivity = f()?,
            "plausibility_spread" => e.plausibility_spread = f()?,
            "illumination_angle" => e.illumination_angle = f()?,
            "illumination_steepness" => e.illumination_steepness = f()?,
            "min_reflectivity" => e.min_reflectivity = f()?,
            "speckle_filter" => e.speckle_filter = b()?,
            "speckle_min_neighbors" => e.speckle_min_neighbors = f()? as u32,
            "fill_saturated_depth" => e.fill_saturated_depth = b()?,
            "multipath_check" => e.multipath_check = b()?,
            "amplitude_floor" => e.amplitude_floor = f()?,
            "multipath_tolerance" => e.multipath_tolerance = f()?,
            "two_echoes" => e.two_echoes = b()?,
            "split_reuse" => e.split_reuse = b()?,
            "echo_amplitude_floor" => e.echo_amplitude_floor = f()?,
            "echo_plausibility" => e.echo_plausibility = f()?,
            "margin_prior" => e.margin_prior = f()?,
            other => return Err(crate::Error::config(format!("unknown setting {other:?}"))),
        }
        Ok(())
    }

    /// Applies `key=value,key=value` (see [`TofConfig::set`]).
    pub fn apply(&mut self, settings: &str) -> crate::Result<()> {
        for kv in settings.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let (k, v) = kv.split_once('=').ok_or_else(|| crate::Error::config(format!("{kv:?}: expected key=value")))?;
            self.set(k, v)?;
        }
        self.validate()
    }
}

impl Default for TofConfig {
    fn default() -> Self {
        TofConfig::extended()
    }
}
