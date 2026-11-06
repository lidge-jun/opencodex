use std::io::{BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::OCX_PROTOCOL_COMPAT_VERSION;
use crate::http_wire::{
    BodyFraming, FramingError, HUB_RELAY_RESPONSE_BODY_MAX_BYTES, HttpRequestHead,
    HttpResponseHead, LINK_RELAY_BODY_MAX_BYTES, is_sse_headers, read_bounded_body,
    read_request_head, read_response_head, response_framing, sanitize_response_headers,
    stream_upstream_to_chunked_client, validate_and_sanitize_request_headers, write_json_response,
};
use crate::parity::LinkChildParityReport;
use crate::platform::{
    SecretBytes, constant_time_eq, format_iso8601_utc, now_epoch_ms, random_hex,
};
use crate::relay_auth::{
    LINK_RELAY_AUTH_PATH, LINK_RELAY_AUTH_VERSION, LINK_RELAY_CONNECTION_HEADER,
    LINK_RELAY_CONNECTION_PROOF_HEADER, LINK_RELAY_PROBE_HEADER, LINK_RELAY_PROOF_HEADER,
    LINK_RELAY_SESSION_HEADER, compute_connection_proof, create_relay_challenge,
    is_valid_connection_generation, relay_proof_matches,
};
use crate::routes::{RelayAuthKind, RouteDecision, classify_child_ingress};
use crate::state::{ChildPaths, StateReadOutcome, read_child_state, read_verified_link_key};

const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const HEADER_AND_SSE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_CONCURRENT_WORKERS: usize = 32;
const PEER_FEATURES: &str = "relay-auth/2,link-management-relay,link-peer-report/1";

#[derive(Debug)]
pub enum UpstreamError {
    HomeUnreachable(String),
    RelayAuthFailed(String),
    ResponseHeadersTooLarge,
    ResponseBodyTooLarge,
    BadUpstreamResponse(String),
}

pub struct RelayCredentials {
    pub api_key_id: String,
    pub link_id: String,
    pub token_fingerprint: String,
    pub raw_token: SecretBytes,
}

pub struct AuthenticatedUpstream {
    pub reader: BufReader<TcpStream>,
    pub writer: TcpStream,
    pub nonce: String,
    pub connection_generation: Option<String>,
}

fn url_encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Opens ONE `TcpStream` to `127.0.0.1:<tunnel_port>`, runs the v2 HMAC challenge/proof,
/// and returns that exact same `TcpStream` ready to transmit one bound data request.
pub fn open_authenticated_upstream(
    tunnel_port: u16,
    creds: &RelayCredentials,
    probe_only: bool,
) -> Result<AuthenticatedUpstream, UpstreamError> {
    let addr = SocketAddr::from(([127, 0, 0, 1], tunnel_port));
    let stream = TcpStream::connect_timeout(&addr, AUTH_TIMEOUT)
        .map_err(|e| UpstreamError::HomeUnreachable(format!("tunnel connect failed: {e}")))?;
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(AUTH_TIMEOUT));
    let _ = stream.set_write_timeout(Some(AUTH_TIMEOUT));
    let mut writer = stream
        .try_clone()
        .map_err(|e| UpstreamError::HomeUnreachable(format!("socket clone failed: {e}")))?;
    let mut reader = BufReader::new(stream);

    let challenge =
        create_relay_challenge(&creds.token_fingerprint, &creds.api_key_id, &creds.link_id)
            .map_err(UpstreamError::RelayAuthFailed)?;

    let target = format!(
        "{LINK_RELAY_AUTH_PATH}?version={LINK_RELAY_AUTH_VERSION}&key={}&link={}&nonce={}&proof={}",
        url_encode_component(&creds.api_key_id),
        url_encode_component(&creds.link_id),
        challenge.nonce,
        challenge.caller_proof,
    );
    let conn_hdr = if probe_only { "close" } else { "keep-alive" };
    let mut preflight = format!(
        "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{tunnel_port}\r\nAccept-Encoding: identity\r\nConnection: {conn_hdr}\r\nx-opencodex-link-peer-version: {OCX_PROTOCOL_COMPAT_VERSION}\r\nx-opencodex-link-peer-features: {PEER_FEATURES}\r\n"
    );
    if probe_only {
        preflight.push_str(&format!("{LINK_RELAY_PROBE_HEADER}: 1\r\n"));
    }
    preflight.push_str("\r\n");
    writer
        .write_all(preflight.as_bytes())
        .and_then(|()| writer.flush())
        .map_err(|e| UpstreamError::HomeUnreachable(format!("preflight write failed: {e}")))?;

    let resp = read_response_head(&mut reader).map_err(|e| match e {
        FramingError::Eof => {
            UpstreamError::HomeUnreachable("tunnel closed during preflight".to_owned())
        }
        FramingError::HeadersTooLarge => UpstreamError::ResponseHeadersTooLarge,
        _ => UpstreamError::RelayAuthFailed("malformed preflight response".to_owned()),
    })?;
    if resp.status != 204 {
        return Err(UpstreamError::RelayAuthFailed(format!(
            "preflight returned status {}",
            resp.status
        )));
    }
    if let Some(cl) = resp.header("content-length")
        && cl.trim() != "0"
    {
        return Err(UpstreamError::RelayAuthFailed(
            "preflight 204 carried non-zero content-length".to_owned(),
        ));
    }
    if resp.header("transfer-encoding").is_some() {
        return Err(UpstreamError::RelayAuthFailed(
            "preflight 204 carried transfer-encoding".to_owned(),
        ));
    }
    if !relay_proof_matches(
        resp.header(LINK_RELAY_PROOF_HEADER),
        Some(&challenge.expected_listener_proof),
    ) {
        return Err(UpstreamError::RelayAuthFailed(
            "listener HMAC proof mismatch".to_owned(),
        ));
    }

    let mut verified_gen = None;
    if let (Some(gen_val), Some(gen_proof)) = (
        resp.header(LINK_RELAY_CONNECTION_HEADER),
        resp.header(LINK_RELAY_CONNECTION_PROOF_HEADER),
    ) && is_valid_connection_generation(gen_val)
    {
        let expected_conn = compute_connection_proof(
            &creds.token_fingerprint,
            &creds.api_key_id,
            &creds.link_id,
            &challenge.nonce,
            gen_val,
        );
        if relay_proof_matches(Some(gen_proof), expected_conn.as_deref()) {
            verified_gen = Some(gen_val.to_owned());
        }
    }

    Ok(AuthenticatedUpstream {
        reader,
        writer,
        nonce: challenge.nonce,
        connection_generation: verified_gen,
    })
}

