#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    Manager,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Position, Size,
};

fn physical_position(pos: &Position) -> (f64, f64) {
    match pos {
        Position::Physical(p) => (p.x as f64, p.y as f64),
        Position::Logical(p) => (p.x, p.y),
    }
}

fn physical_size(size: &Size) -> (f64, f64) {
    match size {
        Size::Physical(s) => (s.width as f64, s.height as f64),
        Size::Logical(s) => (s.width, s.height),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let window = app.get_webview_window("panel").unwrap();

            TrayIconBuilder::new()
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let win = tray.app_handle().get_webview_window("panel").unwrap();
                        if win.is_visible().unwrap_or(false) {
                            let _ = win.hide();
                        } else {
                            // Position near the tray icon
                            if let Ok(Some(rect)) = tray.rect() {
                                let (tray_x, tray_y) = physical_position(&rect.position);
                                let (tray_w, tray_h) = physical_size(&rect.size);
                                let win_size = win.outer_size().unwrap_or_default();
                                let (win_w, _) = physical_size(&Size::Physical(win_size));
                                let x = tray_x - (win_w / 2.0) + (tray_w / 2.0);
                                let y = tray_y + tray_h + 4.0;
                                let _ = win.set_position(Position::Physical(tauri::PhysicalPosition {
                                    x: x as i32,
                                    y: y as i32,
                                }));
                            }
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Hide on blur
            let win_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = win_clone.hide();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
