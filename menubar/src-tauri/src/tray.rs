use tauri::{
    App, AppHandle, Manager,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

pub fn setup_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let _tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("OpenCodex")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                toggle_popover(app);
            }
        })
        .build(app)?;
    Ok(())
}

fn toggle_popover(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("popover") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            position_near_tray(app, &window);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn position_near_tray(_app: &AppHandle, window: &tauri::WebviewWindow) {
    // Position window at top-right of screen, below the menu bar
    if let Ok(monitor) = window.primary_monitor() {
        if let Some(monitor) = monitor {
            let screen_size = monitor.size();
            let scale = monitor.scale_factor();
            let win_width = 360.0;
            let menu_bar_height = 25.0;

            let x = (screen_size.width as f64 / scale) - win_width - 10.0;
            let y = menu_bar_height + 4.0;

            let _ = window.set_position(tauri::Position::Logical(
                tauri::LogicalPosition::new(x, y),
            ));
        }
    }
}
