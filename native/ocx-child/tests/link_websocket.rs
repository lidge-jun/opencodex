//! The link WebSocket through the real ocx-child binary: the relay route decides between today's
//! 426 and the link WebSocket, and a daemon built with the test feature carries frames both ways.
//! Requires the link-ws-test-gate feature (Cargo.toml [[test]] required-features).

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

use common::{Scratch, run_bin};
use ocx_child::daemon::{pick_ephemeral_link_port, send_attested_shutdown};
use ocx_child::http_wire::{
    read_bounded_body, read_request_head, read_response_head, validate_and_sanitize_request_headers,
};
use ocx_child::link_ws::websocket_accept;
use ocx_child::link_ws_advert::ws_state_proof;
use ocx_child::link_ws_frame::{
    FrameEvent, FrameReader, Role, close_payload, frame_header, mask_in_place,
};
use ocx_child::relay_auth::{compute_relay_proof, token_fingerprint_hex};
use ocx_child::state::{ChildPaths, StateReadOutcome, read_child_state};

const TOKEN: &str = "ocx_data_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEY_ID: &str = "link:ws-test";
const LINK_ID: &str = "lnk_00000000000000ab";
const TODAY_426: &str = r#"{"error":{"message":"Responses WebSocket transport is disabled; use HTTP","type":"invalid_request_error","code":"upgrade_required"}}"#;

#[derive(Default)]
struct HomeLog {
    parity: Option<mpsc::Sender<()>>,
    upgrades: Option<mpsc::Sender<Vec<(String, String)>>>,
    closes: Option<mpsc::Sender<Option<u16>>>,
}

/// What the mock Home does, switchable mid-test.
#[derive(Default)]
struct HomeFlags {
    /// Answer relay-auth with the verified WebSocket state pair.
    advertise: AtomicBool,
    /// Answer relay-auth with 404 (a failed preflight).
    refuse_auth: AtomicBool,
    /// Answer the parity report with 404, which stops the Child's parity loop.
    parity_404: AtomicBool,
    /// Connections accepted so far.
    connections: AtomicUsize,
}

struct Home {
    port: u16,
    flags: Arc<HomeFlags>,
    parity: mpsc::Receiver<()>,
    upgrades: mpsc::Receiver<Vec<(String, String)>>,
    closes: mpsc::Receiver<Option<u16>>,
}

fn home(advertise: bool, parity_404: bool) -> Home {
    let flags = Arc::new(HomeFlags::default());
    flags.advertise.store(advertise, Ordering::SeqCst);
    flags.parity_404.store(parity_404, Ordering::SeqCst);
    let (parity_tx, parity) = mpsc::channel();
    let (up_tx, upgrades) = mpsc::channel();
    let (close_tx, closes) = mpsc::channel();
    let port = mock_home(Arc::clone(&flags), parity_tx, up_tx, close_tx);
    Home {
        port,
        flags,
        parity,
        upgrades,
        closes,
    }
}

/// A Home for one link: relay-auth v2 with the WebSocket state pair while `advertise` is set, the routes
/// enrollment and serving use, and an echo server behind the upgrade ("echo:" + each text message).
fn mock_home(
    flags: Arc<HomeFlags>,
    parity: mpsc::Sender<()>,
    upgrades: mpsc::Sender<Vec<(String, String)>>,
    closes: mpsc::Sender<Option<u16>>,
) -> u16 {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(stream) = conn else { return };
            flags.connections.fetch_add(1, Ordering::SeqCst);
            let flags = Arc::clone(&flags);
            let log = HomeLog {
                parity: Some(parity.clone()),
                upgrades: Some(upgrades.clone()),
                closes: Some(closes.clone()),
            };
            thread::spawn(move || home_connection(stream, &flags, log));
        }
    });
    port
}

