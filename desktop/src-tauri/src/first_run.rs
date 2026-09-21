use std::fs;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

/// Marker file recording that the one-time Start at Login default has already been applied.
const MARKER: &str = "start-at-login-claimed";

/// Turn Start at Login on once, the first time this installation runs.
///
/// A menu bar app that is not running has no menu bar item. Leaving autostart off by default
/// therefore means that after the next reboot an installed app is simply absent, with nothing on
/// screen to explain why — which is not a neutral default for an app whose main surface *is* the
/// menu bar.
///
/// This runs exactly once per installation. The marker is written **before** the login item is
/// touched, and is never removed, so a user who turns Start at Login back off keeps it off: the
/// next launch sees the marker and does nothing. Writing afterwards instead would mean that a
/// failed or partial enable retries on every launch, and would eventually flip the setting back on
/// under a user who had deliberately turned it off in between.
///
/// Every failure is silent on purpose. Not being able to write a marker or register a login item
/// is not a reason to stop the app from starting, and the user can still toggle the menu item.
pub fn apply_start_at_login_default(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let marker = dir.join(MARKER);
    if marker.exists() {
        return;
    }
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    if fs::write(&marker, b"").is_err() {
        return;
    }
    if app.autolaunch().is_enabled().unwrap_or(false) {
        return;
    }
    let _ = app.autolaunch().enable();
}
