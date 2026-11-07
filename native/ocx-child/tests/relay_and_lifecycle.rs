#![deny(unsafe_op_in_unsafe_fn)]

use std::collections::HashSet;
use std::fs;
use std::io::{BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use ocx_child::daemon::pick_ephemeral_link_port;
#[cfg(unix)]
use ocx_child::daemon::stop_owned_daemon;
use ocx_child::http_wire::{
    read_bounded_body, read_request_head, read_response_head, validate_and_sanitize_request_headers,
};
use ocx_child::parity::{LinkChildParityReport, parse_link_child_parity_report};
use ocx_child::platform::{FileLock, process_is_alive};
use ocx_child::relay_auth::{
    compute_child_shutdown_proof, compute_connection_proof, compute_relay_proof,
    relay_proof_matches, token_fingerprint_hex,
};
use ocx_child::state::ChildPaths;
#[cfg(unix)]
use ocx_child::state::{CHILD_STATE_SCHEMA, ChildStateV1};

struct MockHomeState {
    spoof_listener_proof: AtomicBool,
    fast_mode: Mutex<Option<bool>>,
    catalog_slug: Mutex<String>,
    catalog_status: AtomicU16,
    settings_status: AtomicU16,
    used_nonces: Mutex<HashSet<String>>,
    parity_reports: Mutex<Vec<LinkChildParityReport>>,
    observed_data_headers: Mutex<Vec<Vec<(String, String)>>>,
    stop: AtomicBool,
}

struct MockHomeServer {
    port: u16,
    state: Arc<MockHomeState>,
    handle: Option<thread::JoinHandle<()>>,
}

impl MockHomeServer {
    fn start(raw_token: &str, key_id: &str, link_id: &str) -> Self {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
        let port = listener.local_addr().unwrap().port();
        let fp = token_fingerprint_hex(raw_token);
        let raw_token = raw_token.to_owned();
        let key_id = key_id.to_owned();
        let link_id = link_id.to_owned();
        let state = Arc::new(MockHomeState {
            spoof_listener_proof: AtomicBool::new(false),
            fast_mode: Mutex::new(None),
            catalog_slug: Mutex::new("home-initial".to_owned()),
            catalog_status: AtomicU16::new(200),
            settings_status: AtomicU16::new(200),
            used_nonces: Mutex::new(HashSet::new()),
            parity_reports: Mutex::new(Vec::new()),
            observed_data_headers: Mutex::new(Vec::new()),
            stop: AtomicBool::new(false),
        });
        let st = Arc::clone(&state);
        let handle = thread::spawn(move || {
            for incoming in listener.incoming() {
                if st.stop.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(sock) = incoming else {
                    continue;
                };
                if st.stop.load(Ordering::SeqCst) {
                    break;
                }
                let st2 = Arc::clone(&st);
                let fp2 = fp.clone();
                let tok2 = raw_token.clone();
                let kid2 = key_id.clone();
                let lid2 = link_id.clone();
                thread::spawn(move || {
                    handle_mock_home_socket(sock, &st2, &fp2, &tok2, &kid2, &lid2)
                });
            }
        });
        Self {
            port,
            state,
            handle: Some(handle),
        }
    }

    fn shutdown(&mut self) {
        self.state.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], self.port)));
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for MockHomeServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn parse_query_param(query: &str, name: &str) -> Option<String> {
    let q = query.strip_prefix('?').unwrap_or(query);
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=')
            && k == name
        {
            return Some(v.replace("%3A", ":"));
        }
    }
    None
}