fn home_connection(stream: TcpStream, flags: &HomeFlags, log: HomeLog) {
    let fp = token_fingerprint_hex(TOKEN);
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    let Ok(pre) = read_request_head(&mut reader) else {
        return;
    };
    let param = |name: &str| {
        pre.query
            .split('&')
            .find_map(|kv| kv.strip_prefix(&format!("{name}=")))
            .unwrap_or("")
            .replace("%3A", ":")
    };
    let nonce = param("nonce");
    if pre.path != "/.well-known/opencodex/link-relay-auth"
        || flags.refuse_auth.load(Ordering::SeqCst)
        || compute_relay_proof(&fp, "caller", KEY_ID, LINK_ID, &nonce).as_deref()
            != Some(param("proof").as_str())
    {
        let _ = writer
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let mut answer = format!(
        "HTTP/1.1 204 No Content\r\nx-opencodex-link-proof: {}\r\n",
        compute_relay_proof(&fp, "listener", KEY_ID, LINK_ID, &nonce).unwrap()
    );
    if flags.advertise.load(Ordering::SeqCst) {
        answer.push_str(&format!(
            "x-opencodex-link-ws-state: on\r\nx-opencodex-link-ws-proof: {}\r\n",
            ws_state_proof(&fp, KEY_ID, LINK_ID, &nonce).unwrap()
        ));
    }
    answer.push_str("\r\n");
    if writer.write_all(answer.as_bytes()).is_err()
        || pre
            .headers
            .iter()
            .any(|(k, v)| k.eq_ignore_ascii_case("x-opencodex-link-probe") && v == "1")
    {
        return;
    }
    let Ok(req) = read_request_head(&mut reader) else {
        return;
    };
    if req
        .headers
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("upgrade"))
    {
        let key = req
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("sec-websocket-key"))
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        if let Some(tx) = &log.upgrades {
            let _ = tx.send(req.headers.clone());
        }
        let _ = writer.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n", websocket_accept(&key)).as_bytes());
        let mut frames = FrameReader::new(Role::FromClient, 16 << 20, 4096);
        let mut buf = vec![0u8; 16 << 10];
        let leftover = reader.buffer().to_vec();
        let mut pending = leftover;
        loop {
            let mut events = Vec::new();
            if frames.push(&pending, &mut events).is_err() {
                return;
            }
            for event in events {
                match event {
                    FrameEvent::Text(text) => {
                        let body = format!("echo:{text}");
                        let _ = writer.write_all(
                            &[frame_header(1, body.len(), None), body.into_bytes()].concat(),
                        );
                    }
                    FrameEvent::Close(code, _) => {
                        if let Some(tx) = &log.closes {
                            let _ = tx.send(code);
                        }
                        let payload = close_payload(code, "");
                        let _ = writer
                            .write_all(&[frame_header(8, payload.len(), None), payload].concat());
                        return;
                    }
                    _ => {}
                }
            }
            match reader.get_mut().read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => pending = buf[..n].to_vec(),
            }
        }
    }
    let framing = validate_and_sanitize_request_headers(&req.headers).map(|v| v.framing);
    if let Ok(framing) = framing {
        let _ = read_bounded_body(&mut reader, framing, 1 << 20);
    }
    let body: Vec<u8> = match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/readyz") => br#"{"status":"ready","protocolVersion":1,"minClientProtocolVersion":1,"maxClientProtocolVersion":1,"version":"2.98.0","managementUrl":"http://127.0.0.1"}"#.to_vec(),
        ("GET", "/v1/catalog") => br#"{"models":[{"slug":"ws-model"}]}"#.to_vec(),
        ("GET", "/v1/link-management/codex-settings") => br#"{"version":1,"home":{"name":"ws-home","version":"2.98.0"},"settings":{"fastMode":null,"multiAgentMode":"v1","webSearchSidecarEnabled":false,"subagentDefaults":{"model":"m","reasoningEffort":"high"}}}"#.to_vec(),
        ("POST", "/v1/link-management/child-parity") => {
            if let Some(tx) = &log.parity {
                let _ = tx.send(());
            }
            let answer: &[u8] = if flags.parity_404.load(Ordering::SeqCst) {
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            } else {
                b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"
            };
            let _ = writer.write_all(answer);
            return;
        }
        ("POST", "/v1/responses") => br#"{"id":"resp_http","status":"completed","output":[]}"#.to_vec(),
        _ => {
            let _ = writer.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }
    };
    let _ = write!(
        writer,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = writer.write_all(&body);
}

struct Relay {
    child: Child,
    port: u16,
}

impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Enroll against the mock Home and start a foreground relay; returns once its parity report arrived
/// (the report is sent only after the listener is bound).
fn relay(scratch: &Scratch, home_port: u16, parity: &mpsc::Receiver<()>, gate: bool) -> Relay {
    let ocx_home = scratch.0.join("opencodex");
    let codex_home = scratch.0.join("codex");
    std::fs::create_dir_all(&ocx_home).unwrap();
    std::fs::create_dir_all(&codex_home).unwrap();
    let port = pick_ephemeral_link_port().unwrap();
    let cred = format!("{{\"apiKeyId\":\"{KEY_ID}\",\"key\":\"{TOKEN}\"}}");
    let (rc, _, err) = run_bin(
        &ocx_home,
        &codex_home,
        port,
        &[
            "connect",
            "--link",
            "--key-stdin",
            "--tunnel-port",
            &home_port.to_string(),
            "--link-id",
            LINK_ID,
        ],
        Some(cred.as_bytes()),
    );
    assert_eq!(rc, 0, "connect: {err}");
    while parity.try_recv().is_ok() {}
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ocx-child"));
    cmd.args(["serve", "--foreground", "--listen-port", &port.to_string()])
        .env("OPENCODEX_HOME", &ocx_home)
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if gate {
        cmd.env("OCX_CHILD_TEST_LINK_WS_READY", "1");
    } else {
        cmd.env_remove("OCX_CHILD_TEST_LINK_WS_READY");
    }
    let child = cmd.spawn().unwrap();
    parity
        .recv_timeout(Duration::from_secs(30))
        .expect("the relay reported parity");
    Relay { child, port }
}

