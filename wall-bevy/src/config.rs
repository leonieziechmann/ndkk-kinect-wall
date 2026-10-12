//! Command line and environment: where the hub and the wall's documents are, the control center.
//!
//!   wall-bevy                        the output on the LED screen (setup.output.window, else the
//!                                    first screen that is not the primary one), playing the show;
//!                                    the control center at http://127.0.0.1:8095/ and in the network
//!   --hub 8091 | host:port | URL     the kinect-hub (default KINECT_HUB, else 127.0.0.1:8090)
//!   --data DIR                       setup, projections, show, pairing code (default KINECT_WALL_DIR,
//!                                    else wall-bevy/data of the main checkout)
//!   --control-port N                 the control center's port (default 8095, 0: none)
//!   --control-bind IP                where it listens (default 0.0.0.0: the network too;
//!                                    127.0.0.1: only this computer)
//!   --control-dir DIR                the control center's files from DIR (work on the page)
//!   --scene NAME                     plays this scene instead of the show
//!   --windowed                       a normal window (testing), --monitor N|NAME a screen
//!   --screen X,Y,W,H                 the screen with this desktop rectangle (start-wand.ps1)
//!   --fps N                          caps the render rate
//!   --vsync fifo|mailbox|immediate   presentation (default fifo: steady, never tears)
//!   --shots DIR --seconds S          test: renders S seconds, writes PNGs and frame times to DIR
//!   --mute                           no sound
//!   --no-control                     no control center

use std::path::{Path, PathBuf};

#[derive(Clone, Debug, bevy::prelude::Resource)]
pub struct Config {
    /// http://host:port of the hub
    pub hub: String,
    /// the wall's documents (setup, projection, show), the scenes' store, the pairing code
    pub data_dir: PathBuf,
    /// where the documents were before (web/.cache/wall of the main checkout): taken over once
    pub legacy_dirs: Vec<PathBuf>,
    /// the control center's port (0: none)
    pub control_port: u16,
    pub control_bind: std::net::IpAddr,
    /// the control center's page from this folder instead of the built-in one
    pub control_dir: Option<PathBuf>,
    pub scene: Option<String>,
    pub windowed: bool,
    pub monitor: Option<String>,
    /// the output screen as start-wand.ps1 knows it: x, y, width, height (desktop pixels)
    pub screen: Option<[i32; 4]>,
    pub fps: f64,
    pub vsync: String,
    pub shots: Option<PathBuf>,
    pub seconds: Option<f64>,
    /// test mode: a shot every this many seconds
    pub shot_every: f64,
    pub mute: bool,
    pub no_control: bool,
    /// scene params for --scene: key=value pairs (numbers, true/false, #colors, text)
    pub params: Vec<(String, String)>,
    /// LED size for tests without a setup (--led 1008x336)
    pub led: Option<(u32, u32)>,
    /// --list-scenes: print every scene's declaration as JSON and end
    pub list_scenes: bool,
    /// --watch [DIR]: build the scenes when their sources change and swap them (DIR: the workspace, wall-bevy/)
    pub watch: Option<std::path::PathBuf>,
    /// --new-scene NAME: a new scene crate from the template (scenes/NAME), then end
    pub new_scene: Option<String>,
}

/// http://127.0.0.1:<port> from a port, host:port or URL (as hub.js does).
pub fn normalize_hub(raw: &str) -> String {
    let h = raw.trim();
    let h = if !h.is_empty() && h.chars().all(|c| c.is_ascii_digit()) {
        format!("http://127.0.0.1:{h}")
    } else if h.starts_with("http://") || h.starts_with("https://") {
        h.to_string()
    } else if h.starts_with("ws://") {
        h.replacen("ws://", "http://", 1).trim_end_matches("/ws").to_string()
    } else {
        format!("http://{h}")
    };
    h.trim_end_matches('/').to_string()
}

