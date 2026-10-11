//! Command line and environment: where the hub, the dev server and the wall documents are.
//!
//!   wall-bevy                        the output on the LED screen (setup.output.window, else the
//!                                    first screen that is not the primary one), playing the show
//!   --hub 8091 | host:port | URL     the kinect-hub (default KINECT_HUB, else 127.0.0.1:8090)
//!   --web DIR                        the checkout's web/ folder (show.json, dev-server.json);
//!                                    default: found next to the exe or the working directory
//!   --dev URL                        the dev server for the control center (default: from
//!                                    web/.cache/dev-server.json, re-read while running)
//!   --scene NAME                     plays this scene instead of the show
//!   --windowed                       a normal window (testing), --monitor N|NAME a screen
//!   --screen X,Y,W,H                 the screen with this desktop rectangle (start-wand.ps1)
//!   --fps N                          caps the render rate (as ?fps= in the browser)
//!   --vsync fifo|mailbox|immediate   presentation (default fifo: steady, never tears)
//!   --shots DIR --seconds S          test: renders S seconds, writes PNGs and frame times to DIR
//!   --mute                           no sound
//!   --no-bus                         does not talk to the control center

use std::path::{Path, PathBuf};

#[derive(Clone, Debug, bevy::prelude::Resource)]
pub struct Config {
    /// http://host:port of the hub
    pub hub: String,
    /// the checkout's web/ folder
    pub web_dir: PathBuf,
    /// setup.json and projection.json (shared by every worktree: the main checkout's)
    pub wall_dir: PathBuf,
    /// dev server URL given on the command line (else read from dev-server.json)
    pub dev: Option<String>,
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
    pub no_bus: bool,
    /// scene params for --scene: key=value pairs (numbers, true/false, #colors, text)
    pub params: Vec<(String, String)>,
    /// LED size for tests without a setup (--led 1008x336)
    pub led: Option<(u32, u32)>,
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

fn find_web_dir() -> Option<PathBuf> {
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
            let web = d.join("web");
            if web.join("scenes").is_dir() && web.join("lib").is_dir() {
                return Some(web);
            }
            if d.join("scenes").is_dir() && d.join("lib").join("wall.js").is_file() {
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
        let mut args = std::env::args().skip(1);
        let mut hub = std::env::var("KINECT_HUB").ok();
        let mut web: Option<PathBuf> = None;
        let mut cfg = Config {
            hub: String::new(),
            web_dir: PathBuf::new(),
            wall_dir: PathBuf::new(),
            dev: None,
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
            no_bus: false,
            params: Vec::new(),
            led: None,
        };
        while let Some(a) = args.next() {
            let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} braucht einen Wert"));
            match a.as_str() {
                "--hub" => hub = Some(value("--hub")?),
                "--web" => web = Some(PathBuf::from(value("--web")?)),
                "--dev" => cfg.dev = Some(value("--dev")?.trim_end_matches('/').to_string()),
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
                "--no-bus" => cfg.no_bus = true,
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
        cfg.web_dir = web.or_else(find_web_dir).unwrap_or_else(|| PathBuf::from("web"));
        cfg.wall_dir = match std::env::var("KINECT_WALL_DIR") {
            Ok(d) if !d.is_empty() => PathBuf::from(d),
            _ => {
                let top = cfg.web_dir.parent().map(Path::to_path_buf).unwrap_or_default();
                main_checkout(&top).join("web").join(".cache").join("wall")
            }
        };
        if cfg.shots.is_some() && cfg.seconds.is_none() {
            cfg.seconds = Some(10.0);
        }
        Ok(cfg)
    }

    /// ws://host:port/ws of the hub
    pub fn hub_ws(&self) -> String {
        format!("{}/ws", self.hub.replacen("http", "ws", 1))
    }

    /// The show of this checkout (web/.cache/wall/show.json).
    pub fn show_file(&self) -> PathBuf {
        self.web_dir.join(".cache").join("wall").join("show.json")
    }

    pub fn doc_file(&self, kind: &str) -> PathBuf {
        if kind == "show" { self.show_file() } else { self.wall_dir.join(format!("{kind}.json")) }
    }

    /// The dev server this checkout runs (web/.cache/dev-server.json), if any.
    pub fn dev_server(&self) -> Option<String> {
        if let Some(d) = &self.dev {
            return Some(d.clone());
        }
        let text = std::fs::read_to_string(self.web_dir.join(".cache").join("dev-server.json")).ok()?;
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        v.get("url")?.as_str().map(|s| s.trim_end_matches('/').to_string())
    }
}

const HELP: &str = "wall-bevy: die LED-Wand-Ausgabe als native App (Bevy)

  wall-bevy                      Ausgabe auf dem LED-Bildschirm, spielt die Show
  --hub 8091|host:port|URL       kinect-hub (Standard KINECT_HUB oder 127.0.0.1:8090)
  --web DIR                      web/-Ordner des Checkouts (show.json, dev-server.json)
  --dev URL                      Dev-Server für die Steuerzentrale (Standard: dev-server.json)
  --scene NAME                   nur diese Szene statt der Show (-p key=wert für Parameter)
  --windowed                     normales Fenster (Test); --monitor N|NAME Bildschirm
  --screen X,Y,B,H               der Bildschirm mit diesem Desktop-Rechteck (start-wand)
  --fps N                        Bildrate begrenzen
  --vsync fifo|mailbox|immediate Darstellung (Standard fifo)
  --shots DIR --seconds S        Test: S Sekunden rendern, PNGs und Bildzeiten nach DIR
  --led 1008x336                 LED-Größe für Tests ohne Setup
  --mute                         ohne Ton
  --no-bus                       ohne Steuerzentrale";