fn upgrade(port: u16, extra: &str) -> (u16, String, String, TcpStream, Vec<u8>) {
    let mut s = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port))).unwrap();
    let head = format!(
        "GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nthread-id: thread-int\r\n{extra}\r\n"
    );
    s.write_all(head.as_bytes()).unwrap();
    let mut reader = BufReader::new(s.try_clone().unwrap());
    let resp = read_response_head(&mut reader).unwrap();
    let length = resp
        .header("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; if resp.status == 101 { 0 } else { length }];
    reader.read_exact(&mut body).unwrap();
    let headers = resp
        .headers
        .iter()
        .map(|(k, v)| format!("{}: {v}", k.to_ascii_lowercase()))
        .collect::<Vec<_>>()
        .join("\n");
    let leftover = reader.buffer().to_vec();
    (
        resp.status,
        headers,
        String::from_utf8(body).unwrap(),
        s,
        leftover,
    )
}

/// One relayed HTTP turn; returns its status (the mock Home completes it with 200).
fn relayed_http_status(port: u16) -> u16 {
    let mut s = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port))).unwrap();
    let body = r#"{"model":"m","input":"hi"}"#;
    s.write_all(format!("POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
    let mut reader = BufReader::new(s);
    let resp = read_response_head(&mut reader).unwrap();
    let mut rest = String::new();
    let _ = reader.read_line(&mut rest);
    resp.status
}

fn relayed_http(port: u16) {
    assert_eq!(relayed_http_status(port), 200);
}

/// Text frames from Codex's side: one masked message out, the echo back.
fn echo_round_trip(codex: &mut TcpStream, leftover: &[u8], text: &str) -> Vec<FrameEvent> {
    let mask = [3, 1, 4, 1];
    let mut payload = text.as_bytes().to_vec();
    let header = frame_header(1, payload.len(), Some(mask));
    mask_in_place(&mut payload, mask);
    codex.write_all(&[header, payload].concat()).unwrap();
    read_codex(codex, leftover, 1)
}

fn read_codex(codex: &mut TcpStream, leftover: &[u8], count: usize) -> Vec<FrameEvent> {
    let mut frames = FrameReader::new(Role::FromServer, 16 << 20, 4096);
    let mut events = Vec::new();
    frames.push(leftover, &mut events).unwrap();
    let mut buf = vec![0u8; 4096];
    while events.len() < count {
        match codex.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => frames.push(&buf[..n], &mut events).unwrap(),
        }
    }
    events
}

#[test]
fn without_the_gate_the_upgrade_gets_todays_426_and_never_reaches_the_home() {
    let scratch = Scratch::new("link-ws-closed");
    let home = home(true, false);
    let relay = relay(&scratch, home.port, &home.parity, false);
    relayed_http(relay.port);
    let before = home.flags.connections.load(Ordering::SeqCst);
    let (status, _, body, _, _) = upgrade(relay.port, "");
    assert_eq!(status, 426);
    assert_eq!(body, TODAY_426);
    assert_eq!(
        home.flags.connections.load(Ordering::SeqCst),
        before,
        "the closed gate opens no connection to the Home"
    );
    assert!(
        home.upgrades.try_recv().is_err(),
        "no upgrade reached the Home"
    );
}

#[test]
fn with_the_gate_an_advertising_home_carries_frames_both_ways() {
    let scratch = Scratch::new("link-ws-open");
    let home = home(false, false);
    let relay = relay(&scratch, home.port, &home.parity, true);
    // Not advertised yet: today's 426, nothing sent to the Home.
    relayed_http(relay.port);
    let (status, _, body, _, _) = upgrade(relay.port, "");
    assert_eq!((status, body.as_str()), (426, TODAY_426));
    assert!(home.upgrades.try_recv().is_err());
    // The Home starts advertising; one relayed request teaches the serving process.
    home.flags.advertise.store(true, Ordering::SeqCst);
    relayed_http(relay.port);
    let (status, headers, _, mut codex, leftover) =
        upgrade(relay.port, "Authorization: Bearer codex-own\r\n");
    assert_eq!(status, 101);
    assert!(headers.contains("x-codex-websocket-max-message-bytes: 8388608"));
    let home_headers = home.upgrades.recv().unwrap();
    let auth = home_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.clone());
    assert_eq!(auth.as_deref(), Some(format!("Bearer {TOKEN}").as_str()));
    assert_eq!(
        echo_round_trip(&mut codex, &leftover, r#"{"type":"response.create"}"#),
        vec![FrameEvent::Text(
            r#"echo:{"type":"response.create"}"#.into()
        )]
    );
}

