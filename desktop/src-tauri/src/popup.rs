use crate::{endpoint::ProxyEndpoint, window};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
#[cfg(target_os = "macos")]
use tauri::window::EffectState;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use tauri::window::{Effect, EffectsBuilder};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, Url, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

pub const LABEL: &str = "usage-popup";
pub const TRAY_PATH: &str = "/#/tray";
pub const DASHBOARD_PATH: &str = "/?desktop=open#/usage";
pub const CLOSE_PATH: &str = "/?desktop=popup-close#/tray-close";
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub const VIBRANT_SURFACE: bool = true;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub const VIBRANT_SURFACE: bool = false;
const TRAY_VIBRANCY_DATASET: &str = "document.documentElement.dataset.trayVibrancy";
pub const ESCAPE_INITIALIZATION_SCRIPT: &str = r#"
(() => {
  window.__OPENCODEX_TRAY_VISIBLE__ = false;
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    window.location.replace("/?desktop=popup-close#/tray-close");
  }, true);
})();
"#;

fn initialization_script() -> String {
    let tray_vibrancy = if VIBRANT_SURFACE { "on" } else { "off" };
    format!(
        r#"{TRAY_VIBRANCY_DATASET} = "{tray_vibrancy}";
{ESCAPE_INITIALIZATION_SCRIPT}"#
    )
}

/// How long after being shown the popup ignores losing focus.
///
/// Closing on focus loss is what makes this feel like a menu rather than a window. The cost is
/// that a platform which hands focus back to the tray, the shell, or nothing at all right after
/// the click closes the popup in the same gesture that opened it -- the user sees a flash and no
/// window. A short grace period keeps the dismiss behaviour while making that race unreachable;
/// it is deliberately shorter than a deliberate click elsewhere.
const FOCUS_GRACE: Duration = Duration::from_millis(400);

/// Monotonic milliseconds since process start, written when the popup is shown.
static SHOWN_AT_MS: AtomicU64 = AtomicU64::new(0);

fn process_start() -> Instant {
    use std::sync::OnceLock;
    static START: OnceLock<Instant> = OnceLock::new();
    *START.get_or_init(Instant::now)
}

fn mark_shown() {
    let elapsed = process_start().elapsed().as_millis() as u64;
    SHOWN_AT_MS.store(elapsed, Ordering::Release);
}

fn within_focus_grace() -> bool {
    let shown = SHOWN_AT_MS.load(Ordering::Acquire);
    if shown == 0 {
        return false;
    }
    let now = process_start().elapsed().as_millis() as u64;
    now.saturating_sub(shown) < FOCUS_GRACE.as_millis() as u64
}

const WIDTH_LOGICAL: f64 = 440.0;
const HEIGHT_LOGICAL: f64 = 700.0;
const EDGE_PHYSICAL: i64 = 8;
const GAP_PHYSICAL: i64 = 6;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PopupGeometry {
    pub position: PhysicalPosition<i32>,
    pub size: PhysicalSize<u32>,
}

/// Calculates a tray-anchored physical rectangle. `anchor` and `work_area` are physical pixels;
/// `scale_factor` only converts the logical 440x700 design size, so mixed-DPI monitors stay exact.
pub fn geometry(
    anchor: PhysicalPosition<f64>,
    work_area: PhysicalRect<i32, u32>,
    scale_factor: f64,
) -> PopupGeometry {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let edge = EDGE_PHYSICAL;
    let gap = GAP_PHYSICAL;
    let left = work_area.position.x as i64;
    let top = work_area.position.y as i64;
    let right = left + work_area.size.width as i64;
    let bottom = top + work_area.size.height as i64;
    let available_width = (right - left - edge * 2).max(1) as u32;
    let available_height = (bottom - top - edge * 2).max(1) as u32;
    let width = ((WIDTH_LOGICAL * scale).round() as u32).min(available_width);
    let height = ((HEIGHT_LOGICAL * scale).round() as u32).min(available_height);
    let width_i = width as i64;
    let height_i = height as i64;
    let min_x = left + edge;
    let max_x = (right - edge - width_i).max(min_x);
    let min_y = top + edge;
    let max_y = (bottom - edge - height_i).max(min_y);
    let anchor_x = anchor.x.round() as i64;
    let anchor_y = anchor.y.round() as i64;
    let x = (anchor_x - width_i / 2).clamp(min_x, max_x);
    let below = anchor_y + gap;
    let above = anchor_y - gap - height_i;
    let y = if below <= max_y { below } else { above }.clamp(min_y, max_y);

    PopupGeometry {
        position: PhysicalPosition::new(x as i32, y as i32),
        size: PhysicalSize::new(width, height),
    }
}

