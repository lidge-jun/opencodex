//! The macOS tray's Start at Login item (#6972).
//!
//! The item shows what [`login_registration::judge`] verifies, the judgment Startup safety uses,
//! and is checked only for [`LoginState::On`]. Reading launchd runs subprocesses, so every probe
//! runs on a blocking worker; one mutex serializes probes with the mutation a click performs.
//!
//! Presentation is applied in one closure on the main thread, the thread that also delivers
//! clicks, so a click and a refresh can never interleave their setters. muda flips a check item
//! before the click reaches the app; the click handler puts back what was shown and holds the
//! item disabled until its own job answers, and refresh results that land meanwhile are dropped.

use crate::login_registration::{self, ClickAction, LoginState};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex, PoisonError,
};
use std::time::{Duration, Instant};
use tauri::{menu::CheckMenuItem, AppHandle, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

const HOVER_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct LoginTray {
    /// The state the item shows; `None` until the first probe answers.
    shown: Mutex<Option<LoginState>>,
    /// Clicks whose job has not applied its answer yet.
    pending: AtomicUsize,
    /// Serializes probes and the mutation a click performs.
    probe: Mutex<()>,
    /// When hovering last asked for a refresh.
    hovered: Mutex<Option<Instant>>,
}

/// The item as built, before anything has been verified: unchecked and inert.
pub fn item(app: &AppHandle) -> tauri::Result<CheckMenuItem<Wry>> {
    app.manage(LoginTray::default());
    let state = LoginState::Unknown;
    CheckMenuItem::with_id(
        app,
        "start-at-login",
        state.label(),
        state.clickable(),
        state.checked(),
        None::<&str>,
    )
}

fn judge(app: &AppHandle) -> LoginState {
    match app.path().home_dir() {
        Ok(home) => login_registration::judge(&home),
        Err(_) => LoginState::Unknown,
    }
}

/// Show `state`. A refresh (`click == false`) yields to any click still waiting for its answer.
fn present(app: &AppHandle, state: LoginState, click: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(login) = handle.try_state::<LoginTray>() else {
            return;
        };
        if click {
            login.pending.fetch_sub(1, Ordering::AcqRel);
        } else if login.pending.load(Ordering::Acquire) > 0 {
            return;
        }
        *login.shown.lock().unwrap_or_else(PoisonError::into_inner) = Some(state);
        let busy = login.pending.load(Ordering::Acquire) > 0;
        if let Some(menu) = crate::tray::menu_handles(&handle) {
            let _ = menu.login.set_text(state.label());
            let _ = menu.login.set_checked(state.checked());
            let _ = menu.login.set_enabled(state.clickable() && !busy);
        }
    });
}

/// Probe again unless a probe or a click is already running.
pub fn refresh(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(login) = app.try_state::<LoginTray>() else {
            return;
        };
        let Ok(_probe) = login.probe.try_lock() else {
            return;
        };
        let state = judge(&app);
        present(&app, state, false);
    });
}

/// The pointer entered the status item: the menu may be about to open.
pub fn hover(app: &AppHandle) {
    let Some(login) = app.try_state::<LoginTray>() else {
        return;
    };
    {
        let mut hovered = login.hovered.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        if hovered.is_some_and(|last| now.duration_since(last) < HOVER_INTERVAL) {
            return;
        }
        *hovered = Some(now);
    }
    refresh(app);
}

/// Handle a click on the item. Runs on the main thread and never waits for a probe.
pub fn click(app: &AppHandle) {
    let Some(login) = app.try_state::<LoginTray>() else {
        return;
    };
    let shown = login
        .shown
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .unwrap_or(LoginState::Unknown);
    login.pending.fetch_add(1, Ordering::AcqRel);
    if let Some(menu) = crate::tray::menu_handles(app) {
        let _ = menu.login.set_checked(shown.checked());
        let _ = menu.login.set_enabled(false);
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = match app.try_state::<LoginTray>() {
            Some(login) => {
                let _probe = login.probe.lock().unwrap_or_else(PoisonError::into_inner);
                let fresh = judge(&app);
                // The click answered what was shown. If the registration has changed since, the
                // person has not seen the new state yet: show it and do nothing else.
                if fresh == shown && fresh.click_action() != ClickAction::Nothing {
                    perform(&app, fresh.click_action());
                    judge(&app)
                } else {
                    fresh
                }
            }
            None => LoginState::Unknown,
        };
        present(&app, state, true);
    });
}

fn perform(app: &AppHandle, action: ClickAction) {
    let result = match action {
        ClickAction::Disable => app
            .autolaunch()
            .disable()
            .map_err(|error| error.to_string()),
        ClickAction::Enable => crate::login_autostart::enable(app),
        // launchd keeps its override whatever the plist says; the person turns it back on.
        ClickAction::OpenLoginItems => crate::process_spawn::with_spawn(|| {
            app.opener()
                .open_url(login_registration::LOGIN_ITEMS_SETTINGS, None::<String>)
        })
        .map_err(|error| error.to_string()),
        ClickAction::Nothing => Ok(()),
    };
    if let Err(error) = result {
        crate::logging::log_once("start at login", &error);
    }
}
