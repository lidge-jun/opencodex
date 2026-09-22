//! macOS usage popup: one native panel in the existing Tauri process.
use crate::{
    endpoint::ProxyEndpoint, native_tray_data, native_tray_snapshot, proxy::RuntimeBinding, window,
    AppState,
};
use serde_json::{json, Value};
use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, PhysicalPosition};

extern "C" {
    fn ocx_native_tray_show(item: *mut c_void, toggle: i32, callback: extern "C" fn(i32));
    fn ocx_native_tray_hide();
    fn ocx_native_tray_visible() -> i32;
    fn ocx_native_tray_update(bytes: *const u8, count: isize);
}

static HOST: OnceLock<AppHandle> = OnceLock::new();

struct NativeTrayState {
    generation: AtomicU64,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    cache: Mutex<(Option<RuntimeBinding>, Value)>,
}

impl Default for NativeTrayState {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(0),
            task: Mutex::new(None),
            cache: Mutex::new((None, native_tray_snapshot::empty())),
        }
    }
}

pub fn show(
    app: &AppHandle,
    _endpoint: ProxyEndpoint,
    _anchor: PhysicalPosition<f64>,
) -> tauri::Result<()> {
    present(app, false)
}

pub fn toggle(
    app: &AppHandle,
    _endpoint: ProxyEndpoint,
    _anchor: PhysicalPosition<f64>,
) -> tauri::Result<()> {
    present(app, true)
}

fn present(app: &AppHandle, toggle: bool) -> tauri::Result<()> {
    let _ = HOST.set(app.clone());
    if app.try_state::<NativeTrayState>().is_none() {
        app.manage(NativeTrayState::default());
    }
    let Some(tray) = app.tray_by_id("main") else {
        return Ok(());
    };
    // Tauri guarantees this closure runs on AppKit's main thread. The tray retains
    // its status item; Swift only borrows it for the synchronous presentation call.
    tray.with_inner_tray_icon(move |tray| {
        if let Some(item) = tray.ns_status_item() {
            let pointer = (&*item as *const _ as *mut c_void).cast();
            unsafe {
                ocx_native_tray_show(pointer, i32::from(toggle), native_event);
            }
        }
    })
}

pub fn hide(app: &AppHandle) {
    stop_refresh(app);
    let _ = app.run_on_main_thread(|| unsafe { ocx_native_tray_hide() });
}

extern "C" fn native_event(event: i32) {
    let Some(app) = HOST.get() else {
        return;
    };
    match event {
        1 => start_refresh(app),
        2 => stop_refresh(app),
        3 | 4 => {
            stop_refresh(app);
            let Some(proxy) = app.state::<AppState>().proxy() else {
                return;
            };
            if let Some(main) = app.get_webview_window("main") {
                let path = if event == 4 {
                    "/?desktop=open#/usage/companion"
                } else {
                    "/?desktop=open#/usage"
                };
                if let Ok(url) = proxy.endpoint().url(path).parse() {
                    let _ = main.navigate(url);
                    window::show(&main);
                }
            }
        }
        _ => {}
    }
}

fn stop_refresh(app: &AppHandle) {
    let Some(state) = app.try_state::<NativeTrayState>() else {
        return;
    };
    let mut slot = state
        .task
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.generation.fetch_add(1, Ordering::AcqRel);
    if let Some(task) = slot.take() {
        task.abort();
    }
}

fn start_refresh(app: &AppHandle) {
    let state = app.state::<NativeTrayState>();
    let mut slot = state
        .task
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(task) = slot.take() {
        task.abort();
    }
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let app = app.clone();
    *slot = Some(tauri::async_runtime::spawn(async move {
        loop {
            let proxy = app.state::<AppState>().proxy();
            let binding = proxy.as_ref().and_then(|p| p.binding());
            let mut loading = {
                let state = app.state::<NativeTrayState>();
                let cache = state
                    .cache
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if cache.0 == binding {
                    cache.1.clone()
                } else {
                    native_tray_snapshot::empty()
                }
            };
            loading["refreshing"] = json!(true);
            publish(&app, generation, binding, loading.clone());
            let snapshot = if let Some(proxy) = proxy.filter(|_| binding.is_some()) {
                let target = app.clone();
                native_tray_data::load(&proxy, loading, move |partial| {
                    publish(&target, generation, binding, partial);
                })
                .await
            } else {
                failed(loading, "The local runtime is not connected.")
            };
            publish(&app, generation, binding, snapshot);
            tokio::time::sleep(Duration::from_secs(60)).await;
            if app
                .state::<NativeTrayState>()
                .generation
                .load(Ordering::Acquire)
                != generation
            {
                break;
            }
        }
    }));
}

