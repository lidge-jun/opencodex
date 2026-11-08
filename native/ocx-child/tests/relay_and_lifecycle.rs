#![deny(unsafe_op_in_unsafe_fn)]

mod common;
use common::*;

use std::fs;
use std::io::{BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use ocx_child::daemon::pick_ephemeral_link_port;
#[cfg(unix)]
use ocx_child::daemon::stop_owned_daemon;
use ocx_child::http_wire::read_response_head;
use ocx_child::platform::{FileLock, process_is_alive};
use ocx_child::relay_auth::compute_child_shutdown_proof;
use ocx_child::state::ChildPaths;
#[cfg(unix)]
use ocx_child::state::{CHILD_STATE_SCHEMA, ChildStateV1};

#[test]
fn detached_foreground_serve_refuses_to_start() {
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-detached-{}-{}",
        std::process::id(),
        ocx_child::platform::random_hex(6).unwrap()
    ));
    fs::create_dir_all(&scratch).unwrap();
    let listen_port = pick_ephemeral_link_port().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_ocx-child"))
        .args([
            "serve",
            "--foreground",
            "--listen-port",
            &listen_port.to_string(),
        ])
        .env("OPENCODEX_HOME", scratch.join("opencodex"))
        .env("CODEX_HOME", scratch.join("codex"))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut exited = false;
    for _ in 0..100 {
        if child.try_wait().unwrap().is_some() {
            exited = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    if !exited {
        child.kill().unwrap();
    }
    let output = child.wait_with_output().unwrap();
    let _ = fs::remove_dir_all(&scratch);
    assert!(exited, "detached foreground server did not refuse startup");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("detached"));
    assert!(TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], listen_port))).is_ok());
}

