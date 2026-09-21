use crate::{logging, tray};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct PendingUpdate(pub Mutex<Option<Update>>);

/// The manifest key a Linux install must resolve, or None to keep the updater's default
/// os-arch key (linux-x86_64, windows-x86_64, darwin-*).
///
/// A deb install cannot apply the AppImage payload: the updater validates the downloaded
/// bytes as a real .deb before installing through package-manager elevation, so it must
/// resolve the deb's own manifest key. The bundle type is patched into the binary at
/// packaging time, so the answer is embedded per artifact, not detected at runtime. The
/// AppImage keeps the default key, which is also what installs from releases before the
/// deb target existed already resolve.
#[cfg(any(target_os = "linux", test))]
pub fn linux_updater_target(
    bundle: Option<tauri_utils::config::BundleType>,
) -> Option<&'static str> {
    match bundle {
        Some(tauri_utils::config::BundleType::Deb) => Some("linux-x86_64-deb"),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn configured_updater_target() -> Option<&'static str> {
    linux_updater_target(tauri_utils::platform::bundle_type())
}

#[cfg(not(target_os = "linux"))]
fn configured_updater_target() -> Option<&'static str> {
    None
}

pub async fn check(app: &AppHandle) -> Result<Option<Update>, String> {
    let mut builder = app.updater_builder();
    if let Some(target) = configured_updater_target() {
        builder = builder.target(target);
    }
    builder
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}

pub async fn install(app: &AppHandle, update: Update) -> Result<(), String> {
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    app.restart();
}

pub fn update_label(version: &str) -> String {
    format!("Install update v{version}")
}

pub fn start_background_checks(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        loop {
            check_and_show(&app).await;
            tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

pub async fn check_and_show(app: &AppHandle) {
    if tray::is_installing(app) {
        return;
    }
    match check(app).await {
        Ok(Some(update)) => {
            if tray::is_installing(app) {
                return;
            }
            let version = update.version.clone();
            if let Ok(mut pending) = app.state::<PendingUpdate>().0.lock() {
                *pending = Some(update);
            }
            tray::show_update_available(app, &version);
        }
        Ok(None) => {
            if let Ok(mut pending) = app.state::<PendingUpdate>().0.lock() {
                *pending = None;
            }
            tray::show_up_to_date(app);
        }
        Err(error) => logging::log_once("updater check failed", &error),
    }
}

#[cfg(test)]
mod tests {
    use super::{linux_updater_target, update_label};
    use tauri_utils::config::BundleType;

    #[test]
    fn formats_update_menu_label() {
        assert_eq!(update_label("2.62.0"), "Install update v2.62.0");
    }

    #[test]
    fn deb_installs_resolve_their_own_updater_key() {
        assert_eq!(
            linux_updater_target(Some(BundleType::Deb)),
            Some("linux-x86_64-deb")
        );
    }

    #[test]
    fn appimage_installs_keep_the_default_updater_key() {
        assert_eq!(linux_updater_target(Some(BundleType::AppImage)), None);
    }

    #[test]
    fn unbundled_builds_keep_the_default_updater_key() {
        // Dev builds and any format without a patcher entry resolve the default key.
        assert_eq!(linux_updater_target(None), None);
    }
}
