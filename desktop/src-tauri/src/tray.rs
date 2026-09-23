use crate::{
    exit::{self, ExitReason},
    formatting, popup,
    proxy::ProxyClient,
    updater, widget, window,
};
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
    pub menu: Mutex<Option<TrayMenu>>,
    pub installing: AtomicBool,
}

#[derive(Clone)]
pub struct TrayMenu {
    check_updates: MenuItem<Wry>,
    install_update: MenuItem<Wry>,
    stop: MenuItem<Wry>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            menu: Mutex::new(None),
            installing: AtomicBool::new(false),
        }
    }
}

/// Build the tray.
///
/// The proxy is not passed in. The tray is installed before a runtime has been resolved, so every
/// use reads the current client from the app instead of holding one that might not exist yet.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
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
    // The tray is built before the startup sequence has decided anything, so nothing owns a
    // runtime yet. Ownership arrives later and reaches this item through [`set_owned`].
    let owned = app
        .try_state::<crate::AppState>()
        .is_some_and(|state| state.owns_runtime());
    let stop = MenuItem::with_id(app, "stop-proxy", "Stop proxy", owned, None::<&str>)?;
    let check_updates = MenuItem::with_id(
        app,
        "check-updates",
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let install_update =
        MenuItem::with_id(app, "install-update", "Install update", false, None::<&str>)?;
    // Every platform needs a menu path to the popup, not only Linux.
    //
    // On macOS the icon click cannot be the only way in: `tray-icon` assigns the menu to the
    // NSStatusItem itself, so AppKit pops that menu on mouse-down before the crate's own click
    // handler runs, and `show_menu_on_left_click(false)` cannot take it back. Linux tray hosts
    // differ in whether a click reaches the application at all. That leaves Windows as the only
    // platform where the icon alone would have worked.
    let show_usage = MenuItem::with_id(app, "show-usage", "Show Usage", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_usage,
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
        *state = Some(TrayMenu {
            check_updates: check_updates.clone(),
            install_update: install_update.clone(),
            stop: stop.clone(),
        });
    }

    let builder = TrayIconBuilder::with_id("main")
        .icon(icon())
        .icon_as_template(true)
        .menu(&menu);
    // Attaching a menu makes the left click open that menu by default, which swallows the click
    // before `on_tray_icon_event` can do anything visible. On macOS and Windows that left the
    // usage popup with no way to open at all: the icon showed the menu, and the menu item that
    // opens the popup is Linux-only. Left click is the popup, right click is the menu.
    //
    // Linux keeps the default. Its StatusNotifier hosts deliver no usable click event, so the
    // menu is the entire interaction there and turning it off would remove the only way in.
    #[cfg(not(target_os = "linux"))]
    let builder = builder.show_menu_on_left_click(false);
    let tray = builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                // The icon opens the usage popup rather than the dashboard. Reading the
                // current numbers is the reason to look at a tray icon at all, and the
                // dashboard remains one menu item away. With no runtime resolved there is
                // nothing to report, so the window stays the answer.
                let app = tray.app_handle();
                match app
                    .state::<crate::AppState>()
                    .proxy()
                    .map(|proxy| proxy.endpoint())
                {
                    Some(endpoint) => {
                        let _ = popup::toggle(app, endpoint, position);
                    }
                    None => {
                        if let Some(window) = app.get_webview_window("main") {
                            window::show(&window);
                        }
                    }
                }
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show-usage" => {
                let Some(endpoint) = app
                    .state::<crate::AppState>()
                    .proxy()
                    .map(|proxy| proxy.endpoint())
                else {
                    return;
                };
                // Anchor on the icon the user just clicked. A zero anchor clamps the popup into
                // the top-left corner of the work area, which reads as a misplaced window rather
                // than a menu, and on macOS the menu is now the ordinary way in rather than a
                // fallback. Hosts that cannot report a rect still get the clamped corner, which
                // is the best available answer there.
                let anchor = tray_anchor(app);
                let _ = popup::show(app, endpoint, anchor);
            }
            "open-dashboard" => {
                crate::startup::open_dashboard(app);
            }
            "open-browser" => {
                let Some(endpoint) = app
                    .state::<crate::AppState>()
                    .proxy()
                    .map(|proxy| proxy.endpoint())
                else {
                    return;
                };
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
                // Through the coordinator, not beside it: Stop pressed twice, Stop then Quit, and
                // Stop during an update all have to be one execution over one child.
                exit::request_stop(app);
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
            // The only gesture that ends the app. It does not call `exit` itself: the coordinator
            // holds the exit, drains an app-owned runtime and only then lets the process end.
            "quit" => exit::request(app, ExitReason::UserQuit),
            _ => {}
        })
        .build(app)?;

    refresh(app, &tray);
    let tray = tray.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let Some(proxy) = app
                .try_state::<crate::AppState>()
                .and_then(|state| state.proxy())
            else {
                continue;
            };
            refresh_title(&tray, &proxy);
            tick += 1;
            if tick % 5 == 0 {
                widget::refresh(&proxy);
            }
        }
    });
    Ok(())
}