pub fn fetch_home_authenticated(
    tunnel_port: u16,
    creds: &RelayCredentials,
    method: &str,
    target: &str,
    auth_kind: RelayAuthKind,
    body: Option<(&str, &[u8])>,
    max_bytes: u64,
) -> Result<(HttpResponseHead, Vec<u8>, Option<String>), UpstreamError> {
    let mut upstream = open_authenticated_upstream(tunnel_port, creds, false)?;
    let _ = upstream
        .writer
        .set_read_timeout(Some(Duration::from_secs(15)));
    let _ = upstream
        .writer
        .set_write_timeout(Some(Duration::from_secs(15)));
    let token_str = std::str::from_utf8(creds.raw_token.as_slice())
        .map_err(|_| UpstreamError::RelayAuthFailed("invalid utf8 token".to_owned()))?;
    let mut head = format!(
        "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:{tunnel_port}\r\nAccept-Encoding: identity\r\nConnection: close\r\n{LINK_RELAY_SESSION_HEADER}: {}\r\n",
        upstream.nonce
    );
    match auth_kind {
        RelayAuthKind::ApiKeyHeader => {
            head.push_str(&format!("x-opencodex-api-key: {token_str}\r\n"));
        }
        RelayAuthKind::Bearer => {
            head.push_str(&format!("Authorization: Bearer {token_str}\r\n"));
        }
    }
    if let Some((ct, payload)) = body {
        head.push_str(&format!(
            "Content-Type: {ct}\r\nContent-Length: {}\r\n",
            payload.len()
        ));
    }
    head.push_str("\r\n");
    upstream
        .writer
        .write_all(head.as_bytes())
        .map_err(|e| UpstreamError::HomeUnreachable(format!("request write failed: {e}")))?;
    if let Some((_, payload)) = body {
        upstream
            .writer
            .write_all(payload)
            .map_err(|e| UpstreamError::HomeUnreachable(format!("body write failed: {e}")))?;
    }
    upstream
        .writer
        .flush()
        .map_err(|e| UpstreamError::HomeUnreachable(format!("flush failed: {e}")))?;

    let resp_head = read_response_head(&mut upstream.reader).map_err(|e| match e {
        FramingError::HeadersTooLarge => UpstreamError::ResponseHeadersTooLarge,
        _ => UpstreamError::HomeUnreachable("failed reading Home response head".to_owned()),
    })?;
    let framing = response_framing(resp_head.status, method, &resp_head.headers)
        .map_err(|_| UpstreamError::BadUpstreamResponse("invalid response framing".to_owned()))?;
    let resp_body = read_bounded_body(&mut upstream.reader, framing, max_bytes).map_err(|e| {
        if e.to_string().contains("body_too_large") {
            UpstreamError::ResponseBodyTooLarge
        } else {
            UpstreamError::BadUpstreamResponse(format!("body read failed: {e}"))
        }
    })?;
    Ok((resp_head, resp_body, upstream.connection_generation))
}

