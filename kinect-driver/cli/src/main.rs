//! `kinect-driver`: the Kinect v2 driver as a program. Without a command (or with `worker`) it is
//! the capture worker for kinect-hub; the other commands are tools.

#![deny(unsafe_code)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic))]

mod args;
mod opts;
mod tools;
mod worker;

use std::io::IsTerminal;

use args::Args;

const HELP: &str = "kinect-driver - a lightweight Kinect v2 driver

USAGE
  kinect-driver [worker] [OPTIONS]      capture worker for kinect-hub (binary protocol on stdout)
  kinect-driver list                    Kinects on the USB bus
  kinect-driver info [--save-calibration DIR]
                                        serial, firmware, camera parameters
  kinect-driver stream [OPTIONS] [--seconds N] [--png DIR]
                                        stream and print a line per second
  kinect-driver record --out FILE.k2raw [--seconds N]
                                        raw packets from the Kinect (shows the room: keep it private)
  kinect-driver replay FILE.k2raw|sim:SCENE [OPTIONS] [--frames N] [--every K] [--png DIR] [--compare]
                                        decode a recording; --compare: compat against extended
  kinect-driver bench [--source FILE.k2raw|sim:SCENE] [--frames N] [--backend cpu|gpu] [--threads N]
  kinect-driver simulate --out FILE.k2raw [--scene S] [--frames N]
  kinect-driver eval [--scenes a,b] [--frames N] [--backend cpu|gpu]
                                        both modes against the simulator's ground truth
  kinect-driver analyze FILE.k2raw [--frames N]
                                        calibration hints for a real sensor (brightness, gains, noise)

OPTIONS (worker, stream, replay)
  --mode extended|compat      extended (default): 0.1-18.75 m, saturation repair, HDR infrared;
                              compat: libfreenect2 (0.5-4.5 m)
  --backend cpu|gpu|auto      where the depth is decoded (--pipeline fast|cl as kinect-hub says)
  --tof key=value,...         decoding settings, e.g. min_confidence=0.7,weak_boost=on
  --ir hub|even|raw           infrared output: hub (worker default) as libfreenect2 up to 3000,
                              above it logarithmic, white only at 65535 (hub:KNEE:TOP sets both);
                              even also cancels the falloff with distance; raw = HDR
  --source SOURCE             SOURCES (default: kinect)
  --serial S                  which Kinect
  --led 0..1000               LED brightness after the start
  --calibration-cache DIR|off where each Kinect's calibration is cached
  --fast                      recordings: as fast as possible instead of 30 fps
  --loop                      recordings: start over at the end

The worker also reads KINECT_DRIVER_MODE, _TOF, _IR, _SOURCE, _BACKEND, _LED, _CACHE, _PRIORITY
(kinect-hub passes only --pipeline). RUST_LOG-style logging: KINECT_DRIVER_LOG=debug.
";

fn main() {
    let mut raw: Vec<String> = std::env::args().skip(1).collect();
    let command = match raw.first().map(String::as_str) {
        None if std::io::stdout().is_terminal() => "help".to_string(),
        None => "worker".to_string(),
        Some(a) if a.starts_with("--") && a != "--help" => "worker".to_string(),
        Some(_) => raw.remove(0),
    };
    init_log();
    let a = Args::new(raw);
    let result = match command.as_str() {
        "worker" => worker::run(a),
        "list" => tools::list(a),
        "info" => tools::info(a),
        "stream" => tools::stream(a),
        "record" => tools::record(a),
        "replay" => tools::replay(a),
        "bench" => tools::bench(a),
        "simulate" => tools::simulate(a),
        "eval" => tools::eval(a),
        "analyze" => tools::analyze(a),
        "help" | "--help" | "-h" => {
            print!("{}", HELP.replace("SOURCES", &tools::source_help()));
            Ok(())
        }
        "version" | "--version" | "-V" => {
            println!("kinect-driver {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        other => Err(format!("unknown command {other:?} (kinect-driver help)")),
    };
    if let Err(e) = result {
        eprintln!("kinect-driver: {e}");
        std::process::exit(1);
    }
}

/// Log lines on stderr (level from KINECT_DRIVER_LOG: error, warn, info, debug; default info).
fn init_log() {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::max_level()
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                eprintln!("{} {}: {}", r.level(), r.target(), r.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Stderr = Stderr;
    let level = match std::env::var("KINECT_DRIVER_LOG").as_deref() {
        Ok("error") => log::LevelFilter::Error,
        Ok("warn") => log::LevelFilter::Warn,
        Ok("debug") => log::LevelFilter::Debug,
        Ok("trace") => log::LevelFilter::Trace,
        Ok("off") => log::LevelFilter::Off,
        _ => log::LevelFilter::Info,
    };
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(level);
    }
}