/// The checkout this program belongs to: the folder with .git above the exe (or the working folder).
fn checkout_top() -> Option<PathBuf> {
    let mut starts = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        starts.push(exe);
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for start in starts {
        let mut dir: Option<&Path> = Some(start.as_path());
        while let Some(d) = dir {
            if d.join(".git").exists() {
                return Some(d.to_path_buf());
            }
            dir = d.parent();
        }
    }
    None
}

/// The main checkout of a git worktree (the folder with the real .git directory).
fn main_checkout(top: &Path) -> PathBuf {
    let git = top.join(".git");
    if git.is_file()
        && let Ok(text) = std::fs::read_to_string(&git)
        && let Some(dir) = text.trim().strip_prefix("gitdir:")
    {
        // <main>/.git/worktrees/<name>
        let p = PathBuf::from(dir.trim());
        if let Some(main_git) = p.parent().and_then(|w| w.parent())
            && let Some(main) = main_git.parent()
        {
            return main.to_path_buf();
        }
    }
    top.to_path_buf()
}

impl Config {
    pub fn from_args() -> Result<Self, String> {
        let mut args = std::env::args().skip(1).peekable();
        let mut hub = std::env::var("KINECT_HUB").ok();
        let mut data: Option<PathBuf> = None;
        let mut cfg = Config {
            hub: String::new(),
            data_dir: PathBuf::new(),
            legacy_dirs: Vec::new(),
            control_port: 8095,
            control_bind: std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
            control_dir: None,
            scene: None,
            windowed: false,
            monitor: None,
            screen: None,
            fps: 0.0,
            vsync: "fifo".into(),
            shots: None,
            seconds: None,
            shot_every: 2.0,
            mute: false,
            no_control: false,
            params: Vec::new(),
            led: None,
            list_scenes: false,
            watch: None,
            new_scene: None,
        };
        while let Some(a) = args.next() {
            let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} braucht einen Wert"));
            match a.as_str() {
                "--hub" => hub = Some(value("--hub")?),
                "--data" => data = Some(PathBuf::from(value("--data")?)),
                "--control-port" => cfg.control_port = value("--control-port")?.parse().map_err(|_| "--control-port: Zahl erwartet")?,
                "--control-bind" => cfg.control_bind = value("--control-bind")?.parse().map_err(|_| "--control-bind: IP-Adresse erwartet (0.0.0.0 oder 127.0.0.1)")?,
                "--control-dir" => cfg.control_dir = Some(PathBuf::from(value("--control-dir")?)),
                "--scene" => cfg.scene = Some(value("--scene")?),
                "--windowed" => cfg.windowed = true,
                "--monitor" => cfg.monitor = Some(value("--monitor")?),
                "--screen" => {
                    let v = value("--screen")?;
                    let n: Vec<i32> = v.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                    let [x, y, w, h] = n[..] else { return Err("--screen x,y,breite,höhe".into()) };
                    cfg.screen = Some([x, y, w, h]);
                }
                "--fps" => cfg.fps = value("--fps")?.parse().map_err(|_| "--fps: Zahl erwartet")?,
                "--vsync" => cfg.vsync = value("--vsync")?,
                "--shots" => cfg.shots = Some(PathBuf::from(value("--shots")?)),
                "--seconds" => cfg.seconds = Some(value("--seconds")?.parse().map_err(|_| "--seconds: Zahl erwartet")?),
                "--shot-every" => cfg.shot_every = value("--shot-every")?.parse().map_err(|_| "--shot-every: Zahl erwartet")?,
                "--mute" => cfg.mute = true,
                "--list-scenes" => cfg.list_scenes = true,
                "--watch" => {
                    // an optional directory: the next argument unless it is an option
                    let dir = match args.peek() {
                        Some(a) if !a.starts_with('-') => args.next().map(std::path::PathBuf::from),
                        _ => crate::devbuild::default_root(),
                    };
                    cfg.watch = Some(dir.ok_or_else(|| "--watch: wo ist der Workspace (wall-bevy/)? --watch DIR angeben".to_string())?);
                }
                "--new-scene" => cfg.new_scene = Some(value("--new-scene")?),
                "--no-control" | "--no-bus" => cfg.no_control = true,
                "--param" | "-p" => {
                    let kv = value("--param")?;
                    let (k, v) = kv.split_once('=').ok_or("--param key=value")?;
                    cfg.params.push((k.to_string(), v.to_string()));
                }
                "--led" => {
                    let v = value("--led")?;
                    let (w, h) = v.split_once('x').ok_or("--led 1008x336")?;
                    cfg.led = Some((w.parse().map_err(|_| "--led")?, h.parse().map_err(|_| "--led")?));
                }
                "-h" | "--help" => return Err(HELP.to_string()),
                other => return Err(format!("unbekannte Option {other}\n\n{HELP}")),
            }
        }
        cfg.hub = normalize_hub(hub.as_deref().unwrap_or("http://127.0.0.1:8090"));
        let top = checkout_top();
        let main = top.as_deref().map(main_checkout);
        let env_dir = std::env::var("KINECT_WALL_DIR").ok().filter(|d| !d.is_empty()).map(PathBuf::from);
        cfg.data_dir = data.or(env_dir).or_else(|| main.as_ref().map(|m| m.join("wall-bevy").join("data"))).unwrap_or_else(|| {
            let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)).unwrap_or_default();
            exe_dir.join("data")
        });
        // where the browser's dev server kept them (setup and projection in the main checkout, the
        // show per checkout)
        for d in [main.as_ref(), top.as_ref()].into_iter().flatten() {
            let old = d.join("web").join(".cache").join("wall");
            if !cfg.legacy_dirs.contains(&old) {
                cfg.legacy_dirs.push(old);
            }
        }
        if cfg.shots.is_some() && cfg.seconds.is_none() {
            cfg.seconds = Some(10.0);
        }
        Ok(cfg)
    }

    /// ws://host:port/ws of the hub
    pub fn hub_ws(&self) -> String {
        format!("{}/ws", self.hub.replacen("http", "ws", 1))
    }
}

