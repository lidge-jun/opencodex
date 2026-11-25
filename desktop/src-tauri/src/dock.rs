use std::{
    fs, io,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{menu::CheckMenuItem, ActivationPolicy, App, AppHandle, Manager, Wry};

const MARKER: &str = "hide-dock-icon";

pub struct Preference {
    marker: Option<PathBuf>,
    enabled: AtomicBool,
}

impl Preference {
    fn load(directory: Option<PathBuf>) -> Self {
        let marker = directory.map(|dir| dir.join(MARKER));
        let enabled = marker.as_ref().is_some_and(|path| path.is_file());
        Self {
            marker,
            enabled: AtomicBool::new(enabled),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    fn set(&self, enabled: bool) -> io::Result<()> {
        let marker = self.marker.as_ref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "desktop configuration directory unavailable",
            )
        })?;
        if enabled {
            if let Some(directory) = marker.parent() {
                fs::create_dir_all(directory)?;
            }
            match fs::File::create_new(marker) {
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists && marker.is_file() => {}
                Err(error) => return Err(error),
            }
        } else if let Err(error) = fs::remove_file(marker) {
            if error.kind() != io::ErrorKind::NotFound {
                return Err(error);
            }
        }
        self.enabled.store(enabled, Ordering::Release);
        Ok(())
    }
}

pub fn prepare_launch(mut app: App) -> App {
    let preference = Preference::load(app.path().app_config_dir().ok());
    if preference.enabled() {
        // Stage this before the event loop starts so a saved preference applies at launch.
        app.set_activation_policy(ActivationPolicy::Accessory);
        app.set_dock_visibility(false);
    }
    app.manage(preference);
    app
}

pub fn show_in_dock(window_visible: bool, hide_dock: bool, tray_available: bool) -> bool {
    window_visible && (!hide_dock || !tray_available)
}

pub fn toggle(app: &AppHandle, item: &CheckMenuItem<Wry>) {
    let preference = app.state::<Preference>();
    // The native menu flips the checkmark before dispatching the event.
    if let Err(error) = preference.set(!preference.enabled()) {
        crate::logging::log_once("could not save Hide Dock icon", &error.to_string());
    }
    let _ = item.set_checked(preference.enabled());

    let visible = app
        .get_webview_window("main")
        .is_some_and(|window| window.is_visible().unwrap_or(false));
    crate::window::set_tray_policy(app, visible);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dock_visibility_tracks_the_window_unless_menu_bar_mode_is_available() {
        for hide_dock in [false, true] {
            for tray_available in [false, true] {
                assert!(!show_in_dock(false, hide_dock, tray_available));
            }
        }
        assert!(show_in_dock(true, false, true));
        assert!(!show_in_dock(true, true, true));
        assert!(show_in_dock(true, true, false));
    }

    #[test]
    fn preference_survives_reloads_and_restores_the_default_when_disabled() {
        let directory = std::env::temp_dir().join(format!("ocx-dock-{}", uuid::Uuid::new_v4()));
        let load = || Preference::load(Some(directory.clone()));
        let preference = load();
        assert!(!preference.enabled());
        preference.set(true).unwrap();
        assert!(load().enabled());
        preference.set(false).unwrap();
        assert!(!load().enabled());
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn failed_save_keeps_the_current_preference() {
        let preference = Preference::load(None);
        assert!(preference.set(true).is_err());
        assert!(!preference.enabled());
    }
}
