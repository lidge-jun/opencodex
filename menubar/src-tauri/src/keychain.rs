use security_framework::passwords::*;
use tauri::command;

const SERVICE: &str = "com.opencodex.menubar";
const TOKEN_ACCOUNT: &str = "api-token";
const URL_ACCOUNT: &str = "proxy-url";

/// Read token from Keychain (Rust-internal only, never exposed to WebView)
#[allow(dead_code)]
pub fn get_token() -> Result<Option<String>, String> {
    match get_generic_password(SERVICE, TOKEN_ACCOUNT) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
        Err(_) => Ok(None),
    }
}

#[command]
pub fn set_token(token: String) -> Result<(), String> {
    set_generic_password(SERVICE, TOKEN_ACCOUNT, token.as_bytes())
        .map_err(|e| e.to_string())
}

/// Read proxy URL from Keychain (Rust-internal only)
#[allow(dead_code)]
pub fn get_proxy_url() -> Result<Option<String>, String> {
    match get_generic_password(SERVICE, URL_ACCOUNT) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
        Err(_) => Ok(None),
    }
}

#[command]
pub fn set_proxy_url(url: String) -> Result<(), String> {
    set_generic_password(SERVICE, URL_ACCOUNT, url.as_bytes())
        .map_err(|e| e.to_string())
}
