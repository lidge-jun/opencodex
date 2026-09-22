//! The macOS application menu.
//!
//! Tauri installs a default menu when the app sets none, and that menu's Quit is a predefined item
//! wired straight to Cocoa's `terminate:`. The pinned tao implements only
//! `applicationWillTerminate`, never the cancellable `applicationShouldTerminate`, so a Cmd+Q
//! through that item reaches `RunEvent::Exit` without ever raising `RunEvent::ExitRequested`.
//! Nothing can hold it, which means D2's rule — the quit gesture hides, only the tray's Quit ends
//! the app — cannot be enforced from the event loop alone on macOS. The one item is replaced here
//! with an ordinary item on the same accelerator, routed through the same gesture path as closing
//! the window.
//!
//! The rest is reproduced rather than mutated: `Menu::default` is not decomposable, and dropping it
//! would take Cut, Copy, Paste and Select All with it — which the startup diagnostic needs the user
//! to be able to use. This mirrors `tauri::menu::Menu::default` for the pinned version, minus that
//! item.

/// The id of the replacement Quit item. Nothing else in the app uses it, so a menu event carrying
/// it is unambiguously this one.
pub const QUIT_ID: &str = "app-menu-quit";
pub const USAGE_ID: &str = "app-menu-show-usage";

pub fn build(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };

    let package = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    // Labelled as a quit because that is the gesture the user is making. What it means here is
    // D2's answer to that gesture: the window goes away and the runtime keeps serving.
    let quit = MenuItem::with_id(
        app,
        QUIT_ID,
        format!("Quit {}", package.name),
        true,
        Some("CmdOrCtrl+Q"),
    )?;

    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                package.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?,
            &Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[
                    &MenuItem::with_id(
                        app,
                        USAGE_ID,
                        "Show Usage",
                        true,
                        Some("CmdOrCtrl+Shift+U"),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?,
        ],
    )
}

/// Route an application-menu event.
///
/// Tray menu events carry different ids and retain their existing owner.
pub fn on_event(app: &tauri::AppHandle, id: &str) {
    use tauri::Manager;
    if id == QUIT_ID {
        crate::exit::gesture(app);
    } else if id == USAGE_ID {
        if let Some(proxy) = app.state::<crate::AppState>().proxy() {
            let _ = crate::popup::show(
                app,
                proxy.endpoint(),
                tauri::PhysicalPosition::new(0.0, 0.0),
            );
        } else if let Some(main) = app.get_webview_window("main") {
            crate::window::show(&main);
        }
    }
}
