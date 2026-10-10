#[cfg(unix)]
use crate::cli_command_posix as posix;
use crate::{
    cli_command_record::{self as record, Bundle, Record, Result, Store},
    cli_command_windows as windows,
};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub configured: bool,
    pub phase: String,
    pub expected_executable: Option<String>,
    pub issues: Vec<String>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            enabled: true,
            configured: false,
            phase: "unobserved".into(),
            expected_executable: None,
            issues: Vec::new(),
        }
    }
}
#[derive(Default)]
pub struct State {
    scheduled: AtomicBool,
    serial: Mutex<()>,
    latest: Mutex<Status>,
}
#[derive(Clone, Copy)]
pub enum Action {
    Reconcile,
    Repair,
    Enable(bool),
    Remove,
}
pub fn status(app: &AppHandle) -> Status {
    app.state::<State>()
        .latest
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}
fn perform(app: &AppHandle, action: Action) -> Result<Status> {
    let home = app.path().home_dir().map_err(|_| "home-unavailable")?;
    if !home.is_absolute() {
        return Err("home-unavailable".into());
    }
    record::check(&home, true)?;
    let root = home.join(".opencodex-desktop");
    let exists = root.try_exists().map_err(|_| "io-failed")?;
    // First run checks the bundle before creating even the record directory (AM-10).
    let missing = !exists
        || !root
            .join("cli.json")
            .try_exists()
            .map_err(|_| "io-failed")?;
    let disabled = matches!(action, Action::Remove | Action::Enable(false));
    let observed = if missing && !disabled {
        Some(observe_bundle(app)?)
    } else {
        None
    };
    let initial = if missing {
        let mut r = match &observed {
            Some(b) => Record::fresh(b.clone()),
            None => Record {
                version: 1,
                owner_id: uuid::Uuid::new_v4().to_string(),
                install_id: String::new(),
                generation: 1,
                enabled: false,
                bundle: None,
                posix: None,
                windows: None,
                notify_pending: false,
                pending: None,
            },
        };
        r.install_id = crate::identity::install_id(app).ok_or("install-id-unavailable")?;
        Some(r)
    } else {
        None
    };
    perform_selected(
        root,
        &home,
        action,
        initial,
        || match observed {
            Some(b) => Ok(b),
            None => observe_bundle(app),
        },
        |enabled| {
            app.state::<State>()
                .latest
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .enabled = enabled;
        },
    )
}
fn perform_selected(
    root: std::path::PathBuf,
    home: &std::path::Path,
    action: Action,
    initial: Option<Record>,
    observe: impl FnOnce() -> Result<Bundle>,
    publish_enabled: impl FnOnce(bool),
) -> Result<Status> {
    let mut store = Store::open(root, Vec::new())?;
    let current = store.read()?;
    let enabled = match action {
        Action::Remove | Action::Enable(false) => false,
        Action::Enable(true) => true,
        _ => current
            .as_ref()
            .or(initial.as_ref())
            .is_some_and(|r| r.enabled),
    };
    #[cfg(unix)]
    let selected = if enabled {
        posix::targets(home)?
    } else {
        Vec::new()
    };
    #[cfg(not(unix))]
    let selected: Vec<(String, std::path::PathBuf)> = {
        let _ = enabled;
        Vec::new()
    };
    store.rc_allowed = selected.iter().map(|(_, p)| p.clone()).collect();
    perform_in(
        &store,
        home,
        selected,
        action,
        initial,
        observe,
        publish_enabled,
    )
}
fn observe_bundle(app: &AppHandle) -> Result<Bundle> {
    let exe = std::env::current_exe().map_err(|_| "bundle-unavailable")?;
    let version = app.package_info().version.to_string();
    #[cfg(unix)]
    {
        posix::stable_bundle(&exe, cfg!(debug_assertions), &version)
    }
    #[cfg(windows)]
    {
        windows::stable_bundle(&exe, cfg!(debug_assertions), &version)
    }
}
fn perform_in(
    store: &Store,
    home: &std::path::Path,
    selected: Vec<(String, std::path::PathBuf)>,
    action: Action,
    initial: Option<Record>,
    observe: impl FnOnce() -> Result<Bundle>,
    publish_enabled: impl FnOnce(bool),
) -> Result<Status> {
    // Initial/persisted records contain ownership history, never evidence of this launch.
    let mut r = match store.read()? {
        Some(r) => r,
        None => initial.ok_or("bundle-unavailable")?,
    };
    let explicit_remove = matches!(action, Action::Remove | Action::Enable(false));
    let desired = match action {
        Action::Enable(v) => Some(v),
        Action::Remove => Some(false),
        _ => None,
    };
    let install_bundle = if desired == Some(true) || (desired != Some(false) && r.enabled) {
        Some(observe()?)
    } else {
        None
    };
    if desired == Some(true) {
        r.bundle = install_bundle.clone();
    }
    if let Some(enabled) = desired {
        if r.enabled != enabled {
            r.enabled = enabled;
            r.generation += 1;
            if let Some(j) = &mut r.pending {
                j.next.enabled = enabled;
                j.next.generation = r.generation + 1;
            }
        }
        // Off is durable even if journal conflict prevents this cleanup attempt.
        store.save(&r)?;
    }
    publish_enabled(r.enabled);
    // A disabled interrupted install rolls back its completed prefix. It never finishes installing.
    store.recover(&mut r)?;
    // Retry settled/recovery debt before target planning, which may itself fail.
    let mut notify_issues = Vec::new();
    if let Err(e) = store.notify_with(&mut r, windows::notify) {
        notify_issues.push(e);
    }
    let remove = explicit_remove || (!r.enabled && matches!(action, Action::Reconcile));
    if !remove && !r.enabled {
        return Ok(Status {
            enabled: false,
            phase: if notify_issues.is_empty() {
                "disabled"
            } else {
                "partial"
            }
            .into(),
            issues: notify_issues,
            ..Status::default()
        });
    }
    let (next, changes, mut issues) = if remove {
        #[cfg(unix)]
        {
            posix::remove_plan(store, &r)?
        }
        #[cfg(windows)]
        {
            if let Some(b) = r.bundle.clone() {
                windows::plan(&r, b, true)?
            } else {
                (r.clone(), Vec::new(), Vec::new())
            }
        }
    } else {
        let b = install_bundle.ok_or("bundle-unavailable")?;
        #[cfg(unix)]
        {
            posix::plan(store, &r, b, home, selected)?
        }
        #[cfg(windows)]
        {
            let _ = (home, selected);
            windows::plan(&r, b, false)?
        }
    };
    let registry_changed = changes.iter().any(|c| c.kind.starts_with("registry-"));
    store.transact(
        &mut r,
        next,
        changes,
        if remove { "remove" } else { "install" },
    )?;
    issues.extend(notify_issues);
    issues.extend(store.journal_issues(&r));
    if registry_changed {
        if let Err(e) = store.notify_with(&mut r, windows::notify) {
            issues.push(e);
        }
    }
    let configured = r.enabled
        && r.bundle.is_some()
        && (r.posix.is_some() || r.windows.is_some())
        && issues.is_empty();
    let phase = if !issues.is_empty() {
        "partial"
    } else if !r.enabled {
        "disabled"
    } else if configured {
        "configured"
    } else {
        "unobserved"
    };
    Ok(Status {
        enabled: r.enabled,
        configured,
        phase: phase.into(),
        expected_executable: r.bundle.as_ref().map(|b| b.cli_executable.clone()),
        issues,
    })
}
fn run(app: &AppHandle, action: Action) -> Status {
    let state = app.state::<State>();
    let _serial = state
        .serial
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let result = match perform(app, action) {
        Ok(v) => v,
        Err(code) => {
            crate::logging::log_once("terminal command", &code);
            let mut v = status(app);
            v.configured = false;
            v.phase = if v.enabled { "blocked" } else { "partial" }.into();
            v.issues = if v.enabled {
                vec![code]
            } else {
                vec![code, "cleanup-pending".into()]
            };
            v
        }
    };
    *state
        .latest
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = result.clone();
    result
}
async fn execute(app: AppHandle, action: Action) -> Result<Status> {
    let worker_app = app.clone();
    match tauri::async_runtime::spawn_blocking(move || run(&worker_app, action)).await {
        Ok(v) => Ok(v),
        Err(_) => {
            let mut v = status(&app);
            v.configured = false;
            v.phase = "blocked".into();
            v.issues = vec!["worker-failed".into()];
            *app.state::<State>()
                .latest
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = v.clone();
            Ok(v)
        }
    }
}
pub fn reconcile_on_launch(app: &AppHandle) {
    if app.state::<State>().scheduled.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if execute(app, Action::Reconcile).await.is_err() {
            crate::logging::log_once("terminal command", "worker-failed");
        }
    });
}
pub async fn set_enabled(app: AppHandle, enabled: bool) -> Result<Status> {
    execute(app, Action::Enable(enabled)).await
}
pub async fn install(app: AppHandle) -> Result<Status> {
    execute(app, Action::Repair).await
}
pub async fn remove(app: AppHandle) -> Result<Status> {
    execute(app, Action::Remove).await
}
pub fn show_page(app: &AppHandle) {
    crate::popup::hide(app);
    if let Some(w) = app.get_webview_window("main") {
        // Fixed local URL; this works before a proxy exists, like the bundled update page.
        let origin = if cfg!(target_os = "windows") {
            "http://tauri.localhost/cli.html"
        } else {
            "tauri://localhost/cli.html"
        };
        if tauri::Url::parse(origin)
            .ok()
            .is_some_and(|url| w.navigate(url).is_ok())
        {
            crate::window::show(&w);
        } else {
            crate::logging::log_once("terminal command", "page-unavailable");
        }
    }
}

