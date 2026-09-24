use crate::{exit::RestartReadiness, logging, tray};
use serde::Serialize;
use serde_json::to_value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::watch;
use uuid::Uuid;

#[derive(Clone)]
pub enum UiProjection {
    Available(String),
    Current,
}

#[derive(Clone)]
struct UiUpdate {
    revision: u64,
    projection: UiProjection,
}

pub struct CheckGeneration {
    latest_started: AtomicU64,
    install_epoch: AtomicU64,
    application: Mutex<()>,
    latest_ui_revision: AtomicU64,
    ui: watch::Sender<Option<UiUpdate>>,
}

impl Default for CheckGeneration {
    fn default() -> Self {
        let (ui, _) = watch::channel(None);
        Self {
            latest_started: AtomicU64::new(0),
            install_epoch: AtomicU64::new(0),
            application: Mutex::new(()),
            latest_ui_revision: AtomicU64::new(0),
            ui,
        }
    }
}

impl CheckGeneration {
    pub fn begin_if_not_installing(
        &self,
        installing: &std::sync::atomic::AtomicBool,
        publish_checking: impl FnOnce(),
    ) -> Option<(u64, u64)> {
        let _guard = self
            .application
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if installing.load(Ordering::Acquire) {
            return None;
        }
        let generation = self.latest_started.fetch_add(1, Ordering::AcqRel) + 1;
        let epoch = self.install_epoch.load(Ordering::Acquire);
        publish_checking();
        Some((generation, epoch))
    }

    // Commit 3 uses this for both the tray and page install paths.
    #[allow(dead_code)] // The next ordered commit wires the install action to this gate.
    pub fn claim_install(&self, installing: &std::sync::atomic::AtomicBool) -> bool {
        let _guard = self
            .application
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if installing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        self.install_epoch.fetch_add(1, Ordering::AcqRel);
        self.latest_ui_revision.fetch_add(1, Ordering::AcqRel);
        true
    }

    #[allow(dead_code)] // Consumed by the update page in commit 3.
    pub fn epoch_is_current(&self, epoch: u64) -> bool {
        self.install_epoch.load(Ordering::Acquire) == epoch
    }

    pub fn apply_if_current<T>(&self, generation: u64, apply: impl FnOnce() -> T) -> Option<T> {
        let _guard = self
            .application
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.latest_started.load(Ordering::Acquire) != generation {
            return None;
        }
        Some(apply())
    }

    #[allow(dead_code)] // Consumed by the update page in commit 3.
    pub fn inspect<T>(&self, read: impl FnOnce() -> T) -> T {
        let _guard = self
            .application
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        read()
    }

    // Call only inside application/inspect. This is an in-memory send, never a Tauri setter.
    fn queue_ui(&self, projection: UiProjection) {
        let revision = self.latest_ui_revision.fetch_add(1, Ordering::AcqRel) + 1;
        self.ui.send_replace(Some(UiUpdate {
            revision,
            projection,
        }));
    }

    fn apply_ui_projection_if_current(
        &self,
        update: UiUpdate,
        apply: impl FnOnce(UiProjection),
    ) -> bool {
        if update.revision != self.latest_ui_revision.load(Ordering::Acquire) {
            return false;
        }
        apply(update.projection);
        true
    }
}

pub fn start_ui_projection_worker(app: AppHandle) {
    let mut receiver = app.state::<CheckGeneration>().ui.subscribe();
    tauri::async_runtime::spawn(async move {
        while receiver.changed().await.is_ok() {
            let Some(update) = receiver.borrow_and_update().clone() else {
                continue;
            };
            app.state::<CheckGeneration>()
                .apply_ui_projection_if_current(update, |projection| match projection {
                    UiProjection::Available(version) => tray::show_update_available(&app, &version),
                    UiProjection::Current => tray::show_up_to_date(&app),
                });
        }
    });
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    session_id: String,
    current_version: String,
    latest_version: Option<String>,
    available: bool,
    checked_at_ms: Option<u64>,
    phase: &'static str,
}

pub struct DesktopUpdateState {
    session_id: String,
    tx: watch::Sender<DesktopSnapshot>,
}

