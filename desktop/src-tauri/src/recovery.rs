//! Publish the shell's current intent independently of the supervised runtime's lifetime.
use crate::{
    exit::{ExitCoordinator, ExitPhase},
    recovery_activity::{Activity, Reservation},
    recovery_presence::{Presence, Snapshot},
};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};

struct Recovery {
    home: Arc<Mutex<Option<std::path::PathBuf>>>,
    activity: Arc<Activity>,
    _presence: Presence,
}

/// Register before startup can resolve or spawn. A failure grants no consumer-side authority.
pub fn register(app: &AppHandle) {
    let home = Arc::new(Mutex::new(None));
    let observed_home = Arc::clone(&home);
    let activity = Arc::new(Activity::default());
    let observed_activity = Arc::clone(&activity);
    let handle = app.clone();
    let snapshot = Arc::new(move || {
        let state = handle
            .try_state::<ExitCoordinator>()
            .map(|exit| exit.supervision());
        Snapshot {
            home: observed_home.lock().ok().and_then(|home| home.clone()),
            wanted: observed_activity.recovering(state.is_some_and(|s| {
                s.wanted
                    && !s.reason_set
                    && matches!(s.phase, ExitPhase::Idle | ExitPhase::Spawning)
            })),
        }
    });
    match Presence::start(uuid::Uuid::new_v4().simple().to_string(), snapshot) {
        Ok(presence) => {
            app.manage(Recovery {
                home,
                activity,
                _presence: presence,
            });
        }
        Err(_) => crate::logging::log_once(
            "Desktop recovery evidence is unavailable",
            "the native listener could not be registered",
        ),
    }
}

fn update_activity(app: &AppHandle, update: impl FnOnce(&Activity)) {
    if let Some(recovery) = app.try_state::<Recovery>() {
        update(&recovery.activity);
    }
}

pub fn begin_run(app: &AppHandle, generation: u64, recovering: bool) {
    update_activity(app, |activity| activity.begin_run(generation, recovering));
}

pub fn ready(app: &AppHandle, generation: u64, owned: bool) {
    update_activity(app, |activity| activity.ready(generation, owned));
}

pub fn failed(app: &AppHandle, generation: u64) {
    update_activity(app, |activity| activity.failed(generation));
}

pub fn defer_recovery(app: &AppHandle) {
    update_activity(app, Activity::defer_recovery);
}

pub fn finish_run(app: &AppHandle, generation: u64, ready: bool) {
    update_activity(app, |activity| activity.finish_run(generation, ready));
}

pub fn reserve(app: &AppHandle) -> Option<Reservation> {
    app.try_state::<Recovery>()
        .and_then(|recovery| recovery.activity.reserve())
}

/// Only the bundled CLI's resolved home selects the scope; neither request bytes nor a locator do.
pub fn bind_home(app: &AppHandle, home: &Path) {
    if let Some(recovery) = app.try_state::<Recovery>() {
        if let Ok(mut current) = recovery.home.lock() {
            *current = Some(home.to_path_buf());
        }
    }
}