pub fn show(
    app: &AppHandle,
    endpoint: ProxyEndpoint,
    anchor: PhysicalPosition<f64>,
) -> tauri::Result<()> {
    let popup = ensure(app, endpoint)?;
    if let Some(monitor) = popup
        .monitor_from_point(anchor.x, anchor.y)
        .ok()
        .flatten()
        .or_else(|| popup.primary_monitor().ok().flatten())
    {
        let layout = geometry(anchor, *monitor.work_area(), monitor.scale_factor());
        let _ = popup.set_size(layout.size);
        let _ = popup.set_position(layout.position);
    }
    if popup
        .url()
        .map(|url| !is_tray_url(&url, endpoint))
        .unwrap_or(true)
    {
        popup.navigate(proxy_url(endpoint, TRAY_PATH))?;
    }
    let was_visible = popup.is_visible().unwrap_or(false);
    mark_shown();
    popup.show()?;
    popup.set_focus()?;
    if !was_visible {
        set_visibility(&popup, true);
    }
    Ok(())
}

pub fn toggle(
    app: &AppHandle,
    endpoint: ProxyEndpoint,
    anchor: PhysicalPosition<f64>,
) -> tauri::Result<()> {
    if app
        .get_webview_window(LABEL)
        .and_then(|popup| popup.is_visible().ok())
        .unwrap_or(false)
    {
        hide(app);
        Ok(())
    } else {
        show(app, endpoint, anchor)
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(popup) = app.get_webview_window(LABEL) {
        if popup.is_visible().unwrap_or(false) {
            let _ = popup.hide();
            set_visibility(&popup, false);
        }
    }
}

fn ensure(app: &AppHandle, endpoint: ProxyEndpoint) -> tauri::Result<WebviewWindow> {
    if let Some(popup) = app.get_webview_window(LABEL) {
        return Ok(popup);
    }

    let app_handle = app.clone();
    let mut builder = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::External(proxy_url(endpoint, TRAY_PATH)),
    )
    .title("OpenCodex Usage")
    .inner_size(WIDTH_LOGICAL, HEIGHT_LOGICAL)
    .max_inner_size(WIDTH_LOGICAL, HEIGHT_LOGICAL)
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .user_agent(&window::webview_user_agent())
    .initialization_script(initialization_script())
    .on_navigation(popup_navigation_allowed(endpoint, app_handle.clone()))
    .on_page_load(|popup, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            set_visibility(&popup, popup.is_visible().unwrap_or(false));
        }
    });
    if VIBRANT_SURFACE {
        builder = builder.transparent(true);
        #[cfg(target_os = "macos")]
        {
            builder = builder.effects(
                EffectsBuilder::new()
                    .effect(Effect::HudWindow)
                    .state(EffectState::Active)
                    .radius(12.0)
                    .build(),
            );
        }
        #[cfg(target_os = "windows")]
        {
            builder = builder.effects(EffectsBuilder::new().effect(Effect::Acrylic).build());
        }
    }
    let popup = builder.build()?;
    popup.on_window_event(move |event| match event {
        WindowEvent::Focused(false) if !within_focus_grace() => {
            hide(&app_handle);
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide(&app_handle);
        }
        _ => {}
    });
    Ok(popup)
}

fn popup_navigation_allowed(
    endpoint: ProxyEndpoint,
    app: AppHandle,
) -> impl Fn(&Url) -> bool + Send + 'static {
    move |url| {
        if !same_origin(url, endpoint) {
            return false;
        }
        if is_close_url(url, endpoint) {
            hide(&app);
            return false;
        }
        if is_dashboard_url(url, endpoint) {
            hide(&app);
            if let Some(main) = app.get_webview_window("main") {
                window::show(&main);
                let _ = main.navigate(url.clone());
            }
            return false;
        }
        is_tray_url(url, endpoint)
    }
}

fn proxy_url(endpoint: ProxyEndpoint, path: &str) -> Url {
    endpoint
        .url(path)
        .parse()
        .expect("proxy endpoint URL is valid")
}

