mod auth;
mod discovery;
mod first_run;
mod formatting;
mod logging;
mod proxy;
mod sidecar;
mod tray;
mod updater;
mod widget;
mod window;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::process::CommandChild;

pub struct AppState {
    pub proxy: proxy::ProxyClient,
    pub spawned_by_us: AtomicBool,
    pub child: Mutex<Option<CommandChild>>,
}

impl AppState {
    pub fn shutdown_child(&self) {
        if !self.spawned_by_us.swap(false, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
    }
}

#[tauri::command]
fn show_dashboard(app: tauri::AppHandle) {
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                window::show(&window);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![show_dashboard, hide_dashboard])
        .setup(|app| {
            let (endpoint, home) = discovery::current();
            let proxy = proxy::ProxyClient::new(endpoint, auth::Auth::new(home))
                .map_err(|error| error.to_string())?;
            let child = tauri::async_runtime::block_on(sidecar::ensure_proxy(
                app.handle(),
                &proxy,
                endpoint,
            ))
            .map_err(std::io::Error::other)?;
            app.manage(AppState {
                proxy: proxy.clone(),
                spawned_by_us: AtomicBool::new(child.is_some()),
                child: Mutex::new(child),
            });
            app.manage(updater::PendingUpdate(Mutex::new(None)));
            app.manage(tray::TrayState::default());

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App(format!("index.html?port={}", endpoint.port).into()),
            )
            .title("OpenCodex")
            .inner_size(1100.0, 720.0)
            .visible(false)
            .user_agent(&window::webview_user_agent())
            .on_navigation(window::navigation_allowed(endpoint))
            .build()?;
            window::configure(&window);
            window::set_tray_policy(app.handle(), false);
            let dashboard = endpoint.url("/#/usage");
            if tauri::async_runtime::block_on(proxy.is_alive()).is_ok() {
                let _ = window.eval(format!("window.location.replace({dashboard:?})"));
            }
            // Before the tray, so its Start at Login checkbox reads the state this leaves behind
            // rather than the state from before first run.
            first_run::apply_start_at_login_default(app.handle());
            tray::install(app.handle(), proxy)?;
            if !cfg!(debug_assertions) {
                updater::start_background_checks(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OpenCodex desktop shell")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<AppState>() {
                    state.shutdown_child();
                }
            }
        });
}
