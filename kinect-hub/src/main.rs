//! kinect-hub: the only process that talks to the Kinect. It runs libfreenect2 in a supervised
//! worker process, precomputes what every client needs once per frame, and streams the results
//! to any number of clients over WebSocket and HTTP. See README.md.

mod config;
mod devservers;
mod lut;
mod pipeline;
mod pose;
mod protocol;
mod recording;
mod replay;
mod server;
mod source;
mod state;
mod synthetic;
mod ws;
mod yolo;

use std::io::IsTerminal;
use std::process::ExitCode;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tracing::{error, info};

use crate::config::Config;
use crate::state::{Hub, Shutdown};

fn main() -> ExitCode {
    init_logging();
    // a panic anywhere is logged; tasks and threads catch it, the hub keeps running
    std::panic::set_hook(Box::new(|info| error!("panic: {info}")));

    let cfg = match Config::from_args(std::env::args().skip(1)) {
        Ok(Some(cfg)) => Arc::new(cfg),
        Ok(None) => {
            println!("{}", config::USAGE);
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("{e}\n\n{}", config::USAGE);
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().thread_name("hub").build() {
        Ok(rt) => rt,
        Err(e) => {
            error!("cannot start the async runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(run(cfg));
    ExitCode::SUCCESS
}

async fn run(cfg: Arc<Config>) {
    info!(
        "kinect-hub {} (source {}, pipeline {}, smoothing {})",
        env!("CARGO_PKG_VERSION"),
        cfg.source.name(),
        cfg.pipeline,
        cfg.smoothing
    );
    let hub = Hub::new(cfg);

    let (stop_tx, shutdown) = Shutdown::new();
    tokio::spawn(async move {
        wait_for_signal().await;
        info!("shutdown requested");
        stop_tx.send_replace(true);
    });

    // the source (and with it the Kinect) and the pose model only start once this instance owns the port
    let source_slot = Arc::new(Mutex::new(None));
    let pose_slot = Arc::new(Mutex::new(None));
    let start_source: Box<dyn FnOnce() + Send> = {
        let (slot, pose, hub) = (source_slot.clone(), pose_slot.clone(), hub.clone());
        let rt = tokio::runtime::Handle::current();
        Box::new(move || {
            *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(source::spawn(hub.clone()));
            *pose.lock().unwrap_or_else(PoisonError::into_inner) = Some(pose::spawn(hub, rt));
        })
    };
    server::serve(hub.clone(), shutdown, Some(start_source)).await;
    let source = source_slot.lock().unwrap_or_else(PoisonError::into_inner).take();
    if let Some(source) = source {
        source.stop(Duration::from_secs(4)).await;
    }
    let pose = pose_slot.lock().unwrap_or_else(PoisonError::into_inner).take();
    if let Some(pose) = pose {
        pose.stop(Duration::from_secs(4)).await;
    }
    info!("bye");
}

/// Ctrl+C, or the console window being closed.
async fn wait_for_signal() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await; // cannot listen: just never stop
        }
    };
    #[cfg(windows)]
    let close = async {
        match tokio::signal::windows::ctrl_close() {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(windows))]
    let close = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = close => {}
    }
}

fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,tower_http=warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(std::io::stdout().is_terminal())
        .try_init();
}