#[cfg(test)]
mod bootstrap_tests {
    use super::*;
    use record::tests::{bundle, Temp};
    #[test]
    fn first_off_and_remove_persist_disabled_intent_without_observing_a_bundle() {
        for action in [Action::Enable(false), Action::Remove] {
            let t = Temp::new();
            let root = t.0.join("record");
            let mut initial = Record::fresh(bundle());
            initial.enabled = false;
            initial.bundle = None;
            let status = perform_selected(
                root.clone(),
                &t.0,
                action,
                Some(initial),
                || panic!("disabled-must-not-observe-bundle"),
                |_| {},
            )
            .unwrap();
            assert!(!status.enabled);
            let store = Store::open(root, vec![]).unwrap();
            let r = store.read().unwrap().unwrap();
            assert!(!r.enabled && r.bundle.is_none());
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use record::tests::{bundle, Temp};
    #[test]
    fn selected_entry_refuses_unstable_bundle_before_registry_access() {
        for action in [Action::Reconcile, Action::Repair, Action::Enable(true)] {
            for error in ["development-launch", "temporary-bundle"] {
                let t = Temp::new();
                let store = t.store();
                store.save(&Record::fresh(bundle())).unwrap();
                let before = std::fs::read(store.root.join("cli.json")).unwrap();
                let root = store.root.clone();
                drop(store);
                let calls = std::cell::Cell::new(0);
                let result = perform_selected(
                    root.clone(),
                    &t.0,
                    action,
                    None,
                    || {
                        calls.set(calls.get() + 1);
                        Err(error.into())
                    },
                    // A regressed observation shortcut must stop before reaching real registry IO.
                    |_| assert_eq!(calls.get(), 1, "bundle-observation-skipped"),
                );
                assert_eq!(calls.get(), 1, "bundle-observation-skipped");
                assert_eq!(result.unwrap_err(), error);
                assert!(
                    std::fs::read(root.join("cli.json")).unwrap() == before,
                    "unstable-bundle-changed-record"
                );
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use record::tests::{bundle, Temp};
    fn selected(t: &Temp) -> Vec<(String, std::path::PathBuf)> {
        vec![("zsh".into(), t.0.join(".zshrc"))]
    }
    fn selected_observation_case(case: &str) {
        let t = Temp::new();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "cli_command::tests::selected_observation_child",
                "--nocapture",
            ])
            .env("OCX_CLI_OBSERVATION_TEST", case)
            .env("HOME", &t.0)
            .env("ZDOTDIR", &t.0)
            .env("XDG_CONFIG_HOME", t.0.join(".config"))
            .output()
            .unwrap();
        assert!(result.status.success(), "selected-observation-failed");
        assert!(
            String::from_utf8_lossy(&result.stdout).contains("1 passed"),
            "selected-observation-not-executed"
        );
    }
    #[test]
    fn selected_entry_refreshes_bundle_path_version_and_shim() {
        for action in ["reconcile", "repair", "enable"] {
            selected_observation_case(&format!("update-{action}"));
        }
    }
    #[test]
    fn selected_entry_refuses_unstable_bundle_and_preserves_existing_files() {
        for action in ["reconcile", "repair", "enable"] {
            for error in ["development-launch", "temporary-bundle"] {
                selected_observation_case(&format!("{error}-{action}"));
            }
        }
    }
    #[test]
    fn selected_observation_child() {
        let Ok(case) = std::env::var("OCX_CLI_OBSERVATION_TEST") else {
            return;
        };
        let home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap());
        let rc = home.join(".zshrc");
        let root = home.join("record");
        let store = Store::open(root.clone(), vec![rc.clone()]).unwrap();
        perform_in(
            &store,
            &home,
            vec![("zsh".into(), rc.clone())],
            Action::Reconcile,
            Some(Record::fresh(bundle())),
            || Ok(bundle()),
            |_| {},
        )
        .unwrap();
        let snapshots: Vec<_> = [
            root.join("cli.json"),
            root.join("bin/ocx"),
            root.join("path.sh"),
            rc,
        ]
        .into_iter()
        .map(|path| {
            let bytes = std::fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect();
        drop(store);
        let (scenario, action) = case.rsplit_once('-').unwrap();
        let action = match action {
            "reconcile" => Action::Reconcile,
            "repair" => Action::Repair,
            "enable" => Action::Enable(true),
            _ => panic!("observation-test-invalid"),
        };
        let calls = std::cell::Cell::new(0);
        let mut moved = bundle();
        moved.app_executable = home
            .join("Moved.app/Contents/MacOS/app")
            .to_string_lossy()
            .into_owned();
        moved.cli_executable = home
            .join("Moved.app/Contents/MacOS/ocx")
            .to_string_lossy()
            .into_owned();
        moved.version = "2".into();
        let result = perform_selected(
            root.clone(),
            &home,
            action,
            None,
            || {
                calls.set(calls.get() + 1);
                if scenario == "update" {
                    Ok(moved.clone())
                } else {
                    Err(scenario.into())
                }
            },
            |_| {},
        );
        assert_eq!(calls.get(), 1, "bundle-observation-skipped");
        if scenario == "update" {
            result.unwrap();
            let store = Store::open(root.clone(), vec![]).unwrap();
            let r = store.read().unwrap().unwrap();
            assert!(r.bundle.as_ref() == Some(&moved), "bundle-not-refreshed");
            let expected =
                posix::render_shim(std::path::Path::new(&moved.cli_executable), &r.owner_id)
                    .unwrap();
            assert!(
                std::fs::read(root.join("bin/ocx")).unwrap() == expected.as_bytes(),
                "shim-target-not-refreshed"
            );
        } else {
            assert_eq!(result.unwrap_err(), scenario);
            for (path, bytes) in snapshots {
                assert!(
                    std::fs::read(path).unwrap() == bytes,
                    "unstable-bundle-changed-files"
                );
            }
            assert!(!home.join(".zlogin").exists());
            assert!(!home.join(".bashrc").exists());
            assert!(!home.join(".config/fish/config.fish").exists());
        }
    }
    fn disabled_selector_case(action: &str) {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "cli_command::tests::disabled_selector_child",
                "--nocapture",
            ])
            .env("OCX_CLI_SELECTOR_TEST", action)
            .env("ZDOTDIR", "/invalid:zdotdir")
            .output()
            .unwrap();
        assert!(result.status.success(), "disabled-selector-failed");
        assert!(
            String::from_utf8_lossy(&result.stdout).contains("1 passed"),
            "disabled-selector-not-executed"
        );
    }
    #[test]
    fn remove_uses_recorded_targets_with_unrepresentable_zdotdir() {
        disabled_selector_case("remove");
    }
    #[test]
    fn off_uses_recorded_targets_with_unrepresentable_zdotdir() {
        disabled_selector_case("off");
    }
    #[test]
    fn disabled_reconcile_uses_recorded_targets_with_unrepresentable_zdotdir() {
        disabled_selector_case("reconcile");
    }
    #[test]
    fn disabled_selector_child() {
        let Ok(action) = std::env::var("OCX_CLI_SELECTOR_TEST") else {
            return;
        };
        let t = Temp::new();
        assert_eq!(posix::targets(&t.0).unwrap_err(), "path-unrepresentable");
        let store = t.store();
        perform_in(
            &store,
            &t.0,
            selected(&t),
            Action::Reconcile,
            Some(Record::fresh(bundle())),
            || Ok(bundle()),
            |_| {},
        )
        .unwrap();
        let action = match action.as_str() {
            "remove" => Action::Remove,
            "off" => Action::Enable(false),
            "reconcile" => {
                let mut r = store.read().unwrap().unwrap();
                r.enabled = false;
                store.save(&r).unwrap();
                Action::Reconcile
            }
            _ => panic!("selector-test-invalid"),
        };
        let root = store.root.clone();
        drop(store);
        let status = perform_selected(
            root.clone(),
            &t.0,
            action,
            None,
            || panic!("disabled-must-not-observe-bundle"),
            |_| {},
        )
        .unwrap();
        assert!(!status.enabled);
        assert!(!t.0.join(".zshrc").exists());
        assert!(!root.join("bin/ocx").exists());
        assert!(!root.join("path.sh").exists());
    }
    #[test]
    fn fresh_stable_bundle_installs_without_npm() {
        let t = Temp::new();
        let store = t.store();
        let result = perform_in(
            &store,
            &t.0,
            selected(&t),
            Action::Reconcile,
            Some(Record::fresh(bundle())),
            || Ok(bundle()),
            |_| {},
        )
        .unwrap();
        assert!(result.enabled && result.configured);
        let r = store.read().unwrap().unwrap();
        assert!(r.bundle.is_some() && r.pending.is_none());
        assert!(store.root.join("bin/ocx").is_file());
        let generation = r.generation;
        perform_in(
            &store,
            &t.0,
            selected(&t),
            Action::Reconcile,
            None,
            || Ok(bundle()),
            |_| {},
        )
        .unwrap();
        assert_eq!(store.read().unwrap().unwrap().generation, generation);
    }
    #[test]
    fn disabled_record_survives_relaunch_repair_and_tombstone_can_be_enabled() {
        let t = Temp::new();
        let store = t.store();
        let mut r = Record::fresh(bundle());
        r.enabled = false;
        r.bundle = None;
        store.save(&r).unwrap();
        for action in [Action::Reconcile, Action::Repair] {
            let result = perform_in(
                &store,
                &t.0,
                selected(&t),
                action,
                None,
                || panic!("off does not observe an install target"),
                |_| {},
            )
            .unwrap();
            assert!(!result.enabled);
            assert_eq!(result.phase, "disabled");
            assert!(!store.root.join("bin/ocx").exists());
        }
        let result = perform_in(
            &store,
            &t.0,
            selected(&t),
            Action::Enable(true),
            None,
            || Ok(bundle()),
            |_| {},
        )
        .unwrap();
        assert!(result.configured);
    }
    #[test]
    fn remove_persists_disabled_intent_before_first_cleanup_write() {
        let t = Temp::new();
        let store = t.store();
        perform_in(
            &store,
            &t.0,
            selected(&t),
            Action::Reconcile,
            Some(Record::fresh(bundle())),
            || Ok(bundle()),
            |_| {},
        )
        .unwrap();
        let shim = store.root.join("bin/ocx");
        let result = perform_in(
            &store,
            &t.0,
            selected(&t),
            Action::Remove,
            None,
            || panic!("remove has no bundle gate"),
            |enabled| {
                assert!(!enabled);
                assert!(!store.read().unwrap().unwrap().enabled);
                assert!(shim.exists());
            },
        )
        .unwrap();
        assert!(!result.enabled);
        assert_eq!(result.phase, "disabled");
        assert!(!shim.exists());
    }
    #[test]
    fn unstable_bundle_keeps_existing_record_and_files_unchanged() {
        let t = Temp::new();
        let store = t.store();
        let r = Record::fresh(bundle());
        store.save(&r).unwrap();
        let before = std::fs::read(store.root.join("cli.json")).unwrap();
        assert_eq!(
            perform_in(
                &store,
                &t.0,
                selected(&t),
                Action::Reconcile,
                None,
                || Err("development-launch".into()),
                |_| {}
            )
            .unwrap_err(),
            "development-launch"
        );
        assert_eq!(std::fs::read(store.root.join("cli.json")).unwrap(), before);
    }
}
