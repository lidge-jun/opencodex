use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::command;

#[derive(Debug, Serialize)]
pub struct ProxyDiscovery {
    pub url: String,
    pub token: Option<String>,
    pub found: bool,
}

fn opencodex_home() -> PathBuf {
    if let Ok(home) = std::env::var("OPENCODEX_HOME") {
        return PathBuf::from(home);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".opencodex")
}

#[command]
pub fn discover_proxy() -> ProxyDiscovery {
    let dir = opencodex_home();

    // Read port from runtime-port.json
    let port = fs::read_to_string(dir.join("runtime-port.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("port")?.as_u64())
        .unwrap_or(10100);

    let url = format!("http://localhost:{}", port);

    // Read API key from config.json (if any keys are configured)
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

    ProxyDiscovery {
        url,
        token,
        found: true,
    }
}