/// Discovery: only a verified preflight of the serving process turns the state on, a failed
/// one teaches nothing, the parity loop is not needed, and a Home that switches off ends on HTTP.
#[test]
fn a_failed_preflight_teaches_nothing_and_a_home_that_switches_off_ends_on_http() {
    let scratch = Scratch::new("link-ws-discovery");
    // The parity report gets 404, so the parity loop stops after its first (off) answer.
    let home = home(false, true);
    let relay = relay(&scratch, home.port, &home.parity, true);
    // The Home advertises, but this preflight fails: still today's 426.
    home.flags.advertise.store(true, Ordering::SeqCst);
    home.flags.refuse_auth.store(true, Ordering::SeqCst);
    assert_ne!(relayed_http_status(relay.port), 200);
    let (status, _, body, _, _) = upgrade(relay.port, "");
    assert_eq!((status, body.as_str()), (426, TODAY_426));
    assert!(home.upgrades.try_recv().is_err());
    // The next relayed request verifies the Home's on: the upgrade is carried.
    home.flags.refuse_auth.store(false, Ordering::SeqCst);
    relayed_http(relay.port);
    let (status, _, _, mut codex, leftover) = upgrade(relay.port, "");
    assert_eq!(status, 101);
    assert_eq!(
        echo_round_trip(&mut codex, &leftover, "one"),
        vec![FrameEvent::Text("echo:one".into())]
    );
    drop(codex);
    // The Home switches off. The next upgrade's own preflight says so: today's 426, no upgrade sent.
    home.flags.advertise.store(false, Ordering::SeqCst);
    while home.upgrades.try_recv().is_ok() {}
    let (status, _, body, _, _) = upgrade(relay.port, "");
    assert_eq!((status, body.as_str()), (426, TODAY_426));
    assert!(
        home.upgrades.try_recv().is_err(),
        "no upgrade after an off answer"
    );
    // Codex's turn then completes on HTTP, and later upgrades get 426 without touching the Home.
    relayed_http(relay.port);
    let before = home.flags.connections.load(Ordering::SeqCst);
    let (status, _, body, _, _) = upgrade(relay.port, "");
    assert_eq!((status, body.as_str()), (426, TODAY_426));
    assert_eq!(home.flags.connections.load(Ordering::SeqCst), before);
}

/// The /readyz probe teaches the serving process too; the authenticated shutdown detach sends closes
/// both legs of an open link WebSocket with 1001 and the relay exits.
#[test]
fn the_readyz_probe_teaches_and_an_authenticated_shutdown_closes_both_legs_with_1001() {
    let scratch = Scratch::new("link-ws-readyz");
    let home = home(false, true);
    let relay = relay(&scratch, home.port, &home.parity, true);
    home.flags.advertise.store(true, Ordering::SeqCst);
    let mut probe = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], relay.port))).unwrap();
    probe
        .write_all(
            format!(
                "GET /readyz HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                relay.port
            )
            .as_bytes(),
        )
        .unwrap();
    let mut probe_reader = BufReader::new(probe);
    assert_eq!(read_response_head(&mut probe_reader).unwrap().status, 200);
    let (status, _, _, mut codex, leftover) = upgrade(relay.port, "");
    assert_eq!(status, 101, "the probe's verified on was applied");
    assert_eq!(
        echo_round_trip(&mut codex, &leftover, "two"),
        vec![FrameEvent::Text("echo:two".into())]
    );
    // detach itself cannot be used here: it waits for the PID to vanish, and this test's own child
    // stays a zombie until the test reaps it.
    let paths = ChildPaths::new(scratch.0.join("opencodex"), scratch.0.join("codex"));
    let StateReadOutcome::Valid(state) = read_child_state(&paths.state_file) else {
        panic!("child state readable");
    };
    assert!(send_attested_shutdown(
        relay.port,
        state.shutdown_secret.as_str()
    ));
    assert_eq!(
        read_codex(&mut codex, &[], 1),
        vec![FrameEvent::Close(
            Some(1001),
            "link websocket stopping".into()
        )]
    );
    assert_eq!(home.closes.recv().unwrap(), Some(1001));
    let mut relay = relay;
    assert!(relay.child.wait().unwrap().success());
}