impl DesktopUpdateState {
    pub fn new(current_version: String) -> Self {
        let session_id = Uuid::new_v4().to_string();
        let (tx, _) = watch::channel(DesktopSnapshot {
            session_id: session_id.clone(),
            current_version,
            latest_version: None,
            available: false,
            checked_at_ms: None,
            phase: "idle",
        });
        Self { session_id, tx }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn publish(&self, phase: &'static str, latest: Option<String>, checked: Option<u64>) {
        let previous = self.tx.borrow().clone();
        let next = DesktopSnapshot {
            session_id: self.session_id.clone(),
            current_version: previous.current_version,
            available: latest.is_some(),
            latest_version: latest,
            checked_at_ms: checked,
            phase,
        };
        self.tx.send_replace(next);
    }

    pub fn retain_phase(&self, phase: &'static str) {
        let previous = self.tx.borrow().clone();
        self.publish(phase, previous.latest_version, previous.checked_at_ms);
    }

    pub fn wake(&self) {
        self.wake_with_before_notify(|| {});
    }

    fn wake_with_before_notify(&self, before_notify: impl FnOnce()) {
        before_notify();
        self.tx.send_modify(|_| {});
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

pub fn start_snapshot_publisher(app: AppHandle) {
    let mut receiver = app.state::<DesktopUpdateState>().tx.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            let snapshot = receiver.borrow_and_update().clone();
            if let Some(proxy) = app
                .try_state::<crate::AppState>()
                .and_then(|state| state.proxy())
            {
                if let Ok(body) = to_value(&snapshot) {
                    let _ = proxy.post_desktop_snapshot(&body).await;
                }
            }
            if matches!(
                tokio::time::timeout(Duration::from_secs(60), receiver.changed()).await,
                Ok(Err(_))
            ) {
                break;
            }
        }
    });
}

pub struct PendingUpdate(pub Mutex<Option<Update>>);

// lib.rs selects native_tray.rs as popup on macOS; compile the portable popup tests here too.
#[cfg(all(test, target_os = "macos"))]
#[allow(dead_code)]
#[path = "popup.rs"]
mod popup_nonmac_test;

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
    // Download and verify first, and separately from installing. The pinned updater checks the
    // release signature inside `download`, so these bytes are the ones the key signed; nothing has
    // been replaced yet, and a failure here costs only the download.
    let package = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;

    // Then stop the runtime, and confirm it stopped, *before* anything is replaced. Asking for the
    // restart after `install` is the shape that does not work: the pinned Windows installer hands off
    // to the installer process and ends this one, so the call after it is never reached and the
    // update would replace files under a runtime that is still serving. R2 still holds — this is a
    // coordinated restart and not a quit — but the coordination has to finish first.
    let readiness = crate::exit::prepare_restart(app).await;
    if readiness != RestartReadiness::Ready {
        return Err(format!(
            "the update was downloaded but not installed: {}",
            readiness.describe()
        ));
    }

    update.install(package).map_err(|error| error.to_string())?;
    // Only reached where the installer returns. On Windows it does not.
    crate::exit::complete_restart(app)
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
    let gate = app.state::<CheckGeneration>();
    let state = app.state::<tray::TrayState>();
    let Some((generation, _epoch)) = gate.begin_if_not_installing(&state.installing, || {
        app.state::<DesktopUpdateState>().retain_phase("checking");
    }) else {
        return;
    };
    let answer = check(app).await;
    let applied_error = gate
        .apply_if_current(generation, || {
            if tray::is_installing(app) {
                return None;
            }
            match answer {
                Ok(Some(update)) => {
                    let version = update.version.clone();
                    if let Ok(mut pending) = app.state::<PendingUpdate>().0.lock() {
                        *pending = Some(update);
                    }
                    app.state::<DesktopUpdateState>().publish(
                        "available",
                        Some(version.clone()),
                        Some(now_ms()),
                    );
                    state.update_pending.store(true, Ordering::Release);
                    gate.queue_ui(UiProjection::Available(version));
                    None
                }
                Ok(None) => {
                    if let Ok(mut pending) = app.state::<PendingUpdate>().0.lock() {
                        *pending = None;
                    }
                    app.state::<DesktopUpdateState>()
                        .publish("current", None, Some(now_ms()));
                    state.update_pending.store(false, Ordering::Release);
                    gate.queue_ui(UiProjection::Current);
                    None
                }
                Err(error) => {
                    app.state::<DesktopUpdateState>().retain_phase("error");
                    Some(error)
                }
            }
        })
        .flatten();
    if let Some(error) = applied_error {
        logging::log_once("updater check failed", &error);
    }
}

