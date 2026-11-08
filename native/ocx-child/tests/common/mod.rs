#![allow(dead_code)]
//! Shared process-level harness for ocx-child integration tests: a mock Home that speaks
//! link-relay-auth v2, binary runners, and helpers for the env-gated test barrier.

use std::collections::HashSet;
use std::fs;
use std::io::{BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use ocx_child::http_wire::{
    read_bounded_body, read_request_head, validate_and_sanitize_request_headers,
};
use ocx_child::parity::{LinkChildParityReport, parse_link_child_parity_report};
use ocx_child::relay_auth::{
    compute_connection_proof, compute_relay_proof, relay_proof_matches, token_fingerprint_hex,
};

pub struct MockHomeState {
    pub spoof_listener_proof: AtomicBool,
    pub fast_mode: Mutex<Option<bool>>,
    pub catalog_slug: Mutex<String>,
    pub catalog_status: AtomicU16,
    pub settings_status: AtomicU16,
    pub used_nonces: Mutex<HashSet<String>>,
    pub parity_reports: Mutex<Vec<LinkChildParityReport>>,
    pub observed_data_headers: Mutex<Vec<Vec<(String, String)>>>,
    pub stop: AtomicBool,
    /// 0 answers parity reports, 1 holds the socket without answering, 2 trickles an
    /// unfinished response until the peer goes away.
    pub parity_mode: AtomicU8,
    pub parity_stalled: AtomicUsize,
}

pub struct MockHomeServer {
    pub port: u16,
    pub state: Arc<MockHomeState>,
    pub handle: Option<thread::JoinHandle<()>>,
}

impl MockHomeServer {
    pub fn start(raw_token: &str, key_id: &str, link_id: &str) -> Self {
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
            parity_mode: AtomicU8::new(0),
            parity_stalled: AtomicUsize::new(0),
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

    pub fn shutdown(&mut self) {
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
            let mode = st.parity_mode.load(Ordering::SeqCst);
            if mode != 0 {
                st.parity_stalled.fetch_add(1, Ordering::SeqCst);
                hold_parity_socket(&mut writer, mode, st);
                return;
            }
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

pub fn run_bin(
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

pub fn raw_http_exchange(port: u16, raw_req: &str) -> String {
    let mut sock = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port))).unwrap();
    sock.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    sock.write_all(raw_req.as_bytes()).unwrap();
    sock.flush().unwrap();
    let mut out = Vec::new();
    use std::io::Read;
    let _ = sock.read_to_end(&mut out);
    String::from_utf8_lossy(&out).into_owned()
}

fn hold_parity_socket(writer: &mut TcpStream, mode: u8, st: &MockHomeState) {
    let deadline = Instant::now() + Duration::from_secs(60);
    if mode == 2 {
        if writer
            .write_all(
                b"HTTP/1.1 204 No Content
x-trickle: ",
            )
            .is_err()
        {
            return;
        }
        while Instant::now() < deadline && !st.stop.load(Ordering::SeqCst) {
            if writer
                .write_all(b"a")
                .and_then(|()| writer.flush())
                .is_err()
            {
                return;
            }
            thread::sleep(Duration::from_millis(200));
        }
        return;
    }
    let _ = writer.set_read_timeout(Some(Duration::from_millis(50)));
    let mut probe = [0u8; 1];
    while Instant::now() < deadline && !st.stop.load(Ordering::SeqCst) {
        match writer.read(&mut probe) {
            Ok(0) => return,
            Ok(_) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
        }
    }
}

pub const BARRIER_DIR_ENV: &str = "OCX_CHILD_TEST_BARRIER_DIR";
pub const BARRIERS_ENV: &str = "OCX_CHILD_TEST_BARRIERS";

/// Directory-backed handle for the env-gated barrier in `ocx_child::test_hooks`.
pub struct Barrier {
    pub dir: PathBuf,
}

impl Barrier {
    pub fn new(root: &Path, label: &str) -> Self {
        let dir = root.join(format!("barrier-{label}"));
        fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    pub fn apply(&self, cmd: &mut Command, names: &str) {
        cmd.env(BARRIER_DIR_ENV, &self.dir).env(BARRIERS_ENV, names);
    }

    pub fn reached(&self, name: &str) -> bool {
        self.dir.join(format!("{name}.reached")).exists()
    }

    pub fn wait_reached(&self, name: &str, timeout: Duration) -> bool {
        wait_until(timeout, || self.reached(name))
    }

    pub fn release(&self, name: &str) {
        fs::write(self.dir.join(format!("{name}.release")), b"go").unwrap();
    }
}

pub fn wait_until(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if done() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

pub struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "ocx-child-{label}-{}-{}",
            std::process::id(),
            ocx_child::platform::random_hex(6).unwrap()
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn child_command(
    ocx_home: &Path,
    codex_home: &Path,
    listen_port: u16,
    args: &[&str],
) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ocx-child"));
    cmd.args(args)
        .env("OPENCODEX_HOME", ocx_home)
        .env("CODEX_HOME", codex_home)
        .env("OCX_CHILD_LISTEN_PORT", listen_port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

pub fn attach_args<'a>(
    tunnel_port: &'a str,
    link_id: &'a str,
    listen_port: &'a str,
) -> Vec<&'a str> {
    vec![
        "attach",
        "--key-stdin",
        "--tunnel-port",
        tunnel_port,
        "--link-id",
        link_id,
        "--listen-port",
        listen_port,
    ]
}
