use serde::{Deserialize, Serialize};
use tauri::command;

use crate::discover;

#[derive(Debug, Deserialize)]
pub struct ApiRequest {
    pub path: String,
    #[serde(default = "default_method")]
    pub method: String,
    pub body: Option<serde_json::Value>,
}

fn default_method() -> String {
    "GET".to_string()
}

#[derive(Debug, Serialize)]
pub struct ApiResponse {
    pub status: u16,
    pub ok: bool,
    pub body: serde_json::Value,
}

#[command]
pub async fn api_request(req: ApiRequest) -> Result<ApiResponse, String> {
    // Auto-discover proxy URL and token from ~/.opencodex/
    let discovery = discover::discover_proxy();
    let base_url = discovery.url;
    let token = discovery.token;

    let url = format!("{}{}", base_url.trim_end_matches('/'), req.path);

    let client = reqwest::Client::new();
    let method = req.method.to_uppercase();

    let mut builder = match method.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };

    // Inject auth header — token stays in Rust, never sent to WebView
    if let Some(ref t) = token {
        builder = builder.header("X-OpenCodex-API-Key", t);
    }

    if let Some(ref body) = req.body {
        builder = builder.json(body);
    }

    let response = builder
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status().as_u16();
    let body: serde_json::Value = response
        .json()
        .await
        .unwrap_or(serde_json::Value::Null);

    Ok(ApiResponse {
        ok: (200..300).contains(&(status as usize)),
        status,
        body,
    })
}
