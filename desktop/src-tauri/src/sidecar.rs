use crate::{discovery::ProxyEndpoint, proxy::ProxyClient};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use tokio::time::{sleep, timeout, Duration, Instant};

pub async fn ensure_proxy(
    app: &AppHandle,
    proxy: &ProxyClient,
    endpoint: ProxyEndpoint,
) -> Result<Option<CommandChild>, String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if matches!(
            timeout(Duration::from_millis(250), proxy.is_alive()).await,
            Ok(Ok(_))
        ) {
            return Ok(None);
        }
        if Instant::now() >= deadline {
            break;
        }
        sleep(Duration::from_millis(150)).await;
    }

    let gui_dist = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("gui")
        .join("dist");
    let command = app
        .shell()
        .sidecar("ocx")
        .map_err(|error| error.to_string())?
        .args(["start", "--port", &endpoint.port.to_string()])
        .env("OPENCODEX_GUI_DIST", gui_dist);
    let (_events, child) = command.spawn().map_err(|error| error.to_string())?;

    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if proxy.is_alive().await.is_ok() {
            return Ok(Some(child));
        }
    }
    let _ = child.kill();
    Err("the OpenCodex sidecar did not become healthy".into())
}
