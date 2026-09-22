mod auth;
mod endpoint;
mod exit;
mod first_run;
mod formatting;
mod identity;
mod logging;
// macOS only: it exists to replace one item in a menu no other platform installs. Compiling it
// elsewhere would leave its contents unreachable, which -D warnings rejects.
#[cfg(target_os = "macos")]
mod menu;
mod ownership;
mod popup;
mod proxy;
mod resolve;
mod runtime_stop;
mod sidecar;
mod startup;
mod tray;
mod tray_availability;
mod updater;
mod widget;
mod window;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, MutexGuard, PoisonError,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::process::CommandChild;

pub struct AppState {
    /// Absent until the startup sequence has resolved a home and a port. Nothing guesses an
    /// endpoint any more, so there is no client to hand out before that.
    proxy: Mutex<Option<proxy::ProxyClient>>,
    child: Mutex<Option<CommandChild>>,
    /// The pid of the child this app started, if it started one.
    child_pid: Mutex<Option<u32>>,
    /// Whether the process answering the endpoint has been confirmed to be that child.
    ///
    /// Durable consent and current process ownership are different facts. Consent is a recorded
    /// claim that survives restarts; this is a statement about the process on the other end of the
    /// endpoint right now, and it has to be re-established whenever the endpoint or the answering
    /// process can have changed. Carrying a bool across an attach is how a retry that lands on a
    /// foreign runtime would still send it an owner's stop.
    confirmed: AtomicBool,
    /// The consumed spawn event stream of the child, if this app started one.
    pub watch: sidecar::SidecarWatch,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            proxy: Mutex::new(None),
            child: Mutex::new(None),
            child_pid: Mutex::new(None),
            confirmed: AtomicBool::new(false),
            watch: sidecar::SidecarWatch::default(),
        }
    }

    fn slot<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
        lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn proxy(&self) -> Option<proxy::ProxyClient> {
        Self::slot(&self.proxy).clone()
    }

    /// Point at a runtime. Nothing is owned until it is confirmed again.
    pub fn attach(&self, proxy: proxy::ProxyClient) {
        self.confirmed.store(false, Ordering::Release);
        *Self::slot(&self.proxy) = Some(proxy);
    }

    pub fn owns_runtime(&self) -> bool {
        self.confirmed.load(Ordering::Acquire)
    }

    pub fn child_pid(&self) -> Option<u32> {
        *Self::slot(&self.child_pid)
    }

    /// Confirm that the instance answering is the child this app started.
    ///
    /// This is the only thing that grants ownership. A spawn records a pid; it does not record that
    /// the pid is what holds the port, because between the two the child can exit and a service can
    /// take the port back.
    pub fn confirm_ownership(&self, identity: proxy::RuntimeIdentity) -> bool {
        let ours = self.child_pid() == Some(identity.pid);
        self.confirmed.store(ours, Ordering::Release);
        ours
    }

    pub fn adopt(&self, child: CommandChild) {
        *Self::slot(&self.child_pid) = Some(child.pid());
        *Self::slot(&self.child) = Some(child);
        // Spawned, not yet confirmed: the health probe is what establishes that this pid is the
        // one answering.
        self.confirmed.store(false, Ordering::Release);
    }

    /// Let go of a runtime that has already been drained.
    ///
    /// Dropping the handle does not signal the process — the shell plugin installs no `Drop` — so
    /// this releases ownership without reintroducing the `kill()` that D2 removed.
    pub fn release(&self) {
        self.confirmed.store(false, Ordering::Release);
        let _ = Self::slot(&self.child_pid).take();
        let _ = Self::slot(&self.child).take();
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
fn show_dashboard(app: tauri::AppHandle) {
    popup::hide(&app);
    if let Some(window) = app.get_webview_window("main") {
        window::show(&window);
    }
}

#[tauri::command]
fn hide_dashboard(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window::hide(&window);
    }
}

/// Everything the startup sequence has said so far, including the states it has already finished.
///
/// The page asks for this when it loads rather than relying only on the event stream: the first
/// states finish in milliseconds and an event emitted before the listener exists is simply gone.
///
/// It always answers with a state. Answering `None` put the one case the page cannot render — a
/// shell with no startup state — behind a value the page silently discards, which is a frozen
/// window with no diagnostic and no way to tell it from a slow start.
#[tauri::command]
fn startup_snapshot(app: tauri::AppHandle) -> startup::Progress {
    app.try_state::<startup::Startup>()
        .map(|startup| startup.latest())
        .unwrap_or_else(startup::unavailable)
}

/// The named states the startup sequence moves through, in order.
///
/// The page asks for them instead of restating them, so a state added in the shell appears in the
/// UI and one removed cannot leave a row behind.
#[tauri::command]
fn startup_phases() -> Vec<startup::PhaseInfo> {
    startup::phase_list()
}

/// Run the startup sequence again. A run already in flight is left alone.
#[tauri::command]
fn retry_startup(app: tauri::AppHandle) {
    startup::begin(&app);
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                popup::hide(app);
                window::show(&window);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        // The argument is what makes a login launch recognisable. Nothing else in a bare launch
        // distinguishes it from a person opening the app, and D7 needs the difference.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![startup::AUTOSTART_FLAG]),
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // macOS is the one platform where the event loop cannot enforce D2 on its own: Tauri's default
    // menu carries a predefined Quit wired to Cocoa's terminate:, and the pinned tao raises no
    // cancellable event for it. Replacing that one item is what lets Cmd+Q mean hide.
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(menu::build)
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()));

    builder
        .invoke_handler(tauri::generate_handler![
            show_dashboard,
            hide_dashboard,
            startup_snapshot,
            startup_phases,
            retry_startup
        ])
        .setup(|app| {
            app.manage(AppState::new());
            app.manage(updater::PendingUpdate(Mutex::new(None)));
            app.manage(tray::TrayState::default());
            app.manage(exit::ExitCoordinator::new());
            app.manage(startup::Startup::new());

            // D7: the window is created and shown before anything is registered, resolved, probed
            // or started, so every state below has somewhere to be reported. A login launch stays
            // hidden until the tray verdict, because R1 shows it after all when there turns out to
            // be nowhere to hide.
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("OpenCodex")
                    .inner_size(1100.0, 720.0)
                    .visible(false)
                    .user_agent(&window::webview_user_agent())
                    .on_navigation(window::navigation_allowed(app.handle().clone()))
                    .build()?;
            window::configure(&window);
            if startup::LaunchOrigin::detect() == startup::LaunchOrigin::User {
                window::show(&window);
            } else {
                window::set_tray_policy(app.handle(), false);
            }

            startup::begin(app.handle());

            if !cfg!(debug_assertions) {
                updater::start_background_checks(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OpenCodex desktop shell")
        .run(|app, event| {
            // Window close and the platform quit gesture arrive here as an exit request, and until
            // this handler existed they went straight through to a SIGKILL of the runtime. D2 makes
            // them hide; only the tray's Quit, and an update's coordinated restart, get past.
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                exit::on_exit_requested(app, code, &api);
            }
        });
}
