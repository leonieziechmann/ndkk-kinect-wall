//! What the operating system should know about the output.
//!
//! Windows: the same treatment start-wand.ps1 gives the hub and the kiosk browser: priority above
//! normal (the same level as the hub and the depth worker, so none waits for the other) and never
//! power-throttled. The control center has the focus, not the output; without this, Windows may put
//! the output into efficiency mode (EcoQoS) and stretch its frames.

#[cfg(windows)]
pub fn tune_process() {
    use windows_sys::Win32::System::Threading::{
        ABOVE_NORMAL_PRIORITY_CLASS, GetCurrentProcess, PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION, PROCESS_POWER_THROTTLING_STATE, ProcessPowerThrottling, SetPriorityClass, SetProcessInformation,
    };
    // SAFETY: plain Win32 calls on the pseudo handle of this process; the state struct lives
    // across the call and its size is passed along.
    unsafe {
        let me = GetCurrentProcess();
        if SetPriorityClass(me, ABOVE_NORMAL_PRIORITY_CLASS) == 0 {
            bevy::log::warn!("Priorität 'höher als normal' nicht gesetzt");
        }
        // control the throttling, state 0 = off: full speed, timer resolution kept
        let state = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION,
            StateMask: 0,
        };
        let size = std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32;
        if SetProcessInformation(me, ProcessPowerThrottling, (&raw const state).cast(), size) == 0 {
            bevy::log::warn!("Energiesparmodus (EcoQoS) nicht abgeschaltet");
        }
    }
}

#[cfg(not(windows))]
pub fn tune_process() {}