pub fn post_child_parity_report(
    tunnel_port: u16,
    creds: &RelayCredentials,
    report: &LinkChildParityReport,
) -> Result<u16, String> {
    let json_bytes = report.to_bounded_json()?;
    let (head, _, _) = fetch_home_authenticated(
        tunnel_port,
        creds,
        "POST",
        "/v1/link-management/child-parity",
        RelayAuthKind::Bearer,
        Some(("application/json", &json_bytes)),
        1024,
    )
    .map_err(|e| format!("{e:?}"))?;
    Ok(head.status)
}

struct SharedServerState {
    paths: ChildPaths,
    listen_port: u16,
    started_instant: Instant,
    started_at_ms: u64,
    started_at_iso: String,
    stop_flag: AtomicBool,
    stop_cv: (Mutex<bool>, Condvar),
    last_generation: Mutex<Option<String>>,
}

impl SharedServerState {
    fn load_live_creds(&self) -> Result<(RelayCredentials, String), &'static str> {
        let state = match read_child_state(&self.paths.state_file) {
            StateReadOutcome::Valid(s) => s,
            _ => return Err("link_credential_unavailable"),
        };
        let raw_token = read_verified_link_key(&self.paths.key_file, &state.token_fingerprint)
            .map_err(|_| "link_credential_unavailable")?;
        Ok((
            RelayCredentials {
                api_key_id: state.api_key_id,
                link_id: state.link_id,
                token_fingerprint: state.token_fingerprint,
                raw_token,
            },
            state.shutdown_secret,
        ))
    }

    fn signal_shutdown(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.stop_cv.0.lock() {
            *guard = true;
            self.stop_cv.1.notify_all();
        }
        // Wake blocking TcpListener::accept()
        let _ = TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], self.listen_port)),
            Duration::from_millis(100),
        );
    }
}

pub fn serve_foreground(paths: ChildPaths, listen_port: u16) -> Result<(), String> {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], listen_port)))
        .map_err(|e| format!("failed to bind 127.0.0.1:{listen_port}: {e}"))?;
    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();
    let started_at_ms = now_epoch_ms();
    let shared = Arc::new(SharedServerState {
        paths,
        listen_port: actual_port,
        started_instant: Instant::now(),
        started_at_ms,
        started_at_iso: format_iso8601_utc(started_at_ms),
        stop_flag: AtomicBool::new(false),
        stop_cv: (Mutex::new(false), Condvar::new()),
        last_generation: Mutex::new(None),
    });

    let parity_shared = Arc::clone(&shared);
    let parity_handle = thread::spawn(move || run_parity_loop(parity_shared));
    let sem = Arc::new((Mutex::new(0usize), Condvar::new()));

    for incoming in listener.incoming() {
        if shared.stop_flag.load(Ordering::SeqCst) {
            break;
        }
        let Ok(client_stream) = incoming else {
            continue;
        };
        if shared.stop_flag.load(Ordering::SeqCst) {
            break;
        }
        let sem_clone = Arc::clone(&sem);
        {
            let (lock, cv) = &*sem_clone;
            let mut active = lock.lock().unwrap_or_else(|e| e.into_inner());
            while *active >= MAX_CONCURRENT_WORKERS {
                active = cv.wait(active).unwrap_or_else(|e| e.into_inner());
            }
            *active += 1;
        }
        let worker_shared = Arc::clone(&shared);
        thread::spawn(move || {
            let _ = handle_client_connection(client_stream, &worker_shared);
            let (lock, cv) = &*sem_clone;
            let mut active = lock.lock().unwrap_or_else(|e| e.into_inner());
            *active = active.saturating_sub(1);
            cv.notify_one();
        });
    }

    shared.signal_shutdown();
    let _ = parity_handle.join();
    Ok(())
}

