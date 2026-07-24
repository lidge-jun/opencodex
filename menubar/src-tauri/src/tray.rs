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
                position,
                ..
            } = event
            {
                let app = tray.app_handle();
                toggle_popover(app, Some(position.into()));
            }
        })
        .build(app)?;

    // Dismiss popover when it loses focus
    if let Some(window) = app.get_webview_window("popover") {
        let app_handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(false) = event {
                if let Some(w) = app_handle.get_webview_window("popover") {
                    let _ = w.hide();
                }
            }
        });
    }

    Ok(())
}

fn toggle_popover(app: &AppHandle, click_position: Option<tauri::Position>) {
    if let Some(window) = app.get_webview_window("popover") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            position_near_tray(app, &window, click_position);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn position_near_tray(app: &AppHandle, window: &tauri::WebviewWindow, click_position: Option<tauri::Position>) {
    // Use the monitor containing the click position, or fall back to primary
    let monitor = if let Some(tauri::Position::Physical(pos)) = click_position {
        app.monitor_from_point(pos.x as f64, pos.y as f64)
            .ok()
            .flatten()
            .or_else(|| window.current_monitor().ok().flatten())
    } else {
        window.current_monitor().ok().flatten()
    };

    if let Some(monitor) = monitor {
        let screen_size = monitor.size();
        let scale = monitor.scale_factor();
        let screen_pos = monitor.position();
        let win_width = 380.0; // match tauri.conf.json window width
        let menu_bar_height = 25.0;

        let x = (screen_pos.x as f64 / scale) + (screen_size.width as f64 / scale) - win_width - 10.0;
        let y = (screen_pos.y as f64 / scale) + menu_bar_height + 4.0;

        let _ = window.set_position(tauri::Position::Logical(
            tauri::LogicalPosition::new(x, y),
        ));
    }
}