fn refresh(app: &AppHandle, tray: &tauri::tray::TrayIcon<Wry>) {
    let Some(proxy) = app
        .try_state::<crate::AppState>()
        .and_then(|state| state.proxy())
    else {
        return;
    };
    refresh_title(tray, &proxy);
    widget::refresh(&proxy);
}

/// Take a copy of the menu handles, holding the lock only for the copy.
///
/// Every Tauri menu setter dispatches to the main thread and waits for it. The tray is built *on*
/// the main thread and takes this same mutex while doing so, so calling a setter with the lock held
/// is a cycle: a background update owns the mutex and waits for the main thread, and the main
/// thread waits for the mutex. The app would stop answering Quit.
fn menu_handles(app: &AppHandle) -> Option<TrayMenu> {
    let state = app.try_state::<TrayState>()?;
    let handles = state.menu.lock().ok()?;
    handles.as_ref().cloned()
}

/// Reflect who owns the runtime in the tray's Stop item.
pub fn set_owned(app: &AppHandle, owned: bool) {
    if let Some(menu) = menu_handles(app) {
        let _ = menu.stop.set_enabled(owned);
    }
}

pub fn show_update_available(app: &AppHandle, version: &str) {
    if let Some(menu) = menu_handles(app) {
        let _ = menu.install_update.set_text(updater::update_label(version));
        let _ = menu.install_update.set_enabled(true);
        let _ = menu.check_updates.set_enabled(true);
        let _ = menu.check_updates.set_text("Check for Updates…");
    }
}

pub fn show_up_to_date(app: &AppHandle) {
    if let Some(menu) = menu_handles(app) {
        let _ = menu
            .check_updates
            .set_text(format!("Up to date (v{})", env!("CARGO_PKG_VERSION")));
        let _ = menu.check_updates.set_enabled(true);
        let _ = menu.install_update.set_enabled(false);
    }
}

pub fn is_installing(app: &AppHandle) -> bool {
    app.try_state::<TrayState>()
        .is_some_and(|state| state.installing.load(Ordering::Acquire))
}

fn set_installing(app: &AppHandle, version: &str) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.installing.store(true, Ordering::Release);
    }
    if let Some(menu) = menu_handles(app) {
        let _ = menu
            .install_update
            .set_text(format!("Installing update v{version}…"));
        let _ = menu.install_update.set_enabled(false);
        let _ = menu.check_updates.set_enabled(false);
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
        let Ok(usage) = proxy.usage_today().await else {
            return;
        };
        let quotas = proxy.quotas().await.unwrap_or(Value::Null);
        let title = render_title(&settings, &usage, &quotas);
        let _ = tray.set_title(title.as_deref());
    });
}

