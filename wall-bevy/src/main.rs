//! wall-bevy: the LED wall output (web/ /wall/) as a native Bevy app. See README.md.
//!
//! The main world runs the show: the hub client (threads), the persons, the wall mapping and the
//! scenes, which render with wgpu into their own textures (as they did with WebGPU in the
//! browser). The render world only puts the finished LED image into the window (compositor.rs).

mod audio;
mod bus;
mod canvas;
mod compositor;
mod config;
mod docs;
mod gpu;
mod hub;
mod kinect;
mod kinect_gpu;
mod output;
mod params;
mod patterns;
mod persons;
mod platform;
mod preview;
mod scene;
mod scenes;
mod shader_pass;
mod show;
mod store;
mod wall;
mod wall_persons;

use bevy::core_pipeline::tonemapping::{DebandDither, Tonemapping};
use bevy::prelude::*;
use bevy::render::RenderPlugin;
use bevy::render::error_handler::{RenderErrorHandler, RenderErrorPolicy};
use bevy::render::pipelined_rendering::PipelinedRenderingPlugin;
use bevy::render::settings::{RenderCreation, WgpuSettings};
use bevy::window::{CursorOptions, MonitorSelection, PresentMode, PrimaryWindow, WindowMode, WindowPosition, WindowResolution};
use bevy::winit::{UpdateMode, WinitSettings};

use crate::config::Config;

fn main() {
    let cfg = match Config::from_args() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    // logs into a file (start-wand, tests): without color codes
    if !std::io::IsTerminal::is_terminal(&std::io::stdout()) && std::env::var_os("NO_COLOR").is_none() {
        // SAFETY: at the very start, before any thread exists
        unsafe { std::env::set_var("NO_COLOR", "1") };
    }
    if cfg.list_scenes {
        use std::io::Write;
        let _ = writeln!(std::io::stdout(), "{}", scenes::declarations());
        return;
    }
    let present_mode = match cfg.vsync.as_str() {
        "mailbox" => PresentMode::Mailbox,
        "immediate" | "off" => PresentMode::AutoNoVsync,
        _ => PresentMode::Fifo,
    };
    let window = Window {
        title: "LED-Wand · Ausgabe (Bevy)".into(),
        present_mode,
        // windowed until the output screen is known (output::place_window), shown then
        mode: WindowMode::Windowed,
        position: WindowPosition::Automatic,
        resolution: WindowResolution::new(1008, 336).with_scale_factor_override(1.0),
        decorations: cfg.windowed,
        resizable: true,
        visible: cfg.windowed || cfg.shots.is_some(),
        // two frames in flight: steady with vsync, little latency
        desired_maximum_frame_latency: std::num::NonZero::new(2),
        ..default()
    };
    let wgpu_settings = WgpuSettings { device_label: Some("wall-bevy".into()), ..default() };
    App::new()
        .insert_resource(ClearColor(Color::BLACK))
        // the output window renders every vblank, focused or not (the control center has the focus)
        .insert_resource(WinitSettings { focused_mode: UpdateMode::Continuous, unfocused_mode: UpdateMode::Continuous })
        // a GPU error must never end the show: log it; a lost device is created anew
        .insert_resource(RenderErrorHandler(|error, _main, _render| {
            use bevy::render::error_handler::ErrorType;
            match error.ty {
                ErrorType::DeviceLost => {
                    error!("GPU-Gerät verloren: {} – baue neu auf", error.description);
                    RenderErrorPolicy::Recover(RenderCreation::Automatic(Box::new(WgpuSettings { device_label: Some("wall-bevy".into()), ..default() })))
                }
                _ => {
                    warn!("GPU-Fehler (ignoriert): {:?} {}", error.ty, error.description);
                    RenderErrorPolicy::Ignore
                }
            }
        }))
        .add_plugins(
            DefaultPlugins
                .set(WindowPlugin {
                    primary_window: Some(window),
                    primary_cursor_options: Some(CursorOptions { visible: cfg.windowed, ..default() }),
                    // closing the window ends the app (Alt+F4, the control center's "Ausgabe schließen")
                    ..default()
                })
                .set(RenderPlugin { render_creation: RenderCreation::Automatic(Box::new(wgpu_settings)), ..default() })
                // a degenerate path in a scene's 2D drawing is not news worth a log line per frame
                .set(bevy::log::LogPlugin { filter: "wgpu=error,naga=warn,tiny_skia=error".into(), ..default() })
                // update and render one after the other: the scenes submit their GPU work before the
                // frame that shows it, in the same order every frame (no frame shown twice or skipped)
                .disable::<PipelinedRenderingPlugin>(),
        )
        .insert_resource(cfg)
        .add_plugins((compositor::CompositorPlugin, output::OutputPlugin, SingleThreaded))
        .add_systems(Startup, (spawn_camera, output::init_output, platform_tune))
        .add_systems(Update, place_window)
        .run();
}

/// Every schedule of the app and of the render world with the single-threaded executor: Bevy's own
/// systems here are tiny and the scenes run in the output's one system, so the thread pool only
/// cost CPU for waking its threads (about 10 % of a core, measured), no time. WALL_EXECUTOR=multi:
/// Bevy's default (for comparisons).
struct SingleThreaded;

impl Plugin for SingleThreaded {
    fn build(&self, _app: &mut App) {}

