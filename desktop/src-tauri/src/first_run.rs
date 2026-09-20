use std::fs;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

/// Marker file recording that the one-time Start at Login default has already been applied.
const MARKER: &str = "start-at-login-claimed";

/// Marker file recording that the login item names the launch-origin argument.
const ORIGIN_MARKER: &str = "start-at-login-origin-flag";

/// What the one-time Start at Login decision did on this launch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartAtLogin {
    /// This installation had already decided, so whatever the user set is left alone.
    AlreadyDecided,
    /// Turned on for the first time on this installation.
    Enabled,
    /// The default could not be applied. The app still starts and the tray item still toggles it.
    Unavailable,
}

impl StartAtLogin {
    pub fn describe(self) -> &'static str {
        match self {
            Self::AlreadyDecided => "already decided on this installation, left as the user set it",
            Self::Enabled => "turned on for this installation",
            Self::Unavailable => "could not be registered; the tray item still toggles it",
        }
    }
}

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
/// No failure stops the app. Not being able to write a marker or register a login item is not a
/// reason to refuse to start, and the user can still toggle the menu item. What has changed is that
/// the outcome is returned rather than swallowed: D7's startup sequence reports this decision as
/// one of its named states, so a registration that did not happen is visible instead of silent.
pub fn apply_start_at_login_default(app: &AppHandle) -> StartAtLogin {
    let Ok(dir) = app.path().app_config_dir() else {
        return StartAtLogin::Unavailable;
    };
    let marker = dir.join(MARKER);
    if marker.exists() {
        return StartAtLogin::AlreadyDecided;
    }
    if fs::create_dir_all(&dir).is_err() {
        return StartAtLogin::Unavailable;
    }
    if fs::write(&marker, b"").is_err() {
        return StartAtLogin::Unavailable;
    }
    if app.autolaunch().is_enabled().unwrap_or(false) {
        return StartAtLogin::AlreadyDecided;
    }
    match app.autolaunch().enable() {
        Ok(()) => StartAtLogin::Enabled,
        Err(_) => StartAtLogin::Unavailable,
    }
}

/// Rewrite an existing login item so a launch from it can be recognised as one.
///
/// The autostart entry is written once, carrying whatever arguments the plugin was configured with
/// at the time. An installation that registered before the launch-origin argument existed has an
/// entry without it, and a bare launch carries nothing else that distinguishes login from manual —
/// so D7's hidden login start would quietly never happen for exactly the users who already had
/// autostart on. Re-registering rewrites the entry with the current arguments.
///
/// It runs once, behind its own marker, and only where autostart is already on. It never turns the
/// setting on and never turns it off; the worst case is an entry that keeps its old arguments and a
/// login launch that shows its window, which is the visible failure rather than the silent one.
pub fn adopt_launch_origin_argument(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let claimed = dir.join(ORIGIN_MARKER);
    if claimed.exists() {
        return;
    }
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    // Unlike the default above, the marker is written *after* the work, and that difference is
    // deliberate. Writing first exists there to stop a failed enable from flipping a setting the
    // user turned off. Here there is no setting to flip: the rewrite only ever runs on an entry
    // that is already enabled, so retrying after a transient registry, LaunchAgent or desktop-file
    // error is free — and claiming the marker first would suppress the migration permanently and
    // leave a login launch showing its window forever.
    match app.autolaunch().is_enabled() {
        Ok(true) => {
            if app.autolaunch().enable().is_err() {
                return;
            }
        }
        // Nothing registered to migrate. A later enable writes the current arguments anyway.
        Ok(false) => {}
        Err(_) => return,
    }
    let _ = fs::write(&claimed, b"");
}
