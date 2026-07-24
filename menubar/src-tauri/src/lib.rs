mod tray;
mod keychain;
mod api;
mod discover;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            tray::setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keychain::set_token,
            keychain::set_proxy_url,
            api::api_request,
            discover::discover_proxy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running opencodex menubar");
}
