use crate::{formatting, proxy::ProxyClient, updater, widget, window};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

pub struct TrayState {
    pub menu: Mutex<Option<UpdateMenu>>,
    pub installing: AtomicBool,
}

pub struct UpdateMenu {
    check_updates: MenuItem<Wry>,
    install_update: MenuItem<Wry>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            menu: Mutex::new(None),
            installing: AtomicBool::new(false),
        }
    }
}

pub fn install(app: &AppHandle, proxy: ProxyClient) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open-dashboard", "Open Dashboard", true, None::<&str>)?;
    let browser = MenuItem::with_id(app, "open-browser", "Open in Browser", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(
        app,
        "start-at-login",
        "Start at Login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let spawned_by_us = app
        .state::<crate::AppState>()
        .spawned_by_us
        .load(Ordering::Relaxed);
    let stop = MenuItem::with_id(app, "stop-proxy", "Stop proxy", spawned_by_us, None::<&str>)?;
    let stop_item = stop.clone();
    let check_updates = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let install_update =
        MenuItem::with_id(app, "install-update", "Install update", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &browser,
            &PredefinedMenuItem::separator(app)?,
            &login,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &check_updates,
            &install_update,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    if let Ok(mut state) = app.state::<TrayState>().menu.lock() {
        *state = Some(UpdateMenu {
            check_updates: check_updates.clone(),
            install_update: install_update.clone(),
        });
    }

    let tray = TrayIconBuilder::with_id("main")
        .icon(icon())
        .icon_as_template(true)
        .menu(&menu)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    window::show(&window);
                }
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open-dashboard" => {
                if let Some(window) = app.get_webview_window("main") {
                    window::show(&window);
                }
            }
            "open-browser" => {
                let endpoint = app.state::<crate::AppState>().proxy.endpoint();
                let _ = app
                    .opener()
                    .open_url(format!("{}#/usage", endpoint.url("/")), None::<String>);
            }
            "start-at-login" => {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                if enabled {
                    let _ = app.autolaunch().disable();
                } else {
                    let _ = app.autolaunch().enable();
                }
            }
            "stop-proxy" => {
                if app
                    .state::<crate::AppState>()
                    .spawned_by_us
                    .load(Ordering::Relaxed)
                {
                    let proxy = app.state::<crate::AppState>().proxy.clone();
                    let app = app.clone();
                    let stop_item = stop_item.clone();
                    tauri::async_runtime::spawn(async move {
                        let stopped = proxy.stop().await.is_ok() || proxy.is_alive().await.is_err();
                        if stopped {
                            app.state::<crate::AppState>().shutdown_child();
                            let _ = stop_item.set_enabled(false);
                        }
                    });
                }
            }
            "check-updates" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    updater::check_and_show(&app).await;
                });
            }
            "install-update" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let update = app
                        .state::<crate::updater::PendingUpdate>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|mut pending| pending.take());
                    let Some(update) = update else {
                        return;
                    };
                    let version = update.version.clone();
                    let retry_update = update.clone();
                    set_installing(&app, &version);
                    if let Err(error) = updater::install(&app, update).await {
                        if let Ok(mut pending) =
                            app.state::<crate::updater::PendingUpdate>().0.lock()
                        {
                            *pending = Some(retry_update);
                        }
                        set_install_failed(&app, &version);
                        crate::logging::log_once("updater install failed", &error);
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    refresh_title(&tray, &proxy);
    widget::refresh(&proxy);
    let tray = tray.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            refresh_title(&tray, &proxy);
            tick += 1;
            if tick % 5 == 0 {
                widget::refresh(&proxy);
            }
        }
    });
    Ok(())
}

pub fn show_update_available(app: &AppHandle, version: &str) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(menu) = state.menu.lock() {
            if let Some(menu) = menu.as_ref() {
                let _ = menu.install_update.set_text(updater::update_label(version));
                let _ = menu.install_update.set_enabled(true);
                let _ = menu.check_updates.set_enabled(true);
                let _ = menu.check_updates.set_text("Check for Updates…");
            }
        }
    }
}

pub fn show_up_to_date(app: &AppHandle) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(menu) = state.menu.lock() {
            if let Some(menu) = menu.as_ref() {
                let _ = menu
                    .check_updates
                    .set_text(format!("Up to date (v{})", env!("CARGO_PKG_VERSION")));
                let _ = menu.check_updates.set_enabled(true);
                let _ = menu.install_update.set_enabled(false);
            }
        }
    }
}

