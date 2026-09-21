use crate::{auth::Auth, discovery::ProxyEndpoint};
use tauri::{AppHandle, Manager, Url, WebviewWindow, WindowEvent};

pub fn webview_user_agent() -> String {
    let platform = if cfg!(target_os = "macos") {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
    } else if cfg!(target_os = "windows") {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
    } else {
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)"
    };
    format!("{platform} {}", Auth::user_agent())
}

pub fn configure(window: &WebviewWindow) {
    let window_for_close = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_for_close.hide();
            apply_tray_policy(window_for_close.app_handle(), false);
        }
    });
}

pub fn navigation_allowed(endpoint: ProxyEndpoint) -> impl Fn(&Url) -> bool {
    move |url| {
        if url.scheme() == "tauri" {
            return true;
        }
        if url.scheme() == "http" && url.host_str() == Some(endpoint.host) {
            return url.port_or_known_default() == Some(endpoint.port);
        }
        if matches!(url.scheme(), "http" | "https") {
            let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            return false;
        }
        url.scheme() == "about" && url.as_str() == "about:blank"
    }
}

pub fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
    apply_tray_policy(window.app_handle(), true);
}

pub fn hide(window: &WebviewWindow) {
    let _ = window.hide();
    apply_tray_policy(window.app_handle(), false);
}

#[cfg(target_os = "macos")]
fn apply_tray_policy(app: &AppHandle, visible: bool) {
    let policy = if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };
    let _ = app.set_dock_visibility(visible);
    let _ = app.set_activation_policy(policy);
}

#[cfg(not(target_os = "macos"))]
fn apply_tray_policy(_app: &AppHandle, _visible: bool) {}

pub fn set_tray_policy(app: &AppHandle, visible: bool) {
    apply_tray_policy(app, visible);
}

#[cfg(test)]
mod tests {
    use super::webview_user_agent;

    #[test]
    fn webview_user_agent_marks_the_desktop_shell() {
        let user_agent = webview_user_agent();
        assert!(user_agent.starts_with("Mozilla/5.0 "));
        assert!(user_agent.contains("OpenCodexDesktop/"));
        if cfg!(target_os = "macos") {
            assert!(user_agent.contains("(Macintosh; Intel Mac OS X 10_15_7)"));
        } else if cfg!(target_os = "windows") {
            assert!(user_agent.contains("(Windows NT 10.0; Win64; x64)"));
        } else {
            assert!(user_agent.contains("(X11; Linux x86_64)"));
        }
    }
}
