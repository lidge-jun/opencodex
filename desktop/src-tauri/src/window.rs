use crate::{auth::Auth, exit, AppState};
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

/// Decide what closing this window means, at the moment it is closed.
///
/// The answer is not known when the window is built: on Linux it depends on a session-bus probe
/// that the startup sequence runs afterwards. So it is read here rather than captured. With a tray
/// a close hides and the runtime keeps serving; without one there is nowhere to hide, so D6 makes
/// the close a quit — and it takes the same graceful drain the tray's Quit does.
pub fn configure(window: &WebviewWindow) {
    let window_for_close = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            exit::gesture(window_for_close.app_handle());
        }
    });
}

/// Where this window may navigate.
///
/// The loopback endpoint is read from the app rather than captured, because the window now exists
/// before anything has been resolved. Until it has, an http target is refused outright instead of
/// being handed to the browser: nothing should be navigating anywhere yet, and opening an
/// unresolved address in the user's browser is a worse answer than doing nothing.
pub fn navigation_allowed(app: AppHandle) -> impl Fn(&Url) -> bool {
    move |url| {
        if is_app_origin(url) {
            return true;
        }
        if url.scheme() == "about" && url.as_str() == "about:blank" {
            return true;
        }
        let endpoint = app
            .try_state::<AppState>()
            .and_then(|state| state.proxy())
            .map(|proxy| proxy.endpoint());
        if let Some(endpoint) = endpoint {
            if url.scheme() == "http" && url.host_str() == Some(endpoint.host) {
                return url.port_or_known_default() == Some(endpoint.port);
            }
            if matches!(url.scheme(), "http" | "https") {
                let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
            }
        }
        false
    }
}

/// The bundled `frontendDist` origin.
///
/// Tauri serves it as `tauri://localhost` on macOS and Linux, and as `http://tauri.localhost` on
/// Windows, where WebView2 has no custom-scheme support. Without that second spelling the window's
/// first navigation to its own page on Windows falls through to the branch that hands a URL to the
/// external browser.
///
/// It is that one host and nothing near it. `https` is not the scheme the pinned Tauri serves the
/// app over, and a port means something else is answering rather than the app — neither localhost
/// generally, nor a name that merely ends in it, is this origin.
fn is_app_origin(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" => url.host_str() == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
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
    use super::{is_app_origin, webview_user_agent};
    use tauri::Url;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("a url")
    }

    #[test]
    fn the_app_origin_is_allowed_by_both_spellings_on_every_platform() {
        // The custom scheme everywhere, and the http spelling WebView2 needs on Windows. The
        // second is not gated on the platform: the origin is the app's wherever it is served.
        assert!(is_app_origin(&url(
            "tauri://localhost/index.html?port=10100"
        )));
        assert!(is_app_origin(&url(
            "http://tauri.localhost/index.html?port=10100"
        )));
    }

    #[test]
    fn nothing_near_that_origin_is_that_origin() {
        for value in [
            // Not the scheme the pinned Tauri serves the app over.
            "https://tauri.localhost/index.html",
            // A port means something else is answering.
            "http://tauri.localhost:8080/",
            // Neither localhost generally nor a name that merely contains it.
            "http://localhost/",
            "http://127.0.0.1/",
            "http://evil.tauri.localhost/",
            "http://tauri.localhost.example.com/",
            "file:///C:/index.html",
        ] {
            assert!(!is_app_origin(&url(value)), "{value}");
        }
    }

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

    /// The zoom polyfill runs inside the loopback dashboard, which is a remote origin to Tauri. The
    /// capability that lets it call `set_webview_zoom` is the only one reaching that origin, so it
    /// stays pinned to this window, this origin and this one command.
    #[test]
    fn the_dashboard_reaches_only_the_zoom_command() {
        let zoom: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/dashboard-zoom.json"))
                .expect("dashboard-zoom capability is JSON");
        assert_eq!(zoom["windows"], serde_json::json!(["main"]));
        assert_eq!(
            zoom["remote"]["urls"],
            serde_json::json!(["http://127.0.0.1:*"])
        );
        assert_eq!(
            zoom["permissions"],
            serde_json::json!(["core:webview:allow-set-webview-zoom"])
        );

        // Tauri matches the origin with URLPattern; the dashboard is the loopback endpoint on
        // whatever port it resolved to, and nothing beside it.
        let pattern: tauri_utils::acl::RemoteUrlPattern =
            "http://127.0.0.1:*".parse().expect("a URL pattern");
        let dashboard = crate::endpoint::ProxyEndpoint {
            host: "127.0.0.1",
            port: 10100,
        }
        .url("/#/usage");
        assert!(pattern.test(&url(&dashboard)), "{dashboard}");
        for value in [
            "http://localhost:10100/",
            "https://127.0.0.1:10100/",
            "http://127.0.0.2:10100/",
            "http://example.com/",
        ] {
            assert!(!pattern.test(&url(value)), "{value}");
        }

        let default: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("default capability is JSON");
        assert!(default.get("remote").is_none());
    }
}