pub(crate) fn render_title(settings: &Value, usage: &Value, quotas: &Value) -> Option<String> {
    let settings = settings.get("settings").unwrap_or(settings);
    let metric = settings
        .get("menuBarMetric")
        .and_then(Value::as_str)
        .unwrap_or("tokens");
    let visible_summary = crate::companion_usage::filtered_summary(usage, settings);
    let summary = visible_summary.as_ref().unwrap_or(&Value::Null);
    let quota = quota_percent(quotas, settings);
    let template = settings
        .get("menuBarTemplate")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let value = match metric {
        "requests" => formatting::count(
            summary
                .get("requests")
                .and_then(crate::companion_usage::integer),
        ),
        "cost" => formatting::cost(summary.get("estimatedCostUsd").and_then(Value::as_f64)),
        "quota" => format_percent(quota),
        "none" if template.is_none() => return None,
        "none" => String::new(),
        _ => formatting::tokens(
            summary
                .get("totalTokens")
                .and_then(crate::companion_usage::integer),
        ),
    };
    let rendered = template
        .map(|value| {
            value
                .replace(
                    "{requests}",
                    &formatting::count(
                        summary
                            .get("requests")
                            .and_then(crate::companion_usage::integer),
                    ),
                )
                .replace(
                    "{totalTokens}",
                    &formatting::tokens(
                        summary
                            .get("totalTokens")
                            .and_then(crate::companion_usage::integer),
                    ),
                )
                .replace(
                    "{costUsd}",
                    &formatting::cost(summary.get("estimatedCostUsd").and_then(Value::as_f64)),
                )
                .replace(
                    "{inputTokens}",
                    &formatting::tokens(
                        summary
                            .get("inputTokens")
                            .and_then(crate::companion_usage::integer),
                    ),
                )
                .replace(
                    "{outputTokens}",
                    &formatting::tokens(
                        summary
                            .get("outputTokens")
                            .and_then(crate::companion_usage::integer),
                    ),
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

fn quota_percent(value: &Value, settings: &Value) -> Option<f64> {
    let reports = value.get("reports")?.as_array()?;
    let mut values = Vec::new();
    for report in reports {
        if crate::companion_usage::hidden(
            settings,
            crate::companion_usage::text(report, "provider"),
        ) {
            continue;
        }
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

/// Centre of the tray icon in physical pixels, for anchoring the popup.
///
/// Returns the origin when the platform cannot report a rect. `popup::geometry` clamps that into
/// the work area, so the window still appears; it simply cannot point at anything.
fn tray_anchor(app: &AppHandle) -> tauri::PhysicalPosition<f64> {
    app.tray_by_id("main")
        .and_then(|tray| tray.rect().ok().flatten())
        .map(|rect| {
            let position: tauri::PhysicalPosition<f64> = match rect.position {
                tauri::Position::Physical(value) => {
                    tauri::PhysicalPosition::new(value.x as f64, value.y as f64)
                }
                tauri::Position::Logical(value) => tauri::PhysicalPosition::new(value.x, value.y),
            };
            let size: tauri::PhysicalSize<f64> = match rect.size {
                tauri::Size::Physical(value) => {
                    tauri::PhysicalSize::new(value.width as f64, value.height as f64)
                }
                tauri::Size::Logical(value) => tauri::PhysicalSize::new(value.width, value.height),
            };
            tauri::PhysicalPosition::new(
                position.x + size.width / 2.0,
                position.y + size.height / 2.0,
            )
        })
        .unwrap_or_else(|| tauri::PhysicalPosition::new(0.0, 0.0))
}

#[cfg(test)]
mod tests {
    use super::render_title;
    use serde_json::json;

    #[test]
    fn icon_only_clears_the_title_but_a_template_and_unavailable_data_keep_their_meaning() {
        let usage = json!({"summary":{"requests":7,"totalTokens":12}});
        assert_eq!(
            render_title(
                &json!({"settings":{"menuBarMetric":"none"}}),
                &usage,
                &json!({})
            ),
            None
        );
        assert_eq!(
            render_title(
                &json!({"settings":{"menuBarMetric":"none","menuBarTemplate":"{requests}"}}),
                &usage,
                &json!({})
            ),
            Some("7".into())
        );
        assert_eq!(
            render_title(
                &json!({"settings":{"menuBarMetric":"tokens","hiddenProviders":["hidden"]}}),
                &usage,
                &json!({})
            ),
            Some("—".into())
        );
    }

    #[test]
    fn title_uses_filtered_whole_counts_and_ignores_hidden_quota_reports() {
        let settings =
            json!({"settings":{"menuBarMetric":"requests","hiddenProviders":["hidden"]}});
        let usage = json!({"summary":{"requests":99},"models":[
            {"provider":"hidden","model":"m","requests":97},
            {"provider":"visible","model":"m","requests":2}
        ]});
        assert_eq!(
            render_title(&settings, &usage, &json!({})),
            Some("2".into())
        );
        let settings = json!({"settings":{"menuBarMetric":"quota","hiddenProviders":["hidden"]}});
        let quotas = json!({"reports":[{"provider":"hidden","quota":{"weeklyPercent":1}}, {"provider":"visible","quota":{"weeklyPercent":75}}]});
        assert_eq!(render_title(&settings, &usage, &quotas), Some("75%".into()));
    }

    /// This file's own source, read at compile time, with the test module cut off.
    ///
    /// Slicing at the test attribute matters: the assertions below quote the very call names they
    /// look for, so scanning the whole file would find the test's own string literals and pass
    /// after the real calls were deleted.
    fn production_source() -> &'static str {
        include_str!("tray.rs")
            .split("#[cfg(te")
            .next()
            .expect("source has a production half")
    }

    /// A tray with a menu opens that menu on left click unless the builder says otherwise, and
    /// nothing in the type system connects the two calls. The usage popup was unreachable on
    /// macOS and Windows for exactly that reason, and the failure is quiet: the icon still
    /// responds to the click, just with the wrong surface. The menu item that opens the popup is
    /// Linux-only, so there was no second way in.
    #[test]
    fn attaching_a_menu_leaves_the_left_click_for_the_popup() {
        let source = production_source();
        assert!(
            source.contains(".menu(&menu)"),
            "tray.rs no longer attaches a menu; this pairing may no longer apply"
        );
        // The call site, not the name: the comments above explain why the flag is inert on
        // macOS, and a bare substring matched that prose instead of the builder.
        assert!(
            source.contains("builder.show_menu_on_left_click(false)"),
            "a tray with a menu must release the left click, or the popup cannot open"
        );
        assert!(
            source.contains("#[cfg(not(target_os = \"linux\"))]"),
            "Linux delivers no usable click event, so it must keep the menu on left click"
        );
    }

    /// macOS pops the attached menu from AppKit before the crate's click handler runs, so the
    /// icon click cannot be the only way to the popup. The menu item is the path that works
    /// everywhere, and platform-gating it once already left two platforms with no way in.
    #[test]
    fn the_usage_menu_item_is_not_platform_gated() {
        let source = production_source();
        let declaration = source
            .lines()
            .position(|line| line.contains("let show_usage ="))
            .expect("the menu no longer declares the usage item");
        let lines: Vec<&str> = source.lines().collect();
        // Every line that mentions the item: its declaration, its place in the menu, and the
        // event arm. None of them may sit under a platform attribute.
        let mentions = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.contains("show_usage") || line.contains("\"show-usage\""))
            .map(|(index, _)| index);
        for index in mentions {
            let previous = lines[..index]
                .iter()
                .rev()
                .find(|line| !line.trim().is_empty())
                .copied()
                .unwrap_or_default();
            assert!(
                !previous.trim_start().starts_with("#[cfg("),
                "the usage item is platform-gated at line {}; every platform needs a menu path \
                 to the popup",
                index + 1
            );
        }
        assert!(
            declaration > 0,
            "the declaration is the first line of the file"
        );
    }
}