fn failed(mut value: Value, message: &str) -> Value {
    value["refreshing"] = json!(false);
    value["errors"] = json!([message]);
    value
}

fn publish(app: &AppHandle, generation: u64, binding: Option<RuntimeBinding>, snapshot: Value) {
    let app = app.clone();
    let target = app.clone();
    let _ = target.run_on_main_thread(move || {
        let state = app.state::<NativeTrayState>();
        let current = app.state::<AppState>().proxy().and_then(|p| p.binding());
        if !may_publish(
            generation,
            state.generation.load(Ordering::Acquire),
            binding,
            current,
        ) {
            return;
        }
        // This callback, unlike the network task, is guaranteed to be on the main thread.
        if unsafe { ocx_native_tray_visible() } == 0 {
            return;
        }
        if let Some((snapshot, bytes)) = display_payload(snapshot) {
            unsafe {
                ocx_native_tray_update(bytes.as_ptr(), bytes.len() as isize);
            }
            *state
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = (binding, snapshot);
        }
    });
}

fn display_payload(snapshot: Value) -> Option<(Value, Vec<u8>)> {
    let bytes = serde_json::to_vec(&snapshot).ok()?;
    if bytes.len() <= 8 * 1024 * 1024 {
        return Some((snapshot, bytes));
    }
    // A rejected payload must settle the spinner instead of leaving Refresh disabled.
    let error = failed(native_tray_snapshot::empty(), "Usage data is too large for this panel. Open the dashboard to narrow the visible sections.");
    let bytes = serde_json::to_vec(&error).ok()?;
    Some((error, bytes))
}

fn may_publish(
    start: u64,
    now: u64,
    binding: Option<RuntimeBinding>,
    current: Option<RuntimeBinding>,
) -> bool {
    start == now && binding == current
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::RuntimeIdentity;
    #[test]
    fn closed_refresh_or_rebound_runtime_cannot_overwrite_visible_state() {
        let a = RuntimeBinding {
            identity: RuntimeIdentity {
                pid: 1,
                port: 10100,
            },
            generation: 1,
        };
        let b = RuntimeBinding { generation: 2, ..a };
        assert!(may_publish(7, 7, Some(a), Some(a)));
        assert!(!may_publish(7, 8, Some(a), Some(a)));
        assert!(!may_publish(7, 7, Some(a), Some(b)));
        assert!(!may_publish(7, 7, Some(a), None));
    }
    #[test]
    fn refresh_failure_preserves_age_and_clears_busy_state() {
        let before = json!({"updatedAt":12,"refreshing":true,"today":{"totalTokens":30}});
        let after = failed(before, "Unavailable");
        assert_eq!(after["updatedAt"], 12);
        assert_eq!(after["today"]["totalTokens"], 30);
        assert_eq!(after["refreshing"], false);
        assert_eq!(after["errors"], json!(["Unavailable"]));
    }

    #[test]
    fn oversized_display_data_settles_with_a_small_readable_error() {
        let mut snapshot = native_tray_snapshot::empty();
        snapshot["models"] =
            json!([{"id":"large","label":"x".repeat(8*1024*1024),"tokens":null,"requests":null}]);
        let (result, bytes) = display_payload(snapshot).unwrap();
        assert_eq!(result["schemaVersion"], 1);
        assert_eq!(result["refreshing"], false);
        assert_eq!(result["errors"].as_array().unwrap().len(), 1);
        assert!(bytes.len() < 1024);
    }
}
