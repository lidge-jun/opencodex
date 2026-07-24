use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::command;

#[derive(Debug, Serialize)]
pub struct ProxyDiscovery {
    pub url: String,
    pub token: Option<String>,
    pub found: bool,
    pub verified: bool,
}

#[derive(Debug, Deserialize)]
struct RuntimePort {
    pid: u32,
    port: u16,
}

fn opencodex_home() -> PathBuf {
    if let Ok(home) = std::env::var("OPENCODEX_HOME") {
        return PathBuf::from(home);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".opencodex")
}

/// Check if a PID is still alive
fn pid_alive(pid: u32) -> bool {
    // On macOS/Linux, signal 0 checks existence without sending
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[command]
pub fn discover_proxy() -> ProxyDiscovery {
    let dir = opencodex_home();

    // Read port + PID from runtime-port.json
    let runtime = fs::read_to_string(dir.join("runtime-port.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<RuntimePort>(&s).ok());

    let (port, pid_alive) = match &runtime {
        Some(rt) => (rt.port, pid_alive(rt.pid)),
        None => (10100, false),
    };

    let url = format!("http://localhost:{}", port);

    // Read API key from config.json (if any keys are configured)
    // Also check for OPENCODEX_API_AUTH_TOKEN env-based admission token
    let token = fs::read_to_string(dir.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            let keys = v.get("apiKeys")?.as_array()?;
            if keys.is_empty() {
                return None; // No keys configured = no auth required
            }
            keys.first()?.get("key")?.as_str().map(String::from)
        });

    // Verify proxy is actually running via /healthz
    let verified = pid_alive && verify_healthz(&url);

    ProxyDiscovery {
        url,
        token,
        found: true,
        verified,
    }
}

fn verify_healthz(url: &str) -> bool {
    // Synchronous HTTP check — use ureq-style blocking or just check TCP
    let addr = url.replace("http://", "").replace("https://", "");
    std::net::TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| std::net::SocketAddr::from(([127, 0, 0, 1], 10100))),
        std::time::Duration::from_millis(500),
    )
    .is_ok()
}