fn run_parity_loop(shared: Arc<SharedServerState>) {
    let backoffs_ms: [u64; 5] = [2_000, 5_000, 15_000, 30_000, 60_000];
    let mut failures = 0usize;
    let mut local_seq: u64 = 0;
    // Immediate initial attempt after short 250ms settle so Home sees parity quickly
    let mut wait_ms = 250u64;
    loop {
        {
            let (lock, cv) = &shared.stop_cv;
            let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            let (guard, _) = cv
                .wait_timeout(guard, Duration::from_millis(wait_ms))
                .unwrap_or_else(|e| e.into_inner());
            if *guard || shared.stop_flag.load(Ordering::SeqCst) {
                return;
            }
        }
        let StateReadOutcome::Valid(st) = read_child_state(&shared.paths.state_file) else {
            wait_ms = 5_000;
            continue;
        };
        let Ok((creds, _)) = shared.load_live_creds() else {
            wait_ms = 5_000;
            continue;
        };
        local_seq = local_seq.max(st.parity_sequence).saturating_add(1);
        let (last_apply_at, digest) = match &st.applied_settings {
            Some(rec) => (Some(rec.applied_at_ms), Some(rec.digest.clone())),
            None => (None, None),
        };
        let report = LinkChildParityReport {
            link_id: st.link_id,
            last_apply_at,
            runtime_started_at: shared.started_at_ms,
            applied_codex_settings_digest: digest,
            sequence: local_seq,
        };
        match post_child_parity_report(st.tunnel_port, &creds, &report) {
            Ok(204) => {
                failures = 0;
                wait_ms = 60_000;
            }
            Ok(404) => return, // Home does not support child-parity
            _ => {
                let idx = failures.min(backoffs_ms.len() - 1);
                wait_ms = backoffs_ms[idx];
                failures += 1;
            }
        }
    }
}

