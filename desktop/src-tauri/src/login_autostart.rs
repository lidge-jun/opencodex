use tauri::AppHandle;

/// All shell-owned enables use this entry point; the plugin still owns status and disable.
#[cfg(not(target_os = "windows"))]
pub fn enable(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().enable().map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
pub fn enable(app: &AppHandle) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE, REG_BINARY};
    use winreg::{RegKey, RegValue};

    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable = executable
        .to_str()
        .ok_or("autostart executable path is not Unicode")?;
    let command =
        crate::windows_autostart_command::command(executable, crate::startup::AUTOSTART_FLAG)?;
    let name = &app.package_info().name;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey_with_flags(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
        KEY_SET_VALUE,
    )
    .and_then(|key| key.set_value(name, &command))
    .map_err(|error| error.to_string())?;

    // Match the plugin's explicit-enable behavior when Task Manager has an override.
    if let Ok(key) = hkcu.open_subkey_with_flags(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
        KEY_SET_VALUE,
    ) {
        key.set_raw_value(
            name,
            &RegValue {
                vtype: REG_BINARY,
                bytes: vec![2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            },
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}