pub fn is_installing(app: &AppHandle) -> bool {
    app.try_state::<TrayState>()
        .is_some_and(|state| state.installing.load(Ordering::Acquire))
}

fn set_installing(app: &AppHandle, version: &str) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.installing.store(true, Ordering::Release);
        if let Ok(menu) = state.menu.lock() {
            if let Some(menu) = menu.as_ref() {
                let _ = menu
                    .install_update
                    .set_text(format!("Installing update v{version}…"));
                let _ = menu.install_update.set_enabled(false);
                let _ = menu.check_updates.set_enabled(false);
            }
        }
    }
}

fn set_install_failed(app: &AppHandle, version: &str) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.installing.store(false, Ordering::Release);
    }
    show_update_available(app, version);
}

fn refresh_title(tray: &tauri::tray::TrayIcon<Wry>, proxy: &ProxyClient) {
    let proxy = proxy.clone();
    let tray = tray.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(settings) = proxy.companion_settings().await else {
            return;
        };
        let Ok(usage) = proxy.usage_summary().await else {
            return;
        };
        let quotas = proxy.quotas().await.unwrap_or(Value::Null);
        if let Some(title) = render_title(&settings, &usage, &quotas) {
            let _ = tray.set_title(Some(&title));
        }
    });
}

pub(crate) fn render_title(settings: &Value, usage: &Value, quotas: &Value) -> Option<String> {
    let metric = settings
        .pointer("/settings/menuBarMetric")
        .and_then(Value::as_str)
        .unwrap_or("tokens");
    let summary = usage.get("summary").unwrap_or(usage);
    let quota = quota_percent(quotas);
    let value = match metric {
        "requests" => formatting::count(summary.get("requests").and_then(Value::as_i64)),
        "cost" => formatting::cost(summary.get("estimatedCostUsd").and_then(Value::as_f64)),
        "quota" => format_percent(quota),
        "none" => return None,
        _ => formatting::tokens(summary.get("totalTokens").and_then(Value::as_i64)),
    };
    let template = settings
        .pointer("/settings/menuBarTemplate")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let rendered = template
        .map(|value| {
            value
                .replace(
                    "{requests}",
                    &formatting::count(summary.get("requests").and_then(Value::as_i64)),
                )
                .replace(
                    "{totalTokens}",
                    &formatting::tokens(summary.get("totalTokens").and_then(Value::as_i64)),
                )
                .replace(
                    "{costUsd}",
                    &formatting::cost(summary.get("estimatedCostUsd").and_then(Value::as_f64)),
                )
                .replace(
                    "{inputTokens}",
                    &formatting::tokens(summary.get("inputTokens").and_then(Value::as_i64)),
                )
                .replace(
                    "{outputTokens}",
                    &formatting::tokens(summary.get("outputTokens").and_then(Value::as_i64)),
                )
                .replace("{quotaPercent}", &format_percent(quota))
        })
        .unwrap_or(value);
    let rendered = rendered.trim();
    if rendered.is_empty() {
        None
    } else if rendered.chars().count() > 24 {
        Some(format!(
            "{}…",
            rendered.chars().take(23).collect::<String>()
        ))
    } else {
        Some(rendered.to_owned())
    }
}

fn quota_percent(value: &Value) -> Option<f64> {
    let reports = value.get("reports")?.as_array()?;
    let mut values = Vec::new();
    for report in reports {
        let Some(quota) = report.get("quota") else {
            continue;
        };
        for key in ["weeklyPercent", "monthlyPercent", "fiveHourPercent"] {
            if let Some(value) = quota.get(key).and_then(Value::as_f64) {
                values.push(value);
            }
        }
        if let Some(windows) = quota.get("customWindows").and_then(Value::as_array) {
            values.extend(
                windows
                    .iter()
                    .filter_map(|window| window.get("percent").and_then(Value::as_f64)),
            );
        }
    }
    values.into_iter().reduce(f64::min)
}

fn format_percent(value: Option<f64>) -> String {
    value
        .map(|value| format!("{}%", value.round() as i64))
        .unwrap_or_else(|| "—".into())
}

fn icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/tray/icon.png"))
        .expect("valid tray icon")
}