fn handle_client_connection(stream: TcpStream, shared: &SharedServerState) -> std::io::Result<()> {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(HEADER_AND_SSE_TIMEOUT));
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);

    let req = match read_request_head(&mut reader) {
        Ok(r) => r,
        Err(FramingError::Eof) => return Ok(()),
        Err(FramingError::HeadersTooLarge) => {
            return write_json_response(
                &mut writer,
                431,
                "Request Header Fields Too Large",
                &[],
                br#"{"error":"link relay request headers too large"}"#,
            );
        }
        Err(_) => {
            return write_json_response(
                &mut writer,
                400,
                "Bad Request",
                &[],
                br#"{"error":"link relay request headers refused"}"#,
            );
        }
    };

    let decision = classify_child_ingress(
        &req.method,
        &req.path,
        &req.query,
        req.header("host"),
        req.header("origin"),
        req.header("upgrade"),
    );

    match decision {
        RouteDecision::LocalShutdown => {
            let supplied = req.header("x-ocx-child-shutdown").unwrap_or("");
            if let StateReadOutcome::Valid(st) = read_child_state(&shared.paths.state_file)
                && !st.shutdown_secret.is_empty()
                && constant_time_eq(supplied.as_bytes(), st.shutdown_secret.as_bytes())
            {
                let _ = write_json_response(&mut writer, 200, "OK", &[], br#"{"ok":true}"#);
                shared.signal_shutdown();
                return Ok(());
            }
            write_json_response(&mut writer, 404, "Not Found", &[], br#"{"error":"not_found"}"#)
        }
        RouteDecision::LocalHealthz => {
            let body = serde_json::to_vec(&serde_json::json!({
                "service": "opencodex",
                "version": OCX_PROTOCOL_COMPAT_VERSION,
                "role": "client",
                "ephemeralChild": true,
                "uptime": shared.started_instant.elapsed().as_secs_f64(),
                "pid": std::process::id(),
                "port": shared.listen_port,
                "startedAt": shared.started_at_iso,
            }))
            .unwrap_or_default();
            write_json_response(&mut writer, 200, "OK", &[], &body)
        }
        RouteDecision::LocalReadyz => handle_local_readyz(&mut writer, shared),
        RouteDecision::Reject403Origin => write_json_response(
            &mut writer,
            403,
            "Forbidden",
            &[],
            br#"{"error":{"message":"cross-origin data-plane request blocked","type":"invalid_request_error","code":"origin_rejected"}}"#, 
        ),
        RouteDecision::Reject426Websocket => write_json_response(
            &mut writer,
            426,
            "Upgrade Required",
            &[],
            br#"{"error":{"message":"Responses WebSocket transport is disabled; use HTTP","type":"invalid_request_error","code":"upgrade_required"}}"#, 
        ),
        RouteDecision::Reject404 => {
            write_json_response(&mut writer, 404, "Not Found", &[], br#"{"error":"not_found"}"#)
        }
        RouteDecision::RelayData { auth } => {
            relay_request(&mut reader, &mut writer, &req, shared, auth, LINK_RELAY_BODY_MAX_BYTES)
        }
        RouteDecision::RelayManagement => relay_request(
            &mut reader,
            &mut writer,
            &req,
            shared,
            RelayAuthKind::Bearer,
            HUB_RELAY_RESPONSE_BODY_MAX_BYTES,
        ),
    }
}

fn handle_local_readyz<W: Write>(
    writer: &mut W,
    shared: &SharedServerState,
) -> std::io::Result<()> {
    let uptime = shared.started_instant.elapsed().as_secs_f64();
    let pid = std::process::id();
    let port = shared.listen_port;
    let StateReadOutcome::Valid(st) = read_child_state(&shared.paths.state_file) else {
        let body = serde_json::to_vec(&serde_json::json!({
            "service": "opencodex",
            "version": OCX_PROTOCOL_COMPAT_VERSION,
            "role": "client",
            "status": "pending",
            "uptime": uptime,
            "pid": pid,
            "port": port,
            "protocolVersion": 1,
            "link": { "state": "unavailable", "reason": "link_credential_unavailable" }
        }))
        .unwrap_or_default();
        return write_json_response(
            writer,
            503,
            "Service Unavailable",
            &[("Retry-After", "1"), ("Cache-Control", "no-store")],
            &body,
        );
    };
    let Ok((creds, _)) = shared.load_live_creds() else {
        let body = serde_json::to_vec(&serde_json::json!({
            "service": "opencodex",
            "version": OCX_PROTOCOL_COMPAT_VERSION,
            "role": "client",
            "status": "pending",
            "uptime": uptime,
            "pid": pid,
            "port": port,
            "protocolVersion": 1,
            "link": { "state": "unavailable", "reason": "link_credential_unavailable" }
        }))
        .unwrap_or_default();
        return write_json_response(
            writer,
            503,
            "Service Unavailable",
            &[("Retry-After", "1"), ("Cache-Control", "no-store")],
            &body,
        );
    };
    match open_authenticated_upstream(st.tunnel_port, &creds, true) {
        Ok(up) => {
            if let Some(gen_val) = &up.connection_generation
                && let Ok(mut g) = shared.last_generation.lock()
            {
                *g = Some(gen_val.clone());
            }
            let gen_opt = up
                .connection_generation
                .or_else(|| shared.last_generation.lock().ok().and_then(|g| g.clone()));
            let link_obj = match gen_opt {
                Some(g) => serde_json::json!({ "state": "available", "connectionGeneration": g }),
                None => serde_json::json!({ "state": "available" }),
            };
            let body = serde_json::to_vec(&serde_json::json!({
                "service": "opencodex",
                "version": OCX_PROTOCOL_COMPAT_VERSION,
                "role": "client",
                "status": "ready",
                "uptime": uptime,
                "pid": pid,
                "port": port,
                "protocolVersion": 1,
                "link": link_obj,
            }))
            .unwrap_or_default();
            write_json_response(writer, 200, "OK", &[], &body)
        }
        Err(err) => {
            let reason = match err {
                UpstreamError::RelayAuthFailed(_) => "link_auth_failed",
                _ => "home_unreachable",
            };
            let body = serde_json::to_vec(&serde_json::json!({
                "service": "opencodex",
                "version": OCX_PROTOCOL_COMPAT_VERSION,
                "role": "client",
                "status": "pending",
                "uptime": uptime,
                "pid": pid,
                "port": port,
                "protocolVersion": 1,
                "link": { "state": "unavailable", "reason": reason }
            }))
            .unwrap_or_default();
            write_json_response(
                writer,
                503,
                "Service Unavailable",
                &[("Retry-After", "1"), ("Cache-Control", "no-store")],
                &body,
            )
        }
    }
}

fn relay_request(
    client_reader: &mut BufReader<TcpStream>,
    client_writer: &mut TcpStream,
    req: &HttpRequestHead,
    shared: &SharedServerState,
    auth_kind: RelayAuthKind,
    response_cap_bytes: u64,
) -> std::io::Result<()> {
    let validated = match validate_and_sanitize_request_headers(&req.headers) {
        Ok(v) => v,
        Err(FramingError::HeadersTooLarge) => {
            return write_json_response(
                client_writer,
                431,
                "Request Header Fields Too Large",
                &[],
                br#"{"error":"link relay request headers too large"}"#,
            );
        }
        Err(_) => {
            return write_json_response(
                client_writer,
                400,
                "Bad Request",
                &[],
                br#"{"error":"link relay request headers refused"}"#,
            );
        }
    };

    let req_body = if req.method == "GET" || req.method == "HEAD" {
        Vec::new()
    } else {
        let _ = client_reader
            .get_ref()
            .set_read_timeout(Some(HEADER_AND_SSE_TIMEOUT));
        match read_bounded_body(client_reader, validated.framing, LINK_RELAY_BODY_MAX_BYTES) {
            Ok(b) => b,
            Err(e) if e.to_string().contains("body_too_large") => {
                return write_json_response(
                    client_writer,
                    413,
                    "Payload Too Large",
                    &[],
                    br#"{"error":"link relay request body too large"}"#,
                );
            }
            Err(_) => {
                return write_json_response(
                    client_writer,
                    400,
                    "Bad Request",
                    &[],
                    br#"{"error":"invalid request body"}"#,
                );
            }
        }
    };

    let StateReadOutcome::Valid(st) = read_child_state(&shared.paths.state_file) else {
        return write_json_response(
            client_writer,
            503,
            "Service Unavailable",
            &[],
            br#"{"error":"link_credential_unavailable"}"#,
        );
    };
    let Ok((creds, _)) = shared.load_live_creds() else {
        return write_json_response(
            client_writer,
            503,
            "Service Unavailable",
            &[],
            br#"{"error":"link_credential_unavailable"}"#,
        );
    };

    let req_id = random_hex(16).unwrap_or_else(|_| "00000000000000000000000000000000".to_owned());
    let mut upstream = match open_authenticated_upstream(st.tunnel_port, &creds, false) {
        Ok(u) => u,
        Err(UpstreamError::RelayAuthFailed(_)) => {
            return write_json_response(
                client_writer,
                503,
                "Service Unavailable",
                &[
                    ("Retry-After", "1"),
                    ("x-opencodex-link-request-id", &req_id),
                ],
                br#"{"error":"link relay authentication failed","code":"link_relay_auth_failed"}"#,
            );
        }
        Err(_) => {
            return write_json_response(
                client_writer,
                503,
                "Service Unavailable",
                &[
                    ("Retry-After", "1"),
                    ("x-opencodex-link-request-id", &req_id),
                ],
                br#"{"error":"Home is unreachable over Remote Link","code":"home_unreachable","message":"Home is unreachable over Remote Link"}"#, 
            );
        }
    };

    if let Some(gen_val) = &upstream.connection_generation
        && let Ok(mut g) = shared.last_generation.lock()
    {
        *g = Some(gen_val.clone());
    }

    let _ = upstream
        .writer
        .set_read_timeout(Some(HEADER_AND_SSE_TIMEOUT));
    let _ = upstream
        .writer
        .set_write_timeout(Some(HEADER_AND_SSE_TIMEOUT));

    let Ok(token_str) = std::str::from_utf8(creds.raw_token.as_slice()) else {
        return write_json_response(
            client_writer,
            503,
            "Service Unavailable",
            &[],
            br#"{"error":"link_credential_unavailable"}"#,
        );
    };

    let mut out_head = format!(
        "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept-Encoding: identity\r\nConnection: close\r\n{LINK_RELAY_SESSION_HEADER}: {}\r\n",
        req.method, req.target, st.tunnel_port, upstream.nonce
    );
    match auth_kind {
        RelayAuthKind::ApiKeyHeader => {
            out_head.push_str(&format!("x-opencodex-api-key: {token_str}\r\n"));
        }
        RelayAuthKind::Bearer => {
            out_head.push_str(&format!("Authorization: Bearer {token_str}\r\n"));
        }
    }
    for (k, v) in &validated.sanitized {
        if k.eq_ignore_ascii_case("accept-encoding") {
            continue;
        }
        out_head.push_str(&format!("{k}: {v}\r\n"));
    }
    if req.method != "GET" && req.method != "HEAD" {
        out_head.push_str(&format!("Content-Length: {}\r\n", req_body.len()));
    }
    out_head.push_str("\r\n");

    if upstream.writer.write_all(out_head.as_bytes()).is_err()
        || (!req_body.is_empty() && upstream.writer.write_all(&req_body).is_err())
        || upstream.writer.flush().is_err()
    {
        return write_json_response(
            client_writer,
            503,
            "Service Unavailable",
            &[
                ("Retry-After", "1"),
                ("x-opencodex-link-request-id", &req_id),
            ],
            br#"{"error":"Home is unreachable over Remote Link","code":"home_unreachable","message":"Home is unreachable over Remote Link"}"#, 
        );
    }

    let resp_head = match read_response_head(&mut upstream.reader) {
        Ok(h) => h,
        Err(FramingError::HeadersTooLarge) => {
            return write_json_response(
                client_writer,
                502,
                "Bad Gateway",
                &[],
                br#"{"error":"link relay response headers too large"}"#,
            );
        }
        Err(_) => {
            return write_json_response(
                client_writer,
                503,
                "Service Unavailable",
                &[
                    ("Retry-After", "1"),
                    ("x-opencodex-link-request-id", &req_id),
                ],
                br#"{"error":"Home is unreachable over Remote Link","code":"home_unreachable","message":"Home is unreachable over Remote Link"}"#, 
            );
        }
    };

    let Ok(up_framing) = response_framing(resp_head.status, &req.method, &resp_head.headers) else {
        return write_json_response(
            client_writer,
            502,
            "Bad Gateway",
            &[],
            br#"{"error":"invalid upstream framing"}"#,
        );
    };

    let is_sse = is_sse_headers(&resp_head.headers);
    if !is_sse
        && let BodyFraming::ContentLength(len) = up_framing
        && len > response_cap_bytes
    {
        return write_json_response(
            client_writer,
            502,
            "Bad Gateway",
            &[],
            br#"{"error":"link relay response body too large"}"#,
        );
    }

    let sanitized_resp = sanitize_response_headers(&resp_head.headers);
    let reason = if resp_head.reason.is_empty() {
        "OK"
    } else {
        resp_head.reason.as_str()
    };

    if req.method == "HEAD"
        || (100..200).contains(&resp_head.status)
        || resp_head.status == 204
        || resp_head.status == 304
    {
        write!(client_writer, "HTTP/1.1 {} {reason}\r\n", resp_head.status)?;
        for (k, v) in &sanitized_resp {
            write!(client_writer, "{k}: {v}\r\n")?;
        }
        write!(client_writer, "Connection: close\r\n\r\n")?;
        return client_writer.flush();
    }

    write!(client_writer, "HTTP/1.1 {} {reason}\r\n", resp_head.status)?;
    for (k, v) in &sanitized_resp {
        write!(client_writer, "{k}: {v}\r\n")?;
    }
    write!(
        client_writer,
        "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    )?;
    client_writer.flush()?;

    let cap = if is_sse {
        None
    } else {
        Some(response_cap_bytes)
    };
    let _ = stream_upstream_to_chunked_client(&mut upstream.reader, client_writer, up_framing, cap);
    Ok(())
}