#[cfg(test)]
mod tests {
    use super::{linux_updater_target, update_label, CheckGeneration, DesktopUpdateState};
    use std::sync::atomic::AtomicBool;
    use tauri_utils::config::BundleType;

    #[test]
    fn desktop_snapshot_serializes_the_bounded_wire_fields() {
        let state = DesktopUpdateState::new("2.61.0".into());
        state.publish("available", Some("2.62.0".into()), Some(1_790_000_000_000));
        let value = serde_json::to_value(state.tx.borrow().clone()).unwrap();
        assert!(uuid::Uuid::parse_str(state.session_id()).is_ok());
        assert_eq!(value["sessionId"], state.session_id());
        assert_eq!(value["currentVersion"], "2.61.0");
        assert_eq!(value["latestVersion"], "2.62.0");
        assert_eq!(value["available"], true);
        assert_eq!(value["checkedAtMs"], 1_790_000_000_000u64);
        assert!(value["checkedAtMs"].as_u64().unwrap() >= 946_684_800_000);
        assert_eq!(value["phase"], "available");
        assert_eq!(value.as_object().unwrap().len(), 6);
    }

    #[test]
    fn wake_preserves_a_snapshot_published_during_notification() {
        let state = DesktopUpdateState::new("2.61.0".into());
        state.publish("checking", None, None);
        state.wake_with_before_notify(|| {
            state.publish("available", Some("2.62.0".into()), Some(123));
        });
        let snapshot = state.tx.borrow();
        assert_eq!(snapshot.phase, "available");
        assert_eq!(snapshot.latest_version.as_deref(), Some("2.62.0"));
        assert_eq!(snapshot.checked_at_ms, Some(123));
    }

    #[test]
    fn wake_notifies_without_changing_the_snapshot() {
        let state = DesktopUpdateState::new("2.61.0".into());
        let mut receiver = state.tx.subscribe();
        let before = serde_json::to_value(receiver.borrow_and_update().clone()).unwrap();
        state.wake();
        assert!(receiver.has_changed().unwrap());
        let after = serde_json::to_value(receiver.borrow_and_update().clone()).unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn a_delayed_older_none_cannot_clear_a_newer_pending_update() {
        let checks = CheckGeneration::default();
        let installing = AtomicBool::new(false);
        let (older, _) = checks.begin_if_not_installing(&installing, || {}).unwrap();
        let (newer, _) = checks.begin_if_not_installing(&installing, || {}).unwrap();
        let mut pending: Option<&str> = None;
        let mut phase = "checking";
        assert_eq!(
            checks.apply_if_current(newer, || {
                pending = Some("2.62.0");
                phase = "available";
            }),
            Some(())
        );
        assert_eq!(
            checks.apply_if_current(older, || {
                pending = None;
                phase = "current";
            }),
            None
        );
        assert_eq!(pending, Some("2.62.0"));
        assert_eq!(phase, "available");
        let (third, _) = checks.begin_if_not_installing(&installing, || {}).unwrap();
        assert_eq!(
            checks.apply_if_current(newer, || {
                pending = None;
            }),
            None
        );
        assert_eq!(pending, Some("2.62.0"));
        assert_eq!(
            checks.apply_if_current(third, || {
                pending = None;
            }),
            Some(())
        );
        assert_eq!(pending, None);
    }

    #[test]
    fn checking_publication_rechecks_install_claim_inside_the_gate() {
        let checks = CheckGeneration::default();
        let installing = AtomicBool::new(false);
        assert!(checks.claim_install(&installing));
        let mut published = false;
        assert_eq!(
            checks.begin_if_not_installing(&installing, || {
                published = true;
            }),
            None
        );
        assert!(!published);
    }

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
