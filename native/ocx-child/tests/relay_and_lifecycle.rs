#![deny(unsafe_op_in_unsafe_fn)]

use std::collections::HashSet;
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
use ocx_child::http_wire::{
    read_bounded_body, read_request_head, validate_and_sanitize_request_headers,
};
use ocx_child::parity::{LinkChildParityReport, parse_link_child_parity_report};
use ocx_child::platform::{FileLock, process_is_alive};
use ocx_child::relay_auth::{
    compute_connection_proof, compute_relay_proof, relay_proof_matches, token_fingerprint_hex,
};
use ocx_child::state::ChildPaths;

struct MockHomeState {
    spoof_listener_proof: AtomicBool,
    fast_mode: Mutex<Option<bool>>,
    catalog_slug: Mutex<String>,
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
            let slug = st.catalog_slug.lock().unwrap().clone();
            let b = format!("{{\"models\":[{{\"slug\":\"{slug}\"}}]}}\n");
            let _ = write!(
                writer,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}",
                b.len()
            );
        }
        ("GET", "/v1/link-management/codex-settings") => {
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
    let first_pid: u32 =
        serde_json::from_str::<serde_json::Value>(health_resp.split("\r\n\r\n").nth(1).unwrap())
            .unwrap()["pid"]
            .as_u64()
            .unwrap() as u32;

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
        &["connect", "--link", "--key-stdin", "--link-id", "lnk_0123456789abcdef", "--tunnel-port", "24500"],
        Some(cred.as_bytes()),
    );
    assert_eq!(rc_busy, 1);
    assert!(err_busy.contains("ocx-child-conflict:child_port_busy:"), "got: {err_busy}");
    drop(held);

    // 2. Conflict code: child_external_provider_conflict across all 3 root conflict branches
    for sample in [
        "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://api.example.com/v1\"\n",
        "openai_base_url = \"https://custom.example.com/v1\"\n",
        "model_catalog_json = \"/tmp/custom-catalog.json\"\n",
    ] {
        let err = ocx_child::toml_surgeon::detect_unowned_root_routing_conflict(sample).unwrap_err();
        assert!(err.contains("ocx-child-conflict:child_external_provider_conflict:"), "got: {err}");
    }

    // 3. Foreign executable path: --purge keeps foreign binary intact
    let foreign_dir = scratch.join("foreign");
    fs::create_dir_all(&foreign_dir).unwrap();
    let exe_name = if cfg!(windows) { "ocx-child.exe" } else { "ocx-child" };
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
    assert!(foreign_exe.exists(), "foreign binary must never be deleted by --purge");

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
    assert!(!planted_exe.exists(), "managed planted binary must be removed");
    assert!(!ocx_home.join("child").exists(), "empty child state dir must be removed");

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
        let via_sym = sym_home.join(".cache").join("opencodex").join("bin").join("ocx-child");
        let sym_err = ocx_child::platform::purge_managed_executable(&via_sym, &sym_home, None).unwrap_err();
        assert!(sym_err.contains("symlink"), "expected symlink refusal, got: {sym_err}");
        assert!(target_exe.exists(), "target behind ancestor symlink must remain intact");
    }

    let _ = fs::remove_dir_all(&scratch);
}