const HELP: &str = "wall-bevy: die LED-Wand-Ausgabe als native App (Bevy)

  wall-bevy                      Ausgabe auf dem LED-Bildschirm, spielt die Show;
                                 Steuerzentrale: http://127.0.0.1:8095/ (und im Netz)
  --hub 8091|host:port|URL       kinect-hub (Standard KINECT_HUB oder 127.0.0.1:8090)
  --data DIR                     Setup, Projektionen, Show (Standard KINECT_WALL_DIR, sonst
                                 wall-bevy/data im Haupt-Checkout)
  --control-port N               Port der Steuerzentrale (Standard 8095, 0: keine)
  --control-bind IP              0.0.0.0: auch im Netz (Standard), 127.0.0.1: nur hier
  --control-dir DIR              Dateien der Steuerzentrale aus DIR (zum Bearbeiten der Seite)
  --scene NAME                   nur diese Szene statt der Show (-p key=wert für Parameter)
  --windowed                     normales Fenster (Test); --monitor N|NAME Bildschirm
  --screen X,Y,B,H               der Bildschirm mit diesem Desktop-Rechteck (start-wand)
  --fps N                        Bildrate begrenzen
  --vsync fifo|mailbox|immediate Darstellung (Standard fifo)
  --shots DIR --seconds S        Test: S Sekunden rendern, PNGs und Bildzeiten nach DIR
  --led 1008x336                 LED-Größe für Tests ohne Setup
  --list-scenes                  alle Szenen (Name, Titel, Parameter, ...) als JSON ausgeben
  --watch [DIR]                  Szenen beim Speichern neu bauen und austauschen (DIR: wall-bevy/)
  --new-scene NAME               neue Szene aus der Vorlage anlegen (scenes/NAME)
  --mute                         ohne Ton
  --no-control                   ohne Steuerzentrale";
