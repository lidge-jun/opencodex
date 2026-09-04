#![cfg(any(target_os = "macos", target_os = "windows"))]

use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

fn run_helper(request: &Value) -> Value {
    let binary = env!("CARGO_BIN_EXE_opencodex-remote-workspace-helper");
    let mut child = Command::new(binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("native helper starts");
    child
        .stdin
        .take()
        .expect("native helper stdin")
        .write_all(&serde_json::to_vec(request).expect("helper request serializes"))
        .expect("helper request is written");
    let output = child.wait_with_output().expect("native helper exits");
    assert!(
        output.status.success(),
        "helper stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("helper response is JSON")
}

fn run_probe() -> Value {
    run_helper(&serde_json::json!({ "version": 1, "operation": "probe" }))
}

#[cfg(target_os = "windows")]
#[test]
fn native_helper_proves_workspace_write_and_denies_host_read_write_and_network() {
    let response = run_probe();
    assert_eq!(
        response,
        serde_json::json!({ "version": 1, "ok": true, "probe": true })
    );
}

#[cfg(target_os = "macos")]
#[test]
fn native_helper_keeps_macos_command_execution_fail_closed() {
    let unavailable = serde_json::json!({
        "version": 1,
        "ok": false,
        "error": "macOS Remote Workspace command confinement is unavailable; file tools remain enabled"
    });
    assert_eq!(run_probe(), unavailable);

    let root = std::env::current_dir().expect("test cwd");
    assert_eq!(
        run_helper(&serde_json::json!({
            "version": 1,
            "operation": "run",
            "root": root,
            "cwd": root,
            "command": ["/usr/bin/true"],
            "toolchainRoots": [],
            "timeoutMs": 5_000,
            "maxOutputBytes": 16 * 1024,
            "networkAccess": false
        })),
        unavailable
    );
}