    fn cleanup(&self, app: &mut App) {
        if std::env::var("WALL_EXECUTOR").as_deref() == Ok("multi") {
            return;
        }
        fn set(world: &mut World) -> usize {
            let Some(mut schedules) = world.get_resource_mut::<Schedules>() else { return 0 };
            let mut n = 0;
            for (_, schedule) in schedules.iter_mut() {
                schedule.set_executor(bevy::ecs::schedule::SingleThreadedExecutor::new());
                n += 1;
            }
            n
        }
        let main = set(app.world_mut());
        let render = app.get_sub_app_mut(bevy::render::RenderApp).map_or(0, |sub| set(sub.world_mut()));
        debug!("Executor: single-threaded ({main} + {render} Schedules)");
    }
}

fn platform_tune() {
    platform::tune_process();
}

fn spawn_camera(mut commands: Commands) {
    commands.spawn((Camera2d, Tonemapping::None, DebandDither::Disabled, Msaa::Off));
}

/// The output screen: --screen (start-wand.ps1), --monitor, the setup's (chosen in the control
/// center), else the leftmost one that is not the primary; without a second screen a window on the
/// primary one (fitted), until one comes; started by start-wand (--screen) it ends instead.
fn place_window(
    cfg: Res<Config>,
    out: Option<NonSend<output::OutputState>>,
    monitors: Query<(Entity, &bevy::window::Monitor, Has<bevy::window::PrimaryMonitor>)>,
    mut windows: Query<&mut Window, With<PrimaryWindow>>,
    mut last: Local<Option<(Option<Entity>, u64)>>,
    time: Res<Time>,
    mut checked: Local<f64>,
    mut exit: MessageWriter<AppExit>,
) {
    let now = time.elapsed_secs_f64();
    if *checked > 0.0 && now - *checked < 1.0 {
        return;
    }
    *checked = now;
    let Ok(mut window) = windows.single_mut() else {
        return;
    };
    // a test (--shots) stays a window of the LED size, unless a screen is asked for (benchmarks)
    if cfg.windowed || (cfg.shots.is_some() && cfg.monitor.is_none() && cfg.screen.is_none()) {
        return;
    }
    let list: Vec<_> = monitors.iter().collect();
    if list.is_empty() {
        return;
    }
    let Some(out) = out else { return };
    let want = out.setup_window();
    // the screen whose desktop rectangle holds the middle of --screen (physical or logical pixels)
    let by_rect = cfg.screen.and_then(|[x, y, w, h]| {
        let (cx, cy) = (x + w / 2, y + h / 2);
        list.iter()
            .find(|m| {
                let p = m.1.physical_position;
                let (pw, ph) = (m.1.physical_width as i32, m.1.physical_height as i32);
                let s = m.1.scale_factor.max(0.1);
                let inside = |px: i32, py: i32, w: i32, h: i32| cx >= px && cy >= py && cx < px + w && cy < py + h;
                inside(p.x, p.y, pw, ph) || inside((f64::from(p.x) / s) as i32, (f64::from(p.y) / s) as i32, (f64::from(pw) / s) as i32, (f64::from(ph) / s) as i32)
            })
            .map(|m| m.0)
    });
    let pick = by_rect.or_else(|| {
        cfg.monitor.as_deref().and_then(|m| {
            m.parse::<usize>()
                .ok()
                .and_then(|i| list.get(i).map(|x| x.0))
                .or_else(|| list.iter().find(|x| x.1.name.as_deref().is_some_and(|n| n.contains(m))).map(|x| x.0))
        })
        .or_else(|| {
            want.and_then(|w| {
                list.iter()
                    .find(|x| {
                        let s = x.1.scale_factor as f32;
                        let p = x.1.physical_position;
                        // the browser's screen coordinates are CSS pixels of the primary screen's scale
                        (p.x - w[0]).abs() <= 2 && (p.y - w[1]).abs() <= 2 || ((p.x as f32 / s) as i32 - w[0]).abs() <= 2 && ((p.y as f32 / s) as i32 - w[1]).abs() <= 2
                    })
                    .map(|x| x.0)
            })
        })
    })
    // else the leftmost screen that is not the primary one (as start-wand.ps1 picks it)
    .or_else(|| list.iter().filter(|x| !x.2).min_by_key(|x| (x.1.physical_position.x, x.1.physical_position.y)).map(|x| x.0));
    let key = (pick, out.setup_generation());
    if last.as_ref() == Some(&key) {
        // shown one check after it went onto its screen: never visible anywhere else first (a window
        // on the notebook's panel, even for a frame, is closed by start-wand)
        window.visible = true;
        return;
    }
    *last = Some(key);
    match pick {
        Some(m) => {
            let name = monitors.get(m).ok().and_then(|x| x.1.name.clone()).unwrap_or_default();
            info!("Ausgabe auf Bildschirm {name}");
            window.mode = WindowMode::BorderlessFullscreen(MonitorSelection::Entity(m));
            window.decorations = false;
            *checked = now - 0.8; // shown in 0.2 s
            return;
        }
        // started by start-wand.ps1 for a screen that is gone (Windows would move the window onto the
        // notebook's panel): end; start-wand opens the output again as soon as there is a screen
        None if cfg.screen.is_some() => {
            info!("der Bildschirm der Wand ist weg: Ausgabe endet (start-wand öffnet sie wieder)");
            exit.write(AppExit::Success);
            return;
        }
        None => {
            info!("kein zweiter Bildschirm: Ausgabe als Fenster, bis einer angeschlossen wird");
            window.mode = WindowMode::Windowed;
            window.decorations = true;
            window.position = WindowPosition::Centered(MonitorSelection::Primary);
        }
    }
    window.visible = true;
}