fn same_origin(url: &Url, endpoint: ProxyEndpoint) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some(endpoint.host)
        && url.port_or_known_default() == Some(endpoint.port)
}

/// Split one of the paths above into the query and fragment a navigation must carry.
///
/// The matchers read the constant instead of restating it. A matcher that restated it would
/// keep answering yes after the page it names moved, and these three decide what the popup is
/// allowed to navigate to, so a stale yes is the failure that matters.
fn parts(path: &str) -> (Option<&str>, Option<&str>) {
    let (before_fragment, fragment) = match path.split_once('#') {
        Some((before, fragment)) => (before, Some(fragment)),
        None => (path, None),
    };
    (
        before_fragment.split_once('?').map(|(_, query)| query),
        fragment,
    )
}

fn matches(url: &Url, endpoint: ProxyEndpoint, path: &str) -> bool {
    let (query, fragment) = parts(path);
    same_origin(url, endpoint)
        && url.path() == "/"
        && url.query() == query
        && url.fragment() == fragment
}

fn is_tray_url(url: &Url, endpoint: ProxyEndpoint) -> bool {
    matches(url, endpoint, TRAY_PATH)
}

fn is_close_url(url: &Url, endpoint: ProxyEndpoint) -> bool {
    matches(url, endpoint, CLOSE_PATH)
}

fn is_dashboard_url(url: &Url, endpoint: ProxyEndpoint) -> bool {
    // The dashboard accepts the usage page and its companion view under the same query.
    let (query, _) = parts(DASHBOARD_PATH);
    same_origin(url, endpoint)
        && url.path() == "/"
        && url.query() == query
        && matches!(url.fragment(), Some("/usage") | Some("/usage/companion"))
}

fn set_visibility(popup: &WebviewWindow, visible: bool) {
    let script = format!(
        "window.__OPENCODEX_TRAY_VISIBLE__ = {visible}; window.dispatchEvent(new CustomEvent('opencodex:tray-visibility', {{detail: {visible}}}));"
    );
    let _ = popup.eval(script);
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENDPOINT: ProxyEndpoint = ProxyEndpoint {
        host: "127.0.0.1",
        port: 53998,
    };

    #[test]
    fn geometry_uses_physical_dpi_and_clamps_to_work_area() {
        let layout = geometry(
            PhysicalPosition::new(1_900.0, 1_050.0),
            PhysicalRect {
                position: PhysicalPosition::new(0, 0),
                size: PhysicalSize::new(2_560, 1_440),
            },
            2.0,
        );
        assert_eq!(layout.size, PhysicalSize::new(880, 1400));
        assert_eq!(layout.position.x, 1_460);
        assert_eq!(layout.position.y, 8);
    }

    #[test]
    fn geometry_keeps_top_tray_below_and_clamps_left() {
        let layout = geometry(
            PhysicalPosition::new(-20.0, 20.0),
            PhysicalRect {
                position: PhysicalPosition::new(-1_280, 0),
                size: PhysicalSize::new(1_280, 800),
            },
            1.0,
        );
        assert_eq!(layout.position.x, -448);
        assert_eq!(layout.position.y, 26);
        assert_eq!(layout.size, PhysicalSize::new(440, 700));
    }

    #[test]
    fn navigation_accepts_only_tray_close_and_dashboard_sentinels() {
        let tray: Url = ENDPOINT.url(TRAY_PATH).parse().unwrap();
        let close: Url = ENDPOINT.url(CLOSE_PATH).parse().unwrap();
        let dashboard: Url = ENDPOINT.url(DASHBOARD_PATH).parse().unwrap();
        let external: Url = "https://example.com/#/tray".parse().unwrap();
        assert!(is_tray_url(&tray, ENDPOINT));
        assert!(is_close_url(&close, ENDPOINT));
        assert!(is_dashboard_url(&dashboard, ENDPOINT));
        assert!(!is_tray_url(&external, ENDPOINT));
        assert!(!is_tray_url(
            &ENDPOINT.url("/#/usage").parse().unwrap(),
            ENDPOINT
        ));
    }

    #[test]
    fn initialization_script_matches_native_surface() {
        let expected_value = if VIBRANT_SURFACE { "on" } else { "off" };
        let expected = format!(r#"{TRAY_VIBRANCY_DATASET} = "{expected_value}";"#);
        assert!(initialization_script().contains(&expected));
    }
}