fn handle_mock_home_socket(
    sock: TcpStream,
    st: &MockHomeState,
    fp: &str,
    raw_token: &str,
    key_id: &str,
    link_id: &str,
) {
    let peer_addr = sock.peer_addr().unwrap();
    let _ = sock.set_read_timeout(Some(Duration::from_secs(5)));
    let mut writer = sock.try_clone().unwrap();
    let mut reader = BufReader::new(sock);

    // Request 1 on socket MUST be credential-free preflight
    let Ok(pre) = read_request_head(&mut reader) else {
        return;
    };
    if pre.path != "/.well-known/opencodex/link-relay-auth" || pre.method != "GET" {
        let _ = writer
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    assert!(pre.header("authorization").is_none());
    assert!(pre.header("x-opencodex-api-key").is_none());
    let ver = parse_query_param(&pre.query, "version").unwrap_or_default();
    let q_key = parse_query_param(&pre.query, "key").unwrap_or_default();
    let q_link = parse_query_param(&pre.query, "link").unwrap_or_default();
    let nonce = parse_query_param(&pre.query, "nonce").unwrap_or_default();
    let proof = parse_query_param(&pre.query, "proof").unwrap_or_default();
    let expected_caller = compute_relay_proof(fp, "caller", key_id, link_id, &nonce);
    if ver != "2"
        || q_key != key_id
        || q_link != link_id
        || !relay_proof_matches(Some(&proof), expected_caller.as_deref())
    {
        let _ = writer
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let is_probe = pre.header("x-opencodex-link-probe") == Some("1");
    if !is_probe {
        let mut used = st.used_nonces.lock().unwrap();
        if !used.insert(nonce.clone()) {
            let _ = writer.write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
    }
    let listener_proof = if st.spoof_listener_proof.load(Ordering::SeqCst) {
        "0".repeat(64)
    } else {
        compute_relay_proof(fp, "listener", key_id, link_id, &nonce).unwrap()
    };
    let generation = "mock-home-inst:1";
    let conn_proof = compute_connection_proof(fp, key_id, link_id, &nonce, generation).unwrap();
    let pre_resp = format!(
        "HTTP/1.1 204 No Content\r\nx-opencodex-link-proof: {listener_proof}\r\nx-opencodex-link-connection: {generation}\r\nx-opencodex-link-connection-proof: {conn_proof}\r\ncache-control: no-store\r\n\r\n"
    );
    if writer.write_all(pre_resp.as_bytes()).is_err() || writer.flush().is_err() || is_probe {
        return;
    }

    // Request 2 MUST arrive on this EXACT same socket (`peer_addr`) with `x-opencodex-link-session: <nonce>`!
    assert_eq!(reader.get_ref().peer_addr().unwrap(), peer_addr);
    let Ok(data_req) = read_request_head(&mut reader) else {
        return;
    };
    assert_eq!(
        data_req.header("x-opencodex-link-session"),
        Some(nonce.as_str())
    );
    st.observed_data_headers
        .lock()
        .unwrap()
        .push(data_req.headers.clone());

    let authed = data_req.header("x-opencodex-api-key") == Some(raw_token)
        || data_req.header("authorization") == Some(&format!("Bearer {raw_token}"));
    if !authed {
        let _ = writer.write_all(
            b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    }

    let v = validate_and_sanitize_request_headers(&data_req.headers).unwrap();
    let body = if data_req.method == "POST" {
        read_bounded_body(&mut reader, v.framing, 1024 * 1024).unwrap()
    } else {
        Vec::new()
    };

    match (data_req.method.as_str(), data_req.path.as_str()) {
        ("GET", "/readyz") => {
            let b = br#"{"status":"ready","protocolVersion":1,"minClientProtocolVersion":1,"maxClientProtocolVersion":1,"version":"2.98.0","managementUrl":"http://127.0.0.1"}"#;
            let _ = write!(
                writer,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                b.len()
            );
            let _ = writer.write_all(b);
        }
        ("GET", "/v1/catalog") => {
            let status = st.catalog_status.load(Ordering::SeqCst);
            if status != 200 {
                let _ = write!(
                    writer,
                    "HTTP/1.1 {status} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                return;
            }
            let slug = st.catalog_slug.lock().unwrap().clone();
            let b = format!("{{\"models\":[{{\"slug\":\"{slug}\"}}]}}\n");
            let _ = write!(
                writer,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}",
                b.len()
            );
        }
        ("GET", "/v1/link-management/codex-settings") => {
            let status = st.settings_status.load(Ordering::SeqCst);
            if status != 200 {
                let _ = write!(
                    writer,
                    "HTTP/1.1 {status} Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                return;
            }
            let fm = *st.fast_mode.lock().unwrap();
            let doc = serde_json::json!({
                "version": 1,
                "home": { "name": "mock-home", "version": "2.98.0" },
                "settings": {
                    "fastMode": fm,
                    "multiAgentMode": "v1",
                    "webSearchSidecarEnabled": false,
                    "subagentDefaults": { "model": "gpt-5.6-sol", "reasoningEffort": "high" }
                }
            });
            let b = serde_json::to_vec(&doc).unwrap();
            let _ = write!(
                writer,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                b.len()
            );
            let _ = writer.write_all(&b);
        }
        ("POST", "/v1/link-management/child-parity") => {
            let text = std::str::from_utf8(&body).unwrap();
            let parsed = parse_link_child_parity_report(text).expect("valid LinkChildParityReport");
            st.parity_reports.lock().unwrap().push(parsed);
            let _ = writer.write_all(
                b"HTTP/1.1 204 No Content\r\ncache-control: no-store\r\nConnection: close\r\n\r\n",
            );
        }
        ("POST", "/v1/responses") => {
            let _ = writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
            let ev1 = b"event: response.created\ndata: {\"id\":\"resp_1\"}\n\n";
            let ev2 = b"event: response.completed\ndata: {\"ok\":true}\n\n";
            let _ = write!(writer, "{:x}\r\n", ev1.len());
            let _ = writer.write_all(ev1);
            let _ = writer.write_all(b"\r\n");
            let _ = writer.flush();
            let _ = write!(writer, "{:x}\r\n", ev2.len());
            let _ = writer.write_all(ev2);
            let _ = writer.write_all(b"\r\n0\r\n\r\n");
        }
        _ => {
            let _ = writer.write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
    }
    let _ = writer.flush();
}

fn run_bin(
    ocx_home: &Path,
    codex_home: &Path,
    listen_port: u16,
    args: &[&str],
    stdin_bytes: Option<&[u8]>,
) -> (i32, String, String) {
    let exe = env!("CARGO_BIN_EXE_ocx-child");
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .env("OPENCODEX_HOME", ocx_home)
        .env("CODEX_HOME", codex_home)
        .env("OCX_CHILD_LISTEN_PORT", listen_port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin_bytes.is_some() {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    let mut child = cmd.spawn().unwrap();
    if let Some(input) = stdin_bytes {
        child.stdin.take().unwrap().write_all(input).unwrap();
    }
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn raw_http_exchange(port: u16, raw_req: &str) -> String {
    let mut sock = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port))).unwrap();
    sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    sock.write_all(raw_req.as_bytes()).unwrap();
    sock.flush().unwrap();
    let mut out = Vec::new();
    use std::io::Read;
    let _ = sock.read_to_end(&mut out);
    String::from_utf8_lossy(&out).into_owned()
}

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
        shutdown_secret: "a".repeat(48),
        parity_sequence: 0,
        pending_operation: None,
        applied_settings: None,
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
    assert!(err_conflict.contains("full OpenCodex runtime state"));
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
    let _ = fs::remove_dir_all(&scratch);
}
