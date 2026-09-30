use crate::{auth::Auth, exit, AppState};
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewWindow, WindowEvent};

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
            open_in_default_browser(url);
        }
        false
    }
}

/// Whether a URL the dashboard asked for belongs in the user's default browser.
///
/// Only web addresses leave the app. Anything else a page could name (`file:`, `javascript:`,
/// a custom scheme) has no business being handed to the OS launcher from a webview.
fn opens_in_default_browser(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

pub fn open_in_default_browser(url: &Url) {
    if opens_in_default_browser(url) {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

/// What a `window.open` or `target="_blank"` link from a shell webview does.
///
/// The shell never grows a second webview: every such request is answered in the default
/// browser and the in-app window is denied. Without this handler the pinned wry answers the
/// request itself, and on no platform does that reach a browser: WebView2 marks it handled and
/// drops it, WebKitGTK creates nothing, and WKWebView only gets there when its navigation policy
/// happens to see the URL first. That is how the dashboard's "didn't open? open the login page"
/// link, and the device-code logins that rely on it, did nothing in the app.
///
/// It is also why the opener plugin's click interceptor is switched off in `lib.rs`: that script
/// cancels a `_blank` click and asks for `plugin:opener|open_url` over IPC, which the loopback
/// dashboard is not granted, so the click was consumed and nothing opened. Routing links here
/// instead keeps the decision in one Rust function and adds no IPC grant to a remote origin.
pub fn open_new_windows_in_default_browser<R: Runtime>(
) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<R> + Send + 'static {
    |url, _features| {
        open_in_default_browser(&url);
        NewWindowResponse::Deny
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
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" => url.host_str() == Some("tauri.localhost") && url.port().is_none(),
        _ => false,
    }
}

pub fn require_update_page(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("update page unavailable".into());
    }
    let url = window.url().map_err(|_| "update page unavailable")?;
    if !is_update_page_url(&url) {
        return Err("update page unavailable".into());
    }
    Ok(())
}

fn is_update_page_url(url: &Url) -> bool {
    is_app_origin(url) && url.path() == "/update.html"
}

/// Whether the window currently shows the bundled update page. An unreadable URL reads as not.
pub fn shows_update_page(window: &WebviewWindow) -> bool {
    window.url().is_ok_and(|url| is_update_page_url(&url))
}

pub fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
    report_visibility(window, true);
    apply_tray_policy(window.app_handle(), true);
}

pub fn hide(window: &WebviewWindow) {
    let _ = window.hide();
    report_visibility(window, false);
    apply_tray_policy(window.app_handle(), false);
}

/// Tell the main window's page whether its host window is visible.
///
/// Windows WebView2 does not flip `document.visibilityState` when the host window is hidden
/// (tauri issues #10592 and #6864), so the dashboard's pollers keep running while the app sits in
/// the tray; macOS WKWebView does flip it. Publishing the host's own answer gives the GUI one
/// signal on every platform instead of one that is correct on only some of them.
///
/// Only the `main` window publishes: `exit::hide_windows` hides every window through `hide`,
/// and the tray popup carries its own equivalent bridge, so an unguarded report would claim the
/// dashboard was hidden because a popup was. A page that has not loaded yet simply misses the eval;
/// the page-load hook re-sends the current state.
pub fn report_visibility(window: &WebviewWindow, visible: bool) {
    if window.label() != "main" {
        return;
    }
    let script = format!(
        "window.__OPENCODEX_HOST_VISIBLE__ = {visible}; window.dispatchEvent(new CustomEvent('opencodex:host-visibility', {{detail: {visible}}}));"
    );
    let _ = window.eval(script);
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
    use super::{is_app_origin, is_update_page_url, opens_in_default_browser, webview_user_agent};
    use tauri::Url;

    fn url(value: &str) -> Url {
        Url::parse(value).expect("a url")
    }

    #[test]
    fn only_web_addresses_are_handed_to_the_default_browser() {
        for value in [
            "https://auth.openai.com/oauth/authorize?client_id=x",
            "https://github.com/login/device",
            "http://127.0.0.1:1455/auth/callback",
        ] {
            assert!(opens_in_default_browser(&url(value)), "{value}");
        }
        for value in [
            "about:blank",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost/index.html",
            "mailto:someone@example.com",
        ] {
            assert!(!opens_in_default_browser(&url(value)), "{value}");
        }
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
    fn only_the_bundled_update_page_has_update_commands() {
        for value in [
            "tauri://localhost/update.html",
            "http://tauri.localhost/update.html",
        ] {
            assert!(is_update_page_url(&url(value)), "{value}");
        }
        for value in [
            "http://127.0.0.1:10100/update.html",
            "tauri://evil/update.html",
            "tauri://localhost/index.html",
            "http://tauri.localhost/update.html.evil",
        ] {
            assert!(!is_update_page_url(&url(value)), "{value}");
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

    /// The overlay title bar is moved and zoomed from the page: the dashboard's top strips call
    /// `plugin:window|start_dragging` and `plugin:window|toggle_maximize` from the loopback
    /// origin, and the bundled pages do the same from the app origin. The dashboard also reads
    /// the window's native scale so its traffic-light clearance survives page zoom. Grants are
    /// pinned to `main`; the app origin needs only the two window commands.
    #[test]
    fn the_titlebar_commands_are_granted_on_each_origin() {
        let titlebar: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/dashboard-titlebar.json"))
                .expect("dashboard-titlebar capability is JSON");
        assert_eq!(titlebar["windows"], serde_json::json!(["main"]));
        assert_eq!(
            titlebar["remote"]["urls"],
            serde_json::json!(["http://127.0.0.1:*"])
        );
        assert_eq!(
            titlebar["permissions"],
            serde_json::json!([
                "core:window:allow-start-dragging",
                "core:window:allow-toggle-maximize",
                "core:window:allow-scale-factor"
            ])
        );

        let default: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("default capability is JSON");
        let permissions = default["permissions"].as_array().expect("permissions list");
        for permission in [
            "core:window:allow-start-dragging",
            "core:window:allow-toggle-maximize",
        ] {
            assert!(
                permissions.contains(&serde_json::json!(permission)),
                "default capability grants {permission}"
            );
        }
    }
}