#[test]
fn direct_foreground_server_revalidates_attachment_after_binding() {
    const MARKER: &str = "OCX_TEST_DIRECT_FOREGROUND_CHILD";
    if let Some(root) = std::env::var_os(MARKER) {
        let port: u16 = std::env::var("OCX_TEST_DIRECT_FOREGROUND_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let root = std::path::PathBuf::from(root);
        let paths = ChildPaths::new(root.join("opencodex"), root.join("codex"));
        assert!(ocx_child::relay::serve_foreground(paths, port).is_err());
        return;
    }
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-direct-{}-{}",
        std::process::id(),
        ocx_child::platform::random_hex(6).unwrap()
    ));
    fs::create_dir_all(&scratch).unwrap();
    let port = pick_ephemeral_link_port().unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "direct_foreground_server_revalidates_attachment_after_binding",
        ])
        .env(MARKER, &scratch)
        .env("OCX_TEST_DIRECT_FOREGROUND_PORT", port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut exited = false;
    for _ in 0..100 {
        if child.try_wait().unwrap().is_some() {
            exited = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    if !exited {
        child.kill().unwrap();
    }
    let status = child.wait().unwrap();
    let _ = fs::remove_dir_all(&scratch);
    assert!(
        exited && status.success(),
        "detached direct server did not refuse startup"
    );
    assert!(TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).is_ok());
}

#[test]
fn foreground_startup_waits_for_teardown_gate_before_binding() {
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-start-gate-{}-{}",
        std::process::id(),
        ocx_child::platform::random_hex(6).unwrap()
    ));
    let ocx_home = scratch.join("opencodex");
    let codex_home = scratch.join("codex");
    fs::create_dir_all(&ocx_home).unwrap();
    fs::create_dir_all(&codex_home).unwrap();
    let port = pick_ephemeral_link_port().unwrap();
    let raw_token = format!("ocx_data_{}", "a".repeat(40));
    let key_id = "link:rust-test";
    let link_id = "lnk_0123456789abcdef";
    let _home = MockHomeServer::start(&raw_token, key_id, link_id);
    let creds = format!(r#"{{"apiKeyId":"{key_id}","key":"{raw_token}"}}"#);
    let (connect, _, error) = run_bin(
        &ocx_home,
        &codex_home,
        port,
        &[
            "connect",
            "--link",
            "--key-stdin",
            "--tunnel-port",
            &_home.port.to_string(),
            "--link-id",
            link_id,
        ],
        Some(creds.as_bytes()),
    );
    assert_eq!(connect, 0, "{error}");
    let gate = ocx_child::platform::FileLock::acquire_blocking(
        &ocx_home.join("child").join("daemon-start.lock"),
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_ocx-child"))
        .args(["serve", "--foreground", "--listen-port", &port.to_string()])
        .env("OPENCODEX_HOME", &ocx_home)
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_millis(300));
    let bound_before_release = TcpStream::connect(("127.0.0.1", port)).is_ok();
    fs::remove_file(ocx_home.join("child").join("state.json")).unwrap();
    drop(gate);
    let mut exited = false;
    for _ in 0..100 {
        if child.try_wait().unwrap().is_some() {
            exited = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    if !exited {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = run_bin(&ocx_home, &codex_home, port, &["detach"], None);
    let _ = fs::remove_dir_all(&scratch);
    assert!(
        !bound_before_release,
        "server bound before teardown gate was released"
    );
    assert!(
        exited,
        "server remained running after attachment state was removed"
    );
}

#[test]
fn detach_stops_authenticated_foreground_without_recorded_pid() {
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-foreground-{}-{}",
        std::process::id(),
        ocx_child::platform::random_hex(6).unwrap()
    ));
    let ocx_home = scratch.join("opencodex");
    let codex_home = scratch.join("codex");
    fs::create_dir_all(&ocx_home).unwrap();
    fs::create_dir_all(&codex_home).unwrap();
    let port = pick_ephemeral_link_port().unwrap();
    let raw_token = format!("ocx_data_{}", "a".repeat(40));
    let key_id = "link:rust-test";
    let link_id = "lnk_0123456789abcdef";
    let mut home = MockHomeServer::start(&raw_token, key_id, link_id);
    let creds = format!(r#"{{"apiKeyId":"{key_id}","key":"{raw_token}"}}"#);
    let (connect, _, _) = run_bin(
        &ocx_home,
        &codex_home,
        port,
        &[
            "connect",
            "--link",
            "--key-stdin",
            "--tunnel-port",
            &home.port.to_string(),
            "--link-id",
            link_id,
        ],
        Some(creds.as_bytes()),
    );
    assert_eq!(connect, 0);
    let child = Command::new(env!("CARGO_BIN_EXE_ocx-child"))
        .args(["serve", "--foreground", "--listen-port", &port.to_string()])
        .env("OPENCODEX_HOME", &ocx_home)
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut ready = false;
    for _ in 0..100 {
        if TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port))).is_ok() {
            ready = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let child = Arc::new(Mutex::new(child));
    let waiter_child = Arc::clone(&child);
    let waiter = thread::spawn(move || {
        loop {
            if let Some(status) = waiter_child.lock().unwrap().try_wait().unwrap() {
                break status;
            }
            thread::sleep(Duration::from_millis(10));
        }
    });
    let (detach, _, _) = run_bin(&ocx_home, &codex_home, port, &["detach"], None);
    if detach != 0 {
        let _ = child.lock().unwrap().kill();
    }
    let stopped = waiter.join().unwrap().success();
    if detach != 0 {
        let _ = run_bin(&ocx_home, &codex_home, port, &["detach"], None);
    }
    home.shutdown();
    let _ = fs::remove_dir_all(&scratch);
    assert!(ready, "foreground server never became ready");
    assert_eq!(
        detach, 0,
        "authenticated foreground server must be detachable"
    );
    assert!(stopped, "foreground daemon remained running after detach");
}

#[cfg(unix)]
#[test]
fn untrusted_health_pid_never_authorizes_signalling_an_unrelated_process() {
    use std::io::Read;

    let mut unrelated = Command::new("/bin/sleep")
        .arg("60")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let leaked = Arc::new(AtomicBool::new(false));
    let thread_leaked = Arc::clone(&leaked);
    let sent_after_bad_proof = Arc::new(AtomicBool::new(false));
    let thread_sent_after_bad_proof = Arc::clone(&sent_after_bad_proof);
    let claimed_pid = unrelated.id();
    let server = thread::spawn(move || {
        while !thread_stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    let _ = socket.set_read_timeout(Some(Duration::from_millis(50)));
                    let mut bytes = [0u8; 2048];
                    let count = socket.read(&mut bytes).unwrap_or(0);
                    let request = String::from_utf8_lossy(&bytes[..count]);
                    if request.contains(&"a".repeat(48)) {
                        thread_leaked.store(true, Ordering::SeqCst);
                    }
                    if request.starts_with("GET /healthz ") {
                        let body = format!(
                            r#"{{"service":"opencodex","role":"client","ephemeralChild":true,"pid":{claimed_pid},"port":{port}}}"#
                        );
                        let _ = write!(
                            socket,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                    } else if request.starts_with("POST ") {
                        let response = format!(
                            "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nx-ocx-child-shutdown-proof: {}\r\nConnection: keep-alive\r\n\r\n",
                            "0".repeat(64),
                        );
                        let _ = socket.write_all(response.as_bytes());
                        let count = socket.read(&mut bytes).unwrap_or(0);
                        if count > 0 {
                            thread_sent_after_bad_proof.store(true, Ordering::SeqCst);
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(e) => panic!("fixture listener failed: {e}"),
            }
        }
    });
    let state = ChildStateV1 {
        schema: CHILD_STATE_SCHEMA.to_owned(),
        link_id: "lnk_0123456789abcdef".to_owned(),
        api_key_id: "link:t".to_owned(),
        token_fingerprint: "fingerprint".to_owned(),
        tunnel_port: 12345,
        listen_port: port,
        connected_at: String::new(),
        catalog_fingerprint: String::new(),
        catalog_synced_at: String::new(),
        daemon_pid: Some(unrelated.id()),
        daemon_started_at_ms: None,
        shutdown_secret: "a".repeat(48).into(),
        parity_sequence: 0,
        pending_operation: None,
        applied_settings: None,
        daemon_generation: None,
    };

    let result = stop_owned_daemon(&state);
    let survived = unrelated.try_wait().unwrap().is_none();
    stop.store(true, Ordering::SeqCst);
    server.join().unwrap();
    if survived {
        unrelated.kill().unwrap();
    }
    let _ = unrelated.wait();
    assert!(
        result.is_err(),
        "unattested listener must not be treated as stopped"
    );
    assert!(
        survived,
        "an unauthenticated health response authorized a signal"
    );
    assert!(
        !leaked.load(Ordering::SeqCst),
        "untrusted listener received the shutdown secret"
    );
    assert!(
        !sent_after_bad_proof.load(Ordering::SeqCst),
        "caller sent authorization after an invalid listener proof"
    );
}

#[test]
fn native_attach_starts_authorized_daemon_and_clears_rollback_snapshot() {
    struct Cleanup {
        root: std::path::PathBuf,
        ocx: std::path::PathBuf,
        codex: std::path::PathBuf,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let result = Command::new(env!("CARGO_BIN_EXE_ocx-child"))
                .arg("detach")
                .env("OPENCODEX_HOME", &self.ocx)
                .env("CODEX_HOME", &self.codex)
                .output();
            if result.is_ok_and(|output| output.status.success()) {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-attach-{}-{}",
        std::process::id(),
        ocx_child::platform::random_hex(6).unwrap()
    ));
    let ocx_home = scratch.join("opencodex");
    let codex_home = scratch.join("codex");
    fs::create_dir_all(&ocx_home).unwrap();
    fs::create_dir_all(&codex_home).unwrap();
    let _cleanup = Cleanup {
        root: scratch.clone(),
        ocx: ocx_home.clone(),
        codex: codex_home.clone(),
    };
    let port = pick_ephemeral_link_port().unwrap();
    let raw_token = format!("ocx_data_{}", "a".repeat(40));
    let key_id = "link:rust-test";
    let link_id = "lnk_0123456789abcdef";
    let mut home = MockHomeServer::start(&raw_token, key_id, link_id);
    let creds = format!(r#"{{"apiKeyId":"{key_id}","key":"{raw_token}"}}"#);
    let (code, _, stderr) = run_bin(
        &ocx_home,
        &codex_home,
        port,
        &[
            "attach",
            "--key-stdin",
            "--tunnel-port",
            &home.port.to_string(),
            "--link-id",
            link_id,
            "--listen-port",
            &port.to_string(),
        ],
        Some(creds.as_bytes()),
    );
    assert_eq!(code, 0, "native attach failed: {stderr}");
    assert!(!ocx_home.join("child").join("attach-rollback.json").exists());
    let (sync_code, _, sync_error) = run_bin(
        &ocx_home,
        &codex_home,
        port,
        &["sync", "--restart-app-server-only"],
        None,
    );
    assert_eq!(sync_code, 0, "documented sync flag rejected: {sync_error}");
    assert!(
        raw_http_exchange(
            port,
            &format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
        )
        .contains("200 OK")
    );
    let (detach_code, _, detach_error) = run_bin(&ocx_home, &codex_home, port, &["detach"], None);
    assert_eq!(detach_code, 0, "detach failed: {detach_error}");
    home.shutdown();
}

#[test]
fn captured_shutdown_proof_cannot_be_replayed_on_another_connection() {
    struct Cleanup {
        root: std::path::PathBuf,
        ocx: std::path::PathBuf,
        codex: std::path::PathBuf,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let result = Command::new(env!("CARGO_BIN_EXE_ocx-child"))
                .arg("detach")
                .env("OPENCODEX_HOME", &self.ocx)
                .env("CODEX_HOME", &self.codex)
                .output();
            if result.is_ok_and(|output| output.status.success()) {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-replay-{}-{}",
        std::process::id(),
        ocx_child::platform::random_hex(6).unwrap()
    ));
    let ocx_home = scratch.join("opencodex");
    let codex_home = scratch.join("codex");
    fs::create_dir_all(&ocx_home).unwrap();
    fs::create_dir_all(&codex_home).unwrap();
    let _cleanup = Cleanup {
        root: scratch,
        ocx: ocx_home.clone(),
        codex: codex_home.clone(),
    };
    let port = pick_ephemeral_link_port().unwrap();
    let raw_token = format!("ocx_data_{}", "a".repeat(40));
    let key_id = "link:rust-test";
    let link_id = "lnk_0123456789abcdef";
    let _home = MockHomeServer::start(&raw_token, key_id, link_id);
    let creds = format!(r#"{{"apiKeyId":"{key_id}","key":"{raw_token}"}}"#);
    let (code, _, stderr) = run_bin(
        &ocx_home,
        &codex_home,
        port,
        &[
            "attach",
            "--key-stdin",
            "--tunnel-port",
            &_home.port.to_string(),
            "--link-id",
            link_id,
            "--listen-port",
            &port.to_string(),
        ],
        Some(creds.as_bytes()),
    );
    assert_eq!(code, 0, "fixture attach failed: {stderr}");
    let state: serde_json::Value =
        serde_json::from_slice(&fs::read(ocx_home.join("child").join("state.json")).unwrap())
            .unwrap();
    let secret = state["shutdownSecret"].as_str().unwrap();
    let nonce = "b".repeat(64);
    let challenge = format!(
        "POST /__ocx_child/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-ocx-child-shutdown-challenge: {nonce}\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n"
    );
    let mut first = TcpStream::connect(("127.0.0.1", port)).unwrap();
    first.write_all(challenge.as_bytes()).unwrap();
    let mut first_reader = BufReader::new(first);
    let first_head = read_response_head(&mut first_reader).unwrap();
    assert_eq!(first_head.status, 204);
    let binding = first_head
        .header("x-ocx-child-shutdown-nonce")
        .map(|server_nonce| format!("{nonce}{server_nonce}"))
        .unwrap_or_else(|| nonce.clone());
    let captured = compute_child_shutdown_proof(secret, "caller", &binding).unwrap();
    drop(first_reader);

    let mut second = TcpStream::connect(("127.0.0.1", port)).unwrap();
    second.write_all(challenge.as_bytes()).unwrap();
    let mut reader = BufReader::new(second.try_clone().unwrap());
    assert_eq!(read_response_head(&mut reader).unwrap().status, 204);
    let replay = format!(
        "POST /__ocx_child/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-ocx-child-shutdown-proof: {captured}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    second.write_all(replay.as_bytes()).unwrap();
    let response = read_response_head(&mut reader).unwrap();
    assert_eq!(
        response.status, 404,
        "captured shutdown authorization was replayed"
    );
}

#[test]
fn rejected_home_authentication_never_becomes_a_stale_sync_success() {
    struct Cleanup {
        root: std::path::PathBuf,
        ocx: std::path::PathBuf,
        codex: std::path::PathBuf,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let result = Command::new(env!("CARGO_BIN_EXE_ocx-child"))
                .arg("detach")
                .env("OPENCODEX_HOME", &self.ocx)
                .env("CODEX_HOME", &self.codex)
                .output();
            if result.is_ok_and(|output| output.status.success()) {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-auth-{}-{}",
        std::process::id(),
        ocx_child::platform::random_hex(6).unwrap()
    ));
    let ocx_home = scratch.join("opencodex");
    let codex_home = scratch.join("codex");
    fs::create_dir_all(&ocx_home).unwrap();
    fs::create_dir_all(&codex_home).unwrap();
    let _cleanup = Cleanup {
        root: scratch,
        ocx: ocx_home.clone(),
        codex: codex_home.clone(),
    };
    let port = pick_ephemeral_link_port().unwrap();
    let raw_token = format!("ocx_data_{}", "a".repeat(40));
    let key_id = "link:rust-test";
    let link_id = "lnk_0123456789abcdef";
    let home = MockHomeServer::start(&raw_token, key_id, link_id);
    let creds = format!(r#"{{"apiKeyId":"{key_id}","key":"{raw_token}"}}"#);
    let (code, _, stderr) = run_bin(
        &ocx_home,
        &codex_home,
        port,
        &[
            "attach",
            "--key-stdin",
            "--tunnel-port",
            &home.port.to_string(),
            "--link-id",
            link_id,
            "--listen-port",
            &port.to_string(),
        ],
        Some(creds.as_bytes()),
    );
    assert_eq!(code, 0, "fixture attach failed: {stderr}");
    let paths = ChildPaths::new(ocx_home.clone(), codex_home.clone());
    let config_before = fs::read(paths.codex_config_path()).unwrap();
    let journal_before = fs::read(&paths.journal_file).unwrap();
    let state_before = fs::read(&paths.state_file).unwrap();

    for status in [401, 403] {
        home.state.catalog_status.store(status, Ordering::SeqCst);
        let (code, output, _) = run_bin(
            &ocx_home,
            &codex_home,
            port,
            &["sync", "--expect-link", link_id, "--json"],
            None,
        );
        assert_ne!(
            code, 0,
            "HTTP {status} must not be reported as stale success"
        );
        assert!(!output.contains("\"state\":\"stale\""));
        assert!(fs::read(paths.codex_config_path()).unwrap() == config_before);
        assert!(fs::read(&paths.journal_file).unwrap() == journal_before);
        assert!(fs::read(&paths.state_file).unwrap() == state_before);
    }
    home.state.catalog_status.store(503, Ordering::SeqCst);
    home.state.settings_status.store(401, Ordering::SeqCst);
    let (code, _, _) = run_bin(
        &ocx_home,
        &codex_home,
        port,
        &["sync", "--expect-link", link_id, "--json"],
        None,
    );
    assert_ne!(
        code, 0,
        "settings authentication refusal must not be hidden by stale catalog"
    );
    home.state.catalog_status.store(200, Ordering::SeqCst);
    home.state.settings_status.store(200, Ordering::SeqCst);
    home.state
        .spoof_listener_proof
        .store(true, Ordering::SeqCst);
    let (code, _, _) = run_bin(
        &ocx_home,
        &codex_home,
        port,
        &["sync", "--expect-link", link_id, "--json"],
        None,
    );
    assert_ne!(
        code, 0,
        "listener proof failure must not become stale success"
    );
    home.state
        .spoof_listener_proof
        .store(false, Ordering::SeqCst);
    home.state.catalog_status.store(503, Ordering::SeqCst);
    home.state.settings_status.store(503, Ordering::SeqCst);
    let (code, output, stderr) = run_bin(
        &ocx_home,
        &codex_home,
        port,
        &["sync", "--expect-link", link_id, "--json"],
        None,
    );
    assert_eq!(
        code, 0,
        "temporary Home failure should retain offline sync: {stderr}"
    );
    assert!(output.contains("\"state\":\"stale\""));
}

#[test]
fn full_lifecycle_sse_relay_spoof_rejection_sync_rollover_and_offline_1798_detach() {
    let scratch = std::env::temp_dir().join(format!("ocx-child-e2e-rust-{}", std::process::id()));
    let _ = fs::remove_dir_all(&scratch);
    let ocx_home = scratch.join("opencodex");
    let codex_home = scratch.join("codex");
    fs::create_dir_all(&ocx_home).unwrap();
    fs::create_dir_all(&codex_home).unwrap();
    // Both homes pre-exist with a shared mode; no lifecycle command may change it.
    set_dir_mode_755(&ocx_home);
    set_dir_mode_755(&codex_home);
    fs::write(
        codex_home.join("config.toml"),
        b"# keep my comment\napproval_policy = \"on-request\"\n",
    )
    .unwrap();

    let listen_port = pick_ephemeral_link_port().unwrap();
    let raw_token = format!("ocx_data_{}", "a".repeat(40));
    let key_id = "link:rust-test";
    let link_id = "lnk_0123456789abcdef";
    let mut home = MockHomeServer::start(&raw_token, key_id, link_id);

    // 1. Detached `restart` fails closed without spawning any daemon
    let (rc_det_restart, _, _) = run_bin(&ocx_home, &codex_home, listen_port, &["restart"], None);
    assert_eq!(rc_det_restart, 1);

    // 2. Fail-closed attach when full-ocx runtime-port.json is present
    fs::write(ocx_home.join("runtime-port.json"), b"{\"pid\":99999}").unwrap();
    let cred_json = format!("{{\"apiKeyId\":\"{key_id}\",\"key\":\"{raw_token}\"}}");
    let (rc_conflict, _, err_conflict) = run_bin(
        &ocx_home,
        &codex_home,
        listen_port,
        &[
            "connect",
            "--link",
            "--key-stdin",
            "--tunnel-port",
            &home.port.to_string(),
            "--link-id",
            link_id,
        ],
        Some(cred_json.as_bytes()),
    );
    assert_ne!(rc_conflict, 0);
    assert!(
        err_conflict.contains("full OpenCodex runtime state"),
        "{err_conflict}"
    );
    fs::remove_file(ocx_home.join("runtime-port.json")).unwrap();

    // 3. Clean enrollment: connect + restart
    let (rc_conn, _, err_conn) = run_bin(
        &ocx_home,
        &codex_home,
        listen_port,
        &[
            "connect",
            "--link",
            "--key-stdin",
            "--tunnel-port",
            &home.port.to_string(),
            "--link-id",
            link_id,
        ],
        Some(cred_json.as_bytes()),
    );
    assert_eq!(rc_conn, 0, "connect stderr: {err_conn}");
    assert_home_modes_kept(&ocx_home, &codex_home, "attach");
    assert!(codex_home.join("models_cache.json").exists());

    let rollback_path = ocx_home.join("child").join("attach-rollback.json");
    fs::write(&rollback_path, b"{}").unwrap();
    let mut untrusted = Command::new(env!("CARGO_BIN_EXE_ocx-child"))
        .args([
            "serve",
            "--foreground",
            "--listen-port",
            &listen_port.to_string(),
        ])
        .env("OPENCODEX_HOME", &ocx_home)
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut exited = false;
    for _ in 0..100 {
        if untrusted.try_wait().unwrap().is_some() {
            exited = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    if !exited {
        untrusted.kill().unwrap();
    }
    let status = untrusted.wait().unwrap();
    fs::remove_file(&rollback_path).unwrap();
    assert!(
        exited && !status.success(),
        "incomplete attach must refuse untrusted startup"
    );

    let state_path = ocx_home.join("child").join("state.json");
    let state_bytes = fs::read(&state_path).unwrap();
    let mut damaged: serde_json::Value = serde_json::from_slice(&state_bytes).unwrap();
    damaged["shutdownSecret"] = serde_json::Value::String(String::new());
    fs::write(&state_path, serde_json::to_vec(&damaged).unwrap()).unwrap();
    fs::write(&rollback_path, b"{}").unwrap();
    let mut malformed = Command::new(env!("CARGO_BIN_EXE_ocx-child"))
        .args([
            "serve",
            "--foreground",
            "--listen-port",
            &listen_port.to_string(),
        ])
        .env("OPENCODEX_HOME", &ocx_home)
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut exited = false;
    for _ in 0..100 {
        if malformed.try_wait().unwrap().is_some() {
            exited = true;
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    if !exited {
        malformed.kill().unwrap();
    }
    let status = malformed.wait().unwrap();
    fs::remove_file(&rollback_path).unwrap();
    fs::write(&state_path, state_bytes).unwrap();
    assert!(
        exited && !status.success(),
        "empty lifecycle secret must refuse startup"
    );

    let (rc_rest, _, err_rest) = run_bin(&ocx_home, &codex_home, listen_port, &["restart"], None);
    assert_eq!(rc_rest, 0, "restart stderr: {err_rest}");

    // Verify /healthz & /readyz & parity report
    let health_resp = raw_http_exchange(
        listen_port,
        &format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\n\r\n"),
    );
    assert!(health_resp.contains("200 OK"));
    assert!(health_resp.contains("\"ephemeralChild\":true"));
    assert!(!health_resp.contains("restartCapability"));
    let state_json: serde_json::Value =
        serde_json::from_slice(&fs::read(ocx_home.join("child").join("state.json")).unwrap())
            .unwrap();
    let secret = state_json["shutdownSecret"].as_str().unwrap();
    let direct_shutdown = raw_http_exchange(
        listen_port,
        &format!(
            "POST /__ocx_child/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\nx-ocx-child-shutdown: {secret}\r\nContent-Length: 0\r\n\r\n"
        ),
    );
    assert!(direct_shutdown.contains("404 Not Found"));
    let origin_shutdown = raw_http_exchange(
        listen_port,
        &format!(
            "POST /__ocx_child/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\nOrigin: https://example.invalid\r\nx-ocx-child-shutdown-challenge: {}\r\nContent-Length: 0\r\n\r\n",
            "a".repeat(64)
        ),
    );
    assert!(origin_shutdown.contains("404 Not Found"));
    assert!(!origin_shutdown.contains("x-ocx-child-shutdown-proof"));
    let first_pid: u32 =
        serde_json::from_str::<serde_json::Value>(health_resp.split("\r\n\r\n").nth(1).unwrap())
            .unwrap()["pid"]
            .as_u64()
            .unwrap() as u32;

    let wrong_codex_home = scratch.join("different-codex");
    fs::create_dir_all(&wrong_codex_home).unwrap();
    let paths = ChildPaths::new(ocx_home.clone(), codex_home.clone());
    let state_before = fs::read(&paths.state_file).unwrap();
    let journal_before = fs::read(&paths.journal_file).unwrap();
    let (wrong_rc, _, _) = run_bin(&ocx_home, &wrong_codex_home, listen_port, &["detach"], None);
    assert_ne!(
        wrong_rc, 0,
        "detach with a different Codex home must refuse"
    );
    assert!(
        fs::read(&paths.state_file).unwrap() == state_before,
        "child state changed"
    );
    assert!(
        fs::read(&paths.journal_file).unwrap() == journal_before,
        "journal changed"
    );
    assert!(
        raw_http_exchange(
            listen_port,
            &format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\n\r\n"),
        )
        .contains("200 OK")
    );

    let ready_resp = raw_http_exchange(
        listen_port,
        &format!("GET /readyz HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\n\r\n"),
    );
    assert!(ready_resp.contains("200 OK"));
    assert!(ready_resp.contains("mock-home-inst:1"));
    assert!(!home.state.parity_reports.lock().unwrap().is_empty());

    // 4. Relay SSE POST /v1/responses + strip caller credentials + reject Upgrade/smuggling
    let sse_resp = raw_http_exchange(
        listen_port,
        &format!(
            "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\nAuthorization: Bearer caller-local-tok\r\nx-api-key: caller-ant\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}"
        ),
    );
    assert!(sse_resp.contains("200 OK"));
    assert!(sse_resp.contains("event: response.created"));
    assert!(sse_resp.contains("event: response.completed"));
    let last_hdrs = home
        .state
        .observed_data_headers
        .lock()
        .unwrap()
        .last()
        .cloned()
        .unwrap();
    assert!(
        !last_hdrs
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("x-api-key"))
    );
    let auth_hdr = last_hdrs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .unwrap();
    assert_eq!(auth_hdr.1, format!("Bearer {raw_token}"));

    let ws_resp = raw_http_exchange(
        listen_port,
        &format!(
            "GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\nUpgrade: websocket\r\n\r\n"
        ),
    );
    assert!(ws_resp.contains("426 Upgrade Required"));

    let smug_resp = raw_http_exchange(
        listen_port,
        &format!(
            "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{{}}"
        ),
    );
    assert!(smug_resp.contains("400 Bad Request"));

    // 5. Spoofed listener proof rejected with 503 link_relay_auth_failed
    home.state
        .spoof_listener_proof
        .store(true, Ordering::SeqCst);
    let spoof_resp = raw_http_exchange(
        listen_port,
        &format!("GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\n\r\n"),
    );
    assert!(spoof_resp.contains("503 Service Unavailable"));
    assert!(spoof_resp.contains("link_relay_auth_failed"));
    home.state
        .spoof_listener_proof
        .store(false, Ordering::SeqCst);

    // 6. Busy-lock & mismatch --expect-link exit 5
    let paths = ChildPaths::new(ocx_home.clone(), codex_home.clone());
    {
        let _held = FileLock::acquire_blocking(&paths.lock_file).unwrap();
        let (rc_busy, _, err_busy) = run_bin(
            &ocx_home,
            &codex_home,
            listen_port,
            &["sync", "--expect-link", link_id, "--json"],
            None,
        );
        assert_eq!(rc_busy, 5);
        assert_eq!(
            err_busy.trim().lines().last().unwrap(),
            r#"{"phase":"child_link_mismatch","reason":"pending_operation"}"#
        );
    }
    let (rc_wrong, _, err_wrong) = run_bin(
        &ocx_home,
        &codex_home,
        listen_port,
        &["sync", "--expect-link", "lnk_ffffffffffffffff", "--json"],
        None,
    );
    assert_eq!(rc_wrong, 5);
    assert_eq!(
        err_wrong.trim().lines().last().unwrap(),
        r#"{"phase":"child_link_mismatch","reason":"other_link"}"#
    );

    // 7. Home settings change -> sync --expect-link --json rolls over daemon & reports parity
    *home.state.fast_mode.lock().unwrap() = Some(true);
    *home.state.catalog_slug.lock().unwrap() = "home-synced-v2".to_owned();
    thread::sleep(Duration::from_millis(15));
    let (rc_sync, out_sync, err_sync) = run_bin(
        &ocx_home,
        &codex_home,
        listen_port,
        &["sync", "--expect-link", link_id, "--json"],
        None,
    );
    assert_eq!(rc_sync, 0, "sync stderr: {err_sync}");
    assert_home_modes_kept(&ocx_home, &codex_home, "sync");
    assert_eq!(
        out_sync.trim(),
        r#"{"schema":"ocx.sync.fanout/1","home":{"state":"synced","exit":0},"fanout":{"state":"not-applicable","reason":null},"children":[]}"#
    );
    let cache_text = fs::read_to_string(codex_home.join("models_cache.json")).unwrap();
    assert!(cache_text.contains("home-synced-v2"));
    let latest_parity = home
        .state
        .parity_reports
        .lock()
        .unwrap()
        .last()
        .cloned()
        .unwrap();
    assert!(latest_parity.runtime_started_at >= latest_parity.last_apply_at.unwrap());

    // 8. Shut down Home completely (OFFLINE), simulate #1798 comment strip, then detach!
    home.shutdown();
    // Failed reattach on a different port (occupied OR unreachable Home) must keep the previous relay alive!
    let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
    let occupied_port = occupied.local_addr().unwrap().port();
    let (rc_occ, _, err_occ) = run_bin(
        &ocx_home,
        &codex_home,
        occupied_port,
        &[
            "attach",
            "--link-id",
            "lnk_0123456789abcdef",
            "--tunnel-port",
            &home.port.to_string(),
            "--listen-port",
            &occupied_port.to_string(),
        ],
        Some(cred_json.as_bytes()),
    );
    assert_ne!(rc_occ, 0);
    assert!(
        err_occ.contains(&occupied_port.to_string()),
        "stderr was: {err_occ}"
    );
    drop(occupied);
    let (rc_unreach, _, err_unreach) = run_bin(
        &ocx_home,
        &codex_home,
        occupied_port,
        &[
            "attach",
            "--link-id",
            "lnk_0123456789abcdef",
            "--tunnel-port",
            &home.port.to_string(),
            "--listen-port",
            &occupied_port.to_string(),
        ],
        Some(cred_json.as_bytes()),
    );
    assert_ne!(rc_unreach, 0);
    assert!(
        err_unreach.contains("unreachable"),
        "stderr was: {err_unreach}"
    );
    let cfg_now = fs::read_to_string(codex_home.join("config.toml")).unwrap();
    let stripped_1798: String = cfg_now
        .lines()
        .filter(|l| !l.trim().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
        + "\nuser_extra = \"kept\"\n";
    fs::write(codex_home.join("config.toml"), stripped_1798.as_bytes()).unwrap();

    let health_before_detach = raw_http_exchange(
        listen_port,
        &format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\n\r\n"),
    );
    let active_pid: u32 = serde_json::from_str::<serde_json::Value>(
        health_before_detach.split("\r\n\r\n").nth(1).unwrap(),
    )
    .unwrap()["pid"]
        .as_u64()
        .unwrap() as u32;
    assert_ne!(
        active_pid, first_pid,
        "sync must have rolled over the daemon"
    );

    let (rc_det, _, err_det) = run_bin(&ocx_home, &codex_home, listen_port, &["disconnect"], None);
    assert_eq!(rc_det, 0, "disconnect stderr: {err_det}");
    assert_home_modes_kept(&ocx_home, &codex_home, "detach");
    assert!(
        !process_is_alive(active_pid),
        "zero leftover daemon after disconnect"
    );
    assert!(TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], listen_port))).is_err());
    let restored_cfg = fs::read_to_string(codex_home.join("config.toml")).unwrap();
    assert!(!restored_cfg.contains("openai_base_url"));
    assert!(!restored_cfg.contains("opencodex-catalog.json"));
    assert!(restored_cfg.contains("approval_policy = \"on-request\""));
    assert!(restored_cfg.contains("user_extra = \"kept\""));
    assert!(!codex_home.join("opencodex-catalog.json").exists());
    assert!(!codex_home.join("models_cache.json").exists());
    assert!(
        !ocx_home.join("child").exists(),
        "detach removes the emptied child directory, including the released start gate"
    );
    assert!(
        ocx_home.join("child.lock").exists(),
        "the lifecycle lock lives outside child/ and survives detach"
    );
    let _ = fs::remove_dir_all(&scratch);
}

#[cfg(unix)]
fn set_dir_mode_755(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(not(unix))]
fn set_dir_mode_755(_dir: &Path) {}

#[cfg(unix)]
fn assert_home_modes_kept(ocx_home: &Path, codex_home: &Path, step: &str) {
    use std::os::unix::fs::PermissionsExt;
    for (name, dir) in [("OPENCODEX_HOME", ocx_home), ("CODEX_HOME", codex_home)] {
        let mode = fs::metadata(dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o755,
            "{step} changed the mode of the pre-existing {name}"
        );
    }
}

#[cfg(not(unix))]
fn assert_home_modes_kept(_ocx_home: &Path, _codex_home: &Path, _step: &str) {}

#[test]
fn detach_purge_removes_only_managed_binary_refuses_symlinks_and_emits_conflict_codes() {
    let bin = Path::new(env!("CARGO_BIN_EXE_ocx-child"));
    let scratch = std::env::temp_dir().join(format!(
        "ocx-child-purge-test-{}-{}",
        std::process::id(),
        ocx_child::platform::now_epoch_ms()
    ));
    let fake_home = scratch.join("home");
    let ocx_home = fake_home.join(".opencodex");
    let codex_home = fake_home.join(".codex");
    fs::create_dir_all(&codex_home).unwrap();

    // 1. Conflict code: child_port_busy before Home contact
    let held = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
    let held_port = held.local_addr().unwrap().port();
    let cred = r#"{"apiKeyId":"key_1","key":"ocx_data_0123456789abcdef0123456789abcdef01234567"}"#;
    let (rc_busy, _, err_busy) = run_bin(
        &ocx_home,
        &codex_home,
        held_port,
        &[
            "connect",
            "--link",
            "--key-stdin",
            "--link-id",
            "lnk_0123456789abcdef",
            "--tunnel-port",
            "24500",
        ],
        Some(cred.as_bytes()),
    );
    assert_eq!(rc_busy, 1);
    assert!(
        err_busy.contains("ocx-child-conflict:child_port_busy:"),
        "got: {err_busy}"
    );
    drop(held);

    // 2. Conflict code: child_external_provider_conflict across all 3 root conflict branches
    for sample in [
        "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://api.example.com/v1\"\n",
        "openai_base_url = \"https://custom.example.com/v1\"\n",
        "model_catalog_json = \"/tmp/custom-catalog.json\"\n",
    ] {
        let err =
            ocx_child::toml_surgeon::detect_unowned_root_routing_conflict(sample).unwrap_err();
        assert!(
            err.contains("ocx-child-conflict:child_external_provider_conflict:"),
            "got: {err}"
        );
    }

    // 3. Foreign executable path: --purge keeps foreign binary intact
    let foreign_dir = scratch.join("foreign");
    fs::create_dir_all(&foreign_dir).unwrap();
    let exe_name = if cfg!(windows) {
        "ocx-child.exe"
    } else {
        "ocx-child"
    };
    let foreign_exe = foreign_dir.join(exe_name);
    fs::copy(bin, &foreign_exe).unwrap();
    let out_foreign = Command::new(&foreign_exe)
        .args(["detach", "--purge", "--json"])
        .env("HOME", &fake_home)
        .env("USERPROFILE", &fake_home)
        .env("OPENCODEX_HOME", &ocx_home)
        .env("CODEX_HOME", &codex_home)
        .output()
        .unwrap();
    assert_eq!(out_foreign.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out_foreign.stdout).contains("\"purged\":false"));
    assert!(
        foreign_exe.exists(),
        "foreign binary must never be deleted by --purge"
    );

    // 4. Managed plant path: --purge deletes planted binary and empty child directory
    let managed_bin_dir = fake_home.join(".cache").join("opencodex").join("bin");
    fs::create_dir_all(&managed_bin_dir).unwrap();
    let planted_exe = managed_bin_dir.join(exe_name);
    fs::copy(bin, &planted_exe).unwrap();
    let out_managed = Command::new(&planted_exe)
        .args(["disconnect", "--purge", "--json"])
        .env("HOME", &fake_home)
        .env("USERPROFILE", &fake_home)
        .env("OPENCODEX_HOME", &ocx_home)
        .env("CODEX_HOME", &codex_home)
        .output()
        .unwrap();
    assert_eq!(out_managed.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out_managed.stdout).contains("\"purged\":true"));
    #[cfg(unix)]
    assert!(
        !planted_exe.exists(),
        "managed planted binary must be removed"
    );
    assert!(
        !ocx_home.join("child").exists(),
        "empty child state dir must be removed"
    );

    // 5. Ancestor symlink guard on Unix: refuses when .cache/opencodex is a symlink to foreign_dir
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let sym_home = scratch.join("sym-home");
        fs::create_dir_all(sym_home.join(".cache")).unwrap();
        let target_root = scratch.join("real-target");
        fs::create_dir_all(target_root.join("bin")).unwrap();
        let target_exe = target_root.join("bin").join("ocx-child");
        fs::copy(bin, &target_exe).unwrap();
        symlink(&target_root, sym_home.join(".cache").join("opencodex")).unwrap();
        let via_sym = sym_home
            .join(".cache")
            .join("opencodex")
            .join("bin")
            .join("ocx-child");
        let sym_err =
            ocx_child::platform::purge_managed_executable(&via_sym, &sym_home, None).unwrap_err();
        assert!(
            sym_err.contains("symlink"),
            "expected symlink refusal, got: {sym_err}"
        );
        assert!(
            target_exe.exists(),
            "target behind ancestor symlink must remain intact"
        );
    }

    let _ = fs::remove_dir_all(&scratch);
}

#[cfg(unix)]
#[test]
fn child_state_debug_redacts_the_shutdown_secret_and_keeps_the_wire_format() {
    let secret = "0123456789abcdef".repeat(3);
    let state = ChildStateV1 {
        schema: CHILD_STATE_SCHEMA.to_owned(),
        link_id: "lnk_0123456789abcdef".to_owned(),
        api_key_id: "link:t".to_owned(),
        token_fingerprint: "fingerprint".to_owned(),
        tunnel_port: 12345,
        listen_port: 10100,
        connected_at: String::new(),
        catalog_fingerprint: String::new(),
        catalog_synced_at: String::new(),
        daemon_pid: None,
        daemon_started_at_ms: None,
        shutdown_secret: secret.clone().into(),
        parity_sequence: 0,
        pending_operation: None,
        applied_settings: None,
        daemon_generation: None,
    };
    let debug = format!("{state:?}");
    assert!(
        !debug.contains(&secret),
        "Debug printed the secret: {debug}"
    );
    let json: serde_json::Value = serde_json::to_value(&state).unwrap();
    assert_eq!(
        json["shutdownSecret"],
        serde_json::Value::String(secret.clone())
    );
    let back: ChildStateV1 = serde_json::from_value(json).unwrap();
    assert_eq!(back, state);
}
