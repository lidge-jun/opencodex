use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
use crate::journal::validate_existing_journal_paths;
use crate::parity::LinkChildParityReport;
use crate::platform::{
    FileLock, SecretBytes, constant_time_eq, format_iso8601_utc, now_epoch_ms, random_hex,
};
use crate::relay_auth::{
    LINK_RELAY_AUTH_PATH, LINK_RELAY_AUTH_VERSION, LINK_RELAY_CONNECTION_HEADER,
    LINK_RELAY_CONNECTION_PROOF_HEADER, LINK_RELAY_PROBE_HEADER, LINK_RELAY_PROOF_HEADER,
    LINK_RELAY_SESSION_HEADER, compute_child_shutdown_proof, compute_connection_proof,
    create_relay_challenge, is_valid_connection_generation, relay_proof_matches,
};
use crate::routes::{RelayAuthKind, RouteDecision, classify_child_ingress};
use crate::state::{ChildPaths, StateReadOutcome, read_child_state, read_verified_link_key};

const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
/// Whole-request bound for one-shot Home calls made by lifecycle commands.
const FETCH_DEADLINE: Duration = Duration::from_secs(60);
/// Whole-request bound for a parity report; per-read timeouts alone never end a trickle.
const PARITY_DEADLINE: Duration = Duration::from_secs(10);
const FETCH_READ_TIMEOUT: Duration = Duration::from_secs(15);
/// Per-read and per-write timeout for a control connection handled while every worker is busy.
const CONTROL_TIMEOUT: Duration = Duration::from_secs(1);
/// Deadline for every request head a control connection reads, so a sender that trickles
/// bytes inside `CONTROL_TIMEOUT` still releases its control slot.
const CONTROL_DEADLINE: Duration = Duration::from_secs(2);
/// Connect bound for a request that shutdown can cancel: a socket can be registered for
/// cancellation only once connected, so this bounds how long shutdown can wait on a connect.
const CANCELLABLE_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const HEADER_AND_SSE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_CONCURRENT_WORKERS: usize = 32;
const MAX_CONTROL_CONNECTIONS: usize = 256;
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

/// Upstream socket reader that enforces an optional whole-request deadline: each read is
/// bounded by the time left, so a peer trickling bytes cannot extend the request.
pub struct DeadlineStream {
    stream: TcpStream,
    deadline: Option<Instant>,
    per_read: Duration,
}

impl DeadlineStream {
    fn new(stream: TcpStream, deadline: Option<Instant>, per_read: Duration) -> Self {
        Self {
            stream,
            deadline,
            per_read,
        }
    }

    pub fn get_ref(&self) -> &TcpStream {
        &self.stream
    }
}

impl Read for DeadlineStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if let Some(deadline) = self.deadline {
            let now = Instant::now();
            if now >= deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "request deadline exceeded",
                ));
            }
            let wait = (deadline - now)
                .min(self.per_read)
                .max(Duration::from_millis(1));
            self.stream.set_read_timeout(Some(wait))?;
        }
        self.stream.read(buf)
    }
}

/// Holds the socket of an in-flight request so another thread can abort it. Registration
/// and cancellation share one mutex, so a request either sees the cancellation before it
/// registers or is registered when cancellation shuts its socket down.
#[derive(Default)]
pub struct CancelSlot {
    inner: Mutex<(bool, Option<TcpStream>)>,
}

impl CancelSlot {
    fn register(&self, stream: &TcpStream) -> Result<(), UpstreamError> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.0 {
            return Err(UpstreamError::HomeUnreachable(
                "request cancelled by shutdown".to_owned(),
            ));
        }
        guard.1 =
            Some(stream.try_clone().map_err(|e| {
                UpstreamError::HomeUnreachable(format!("socket clone failed: {e}"))
            })?);
        Ok(())
    }

    fn is_cancelled(&self) -> bool {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).0
    }

    fn clear(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).1 = None;
    }

    /// Abort the registered request, if any, and refuse every later registration.
    pub fn cancel(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.0 = true;
        if let Some(stream) = guard.1.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

/// Bounds for one upstream request.
#[derive(Clone, Copy)]
pub struct RequestLimits<'a> {
    pub deadline: Option<Instant>,
    pub cancel: Option<&'a CancelSlot>,
}

impl RequestLimits<'_> {
    fn remaining(&self, cap: Duration) -> Result<Duration, UpstreamError> {
        if self.cancel.is_some_and(CancelSlot::is_cancelled) {
            return Err(UpstreamError::HomeUnreachable(
                "request cancelled by shutdown".to_owned(),
            ));
        }
        match self.deadline {
            None => Ok(cap),
            Some(deadline) => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    Err(UpstreamError::HomeUnreachable(
                        "request deadline exceeded".to_owned(),
                    ))
                } else {
                    Ok(left.min(cap))
                }
            }
        }
    }
}

pub struct AuthenticatedUpstream {
    pub reader: BufReader<DeadlineStream>,
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
    open_authenticated_upstream_with(
        tunnel_port,
        creds,
        probe_only,
        RequestLimits {
            deadline: None,
            cancel: None,
        },
    )
}

fn open_authenticated_upstream_with(
    tunnel_port: u16,
    creds: &RelayCredentials,
    probe_only: bool,
    limits: RequestLimits<'_>,
) -> Result<AuthenticatedUpstream, UpstreamError> {
    let addr = SocketAddr::from(([127, 0, 0, 1], tunnel_port));
    let connect_cap = if limits.cancel.is_some() {
        CANCELLABLE_CONNECT_TIMEOUT
    } else {
        AUTH_TIMEOUT
    };
    let stream = TcpStream::connect_timeout(&addr, limits.remaining(connect_cap)?)
        .map_err(|e| UpstreamError::HomeUnreachable(format!("tunnel connect failed: {e}")))?;
    if let Some(cancel) = limits.cancel {
        cancel.register(&stream)?;
    }
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(AUTH_TIMEOUT));
    let _ = stream.set_write_timeout(Some(limits.remaining(AUTH_TIMEOUT)?));
    let mut writer = stream
        .try_clone()
        .map_err(|e| UpstreamError::HomeUnreachable(format!("socket clone failed: {e}")))?;
    let mut reader = BufReader::new(DeadlineStream::new(stream, limits.deadline, AUTH_TIMEOUT));

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

/// Request head carrying the link token, built in one allocation of its final size so no
/// partial copy is left behind, and wiped on drop.
fn token_request_head(
    before: &str,
    auth_kind: RelayAuthKind,
    token: &[u8],
    after: &str,
) -> SecretBytes {
    let name: &[u8] = match auth_kind {
        RelayAuthKind::ApiKeyHeader => b"x-opencodex-api-key: ",
        RelayAuthKind::Bearer => b"Authorization: Bearer ",
    };
    let mut head = Vec::with_capacity(before.len() + name.len() + token.len() + 2 + after.len());
    head.extend_from_slice(before.as_bytes());
    head.extend_from_slice(name);
    head.extend_from_slice(token);
    head.extend_from_slice(b"\r\n");
    head.extend_from_slice(after.as_bytes());
    SecretBytes::new(head)
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
    let limits = RequestLimits {
        deadline: Some(Instant::now() + FETCH_DEADLINE),
        cancel: None,
    };
    fetch_home_with_limits(
        tunnel_port,
        creds,
        method,
        target,
        auth_kind,
        body,
        max_bytes,
        limits,
    )
}

#[allow(clippy::too_many_arguments)]
fn fetch_home_with_limits(
    tunnel_port: u16,
    creds: &RelayCredentials,
    method: &str,
    target: &str,
    auth_kind: RelayAuthKind,
    body: Option<(&str, &[u8])>,
    max_bytes: u64,
    limits: RequestLimits<'_>,
) -> Result<(HttpResponseHead, Vec<u8>, Option<String>), UpstreamError> {
    let result = fetch_home_inner(
        tunnel_port,
        creds,
        method,
        target,
        auth_kind,
        body,
        max_bytes,
        limits,
    );
    if let Some(cancel) = limits.cancel {
        cancel.clear();
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn fetch_home_inner(
    tunnel_port: u16,
    creds: &RelayCredentials,
    method: &str,
    target: &str,
    auth_kind: RelayAuthKind,
    body: Option<(&str, &[u8])>,
    max_bytes: u64,
    limits: RequestLimits<'_>,
) -> Result<(HttpResponseHead, Vec<u8>, Option<String>), UpstreamError> {
    let mut upstream = open_authenticated_upstream_with(tunnel_port, creds, false, limits)?;
    upstream.reader.get_mut().per_read = FETCH_READ_TIMEOUT;
    let _ = upstream
        .writer
        .set_write_timeout(Some(limits.remaining(FETCH_READ_TIMEOUT)?));
    std::str::from_utf8(creds.raw_token.as_slice())
        .map_err(|_| UpstreamError::RelayAuthFailed("invalid utf8 token".to_owned()))?;
    let before = format!(
        "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:{tunnel_port}\r\nAccept-Encoding: identity\r\nConnection: close\r\n{LINK_RELAY_SESSION_HEADER}: {}\r\n",
        upstream.nonce
    );
    let mut after = String::new();
    if let Some((ct, payload)) = body {
        after.push_str(&format!(
            "Content-Type: {ct}\r\nContent-Length: {}\r\n",
            payload.len()
        ));
    }
    after.push_str("\r\n");
    let head = token_request_head(&before, auth_kind, creds.raw_token.as_slice(), &after);
    upstream
        .writer
        .write_all(head.as_slice())
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
    post_parity_with(tunnel_port, creds, report, None)
}

fn post_parity_with(
    tunnel_port: u16,
    creds: &RelayCredentials,
    report: &LinkChildParityReport,
    cancel: Option<&CancelSlot>,
) -> Result<u16, String> {
    let json_bytes = report.to_bounded_json()?;
    let limits = RequestLimits {
        deadline: Some(Instant::now() + PARITY_DEADLINE),
        cancel,
    };
    let (head, _, _) = fetch_home_with_limits(
        tunnel_port,
        creds,
        "POST",
        "/v1/link-management/child-parity",
        RelayAuthKind::Bearer,
        Some(("application/json", &json_bytes)),
        1024,
        limits,
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
    /// False until the lifecycle parent commits this generation; only `/healthz` is
    /// answered before that.
    committed: Arc<AtomicBool>,
    /// In-flight parity request, aborted by shutdown so the parity thread ends promptly.
    parity_cancel: CancelSlot,
}

impl SharedServerState {
    fn load_live_creds(&self) -> Result<RelayCredentials, &'static str> {
        let state = match read_child_state(&self.paths.state_file) {
            StateReadOutcome::Valid(s) => s,
            _ => return Err("link_credential_unavailable"),
        };
        let raw_token = read_verified_link_key(&self.paths.key_file, &state.token_fingerprint)
            .map_err(|_| "link_credential_unavailable")?;
        Ok(RelayCredentials {
            api_key_id: state.api_key_id,
            link_id: state.link_id,
            token_fingerprint: state.token_fingerprint,
            raw_token,
        })
    }

    fn signal_shutdown(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        self.parity_cancel.cancel();
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

/// Watch stdin for the parent's commit line. Before the commit, EOF, a read error, or any
/// other line means the parent died or abandoned this generation: exit without serving.
pub fn spawn_commit_watcher(generation: String) -> Arc<AtomicBool> {
    let committed = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&committed);
    thread::spawn(move || {
        let expected = format!("commit {generation}\n");
        let mut line = Vec::with_capacity(expected.len());
        let read = std::io::stdin()
            .lock()
            .take(expected.len() as u64 + 1)
            .read_until(b'\n', &mut line);
        if read.is_ok() && line == expected.as_bytes() {
            flag.store(true, Ordering::SeqCst);
            return;
        }
        std::process::exit(3);
    });
    committed
}

/// Serve a direct foreground relay started by the operator (no lifecycle parent).
pub fn serve_foreground(paths: ChildPaths, listen_port: u16) -> Result<(), String> {
    serve_foreground_inner(paths, listen_port, None)
}

/// Serve a relay started by a lifecycle parent: refuse unless state still records
/// `generation`, and answer only `/healthz` until `committed` is set.
pub fn serve_foreground_lifecycle(
    paths: ChildPaths,
    listen_port: u16,
    generation: &str,
    committed: Arc<AtomicBool>,
) -> Result<(), String> {
    serve_foreground_inner(paths, listen_port, Some((generation, committed)))
}

fn serve_foreground_inner(
    paths: ChildPaths,
    listen_port: u16,
    lifecycle: Option<(&str, Arc<AtomicBool>)>,
) -> Result<(), String> {
    let startup_gate = FileLock::acquire_blocking(&paths.child_dir.join("daemon-start.lock"))
        .map_err(|_| "serve refused: daemon startup gate unavailable".to_owned())?;
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], listen_port)))
        .map_err(|e| format!("failed to bind 127.0.0.1:{listen_port}: {e}"))?;
    let state = match read_child_state(&paths.state_file) {
        StateReadOutcome::Valid(state)
            if state.pending_operation.is_none() && state.listen_port == listen_port =>
        {
            state
        }
        _ => return Err("serve refused: child state changed during startup".to_owned()),
    };
    if let Some((generation, _)) = &lifecycle
        && state.daemon_generation.as_deref() != Some(*generation)
    {
        return Err("serve refused: this daemon generation is not the recorded one".to_owned());
    }
    let committed = match lifecycle {
        Some((_, committed)) => committed,
        None => Arc::new(AtomicBool::new(true)),
    };
    if !matches!(validate_existing_journal_paths(&paths), Ok(true))
        || read_verified_link_key(&paths.key_file, &state.token_fingerprint).is_err()
    {
        return Err("serve refused: child recovery state changed during startup".to_owned());
    }
    drop(startup_gate);
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
        committed,
        parity_cancel: CancelSlot::default(),
    });

    let parity_shared = Arc::clone(&shared);
    let parity_handle = thread::spawn(move || run_parity_loop(parity_shared));
    let sem = Arc::new((Mutex::new(0usize), Condvar::new()));
    let control_active = Arc::new(AtomicUsize::new(0));

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
        let admitted = {
            let (lock, _) = &*sem_clone;
            let mut active = lock.lock().unwrap_or_else(|e| e.into_inner());
            if *active < MAX_CONCURRENT_WORKERS {
                *active += 1;
                true
            } else {
                false
            }
        };
        if !admitted {
            // Every worker is busy. Health checks and the authenticated shutdown still get a
            // short-lived control thread, so a full worker pool cannot keep the shutdown
            // connection from being handled. A control connection holds its slot for at most
            // `CONTROL_DEADLINE` per request head; past `MAX_CONTROL_CONNECTIONS` concurrent
            // ones, a new connection is closed unanswered.
            if control_active.fetch_add(1, Ordering::SeqCst) >= MAX_CONTROL_CONNECTIONS {
                control_active.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let control_shared = Arc::clone(&shared);
            let control_count = Arc::clone(&control_active);
            thread::spawn(move || {
                let _ = handle_client_connection(
                    client_stream,
                    &control_shared,
                    ConnectionMode::ControlOnly,
                );
                control_count.fetch_sub(1, Ordering::SeqCst);
            });
            continue;
        }
        let worker_shared = Arc::clone(&shared);
        thread::spawn(move || {
            let _ = handle_client_connection(client_stream, &worker_shared, ConnectionMode::Full);
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
        if !shared.committed.load(Ordering::SeqCst) {
            wait_ms = 50;
            continue;
        }
        let StateReadOutcome::Valid(st) = read_child_state(&shared.paths.state_file) else {
            wait_ms = 5_000;
            continue;
        };
        let Ok(creds) = shared.load_live_creds() else {
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
        match post_parity_with(st.tunnel_port, &creds, &report, Some(&shared.parity_cancel)) {
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConnectionMode {
    Full,
    /// Accepted while every worker is busy, with short timeouts and a request-head deadline:
    /// `/healthz` and the authenticated shutdown only.
    ControlOnly,
}

fn handle_client_connection(
    stream: TcpStream,
    shared: &SharedServerState,
    mode: ConnectionMode,
) -> std::io::Result<()> {
    let _ = stream.set_nodelay(true);
    let head_deadline = if mode == ConnectionMode::ControlOnly {
        let _ = stream.set_read_timeout(Some(CONTROL_TIMEOUT));
        let _ = stream.set_write_timeout(Some(CONTROL_TIMEOUT));
        // One deadline covers the whole control exchange, including the shutdown proof frame.
        Some(Instant::now() + CONTROL_DEADLINE)
    } else {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let _ = stream.set_write_timeout(Some(HEADER_AND_SSE_TIMEOUT));
        None
    };
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(DeadlineStream::new(stream, head_deadline, CONTROL_TIMEOUT));

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
    let committed = shared.committed.load(Ordering::SeqCst);
    if mode == ConnectionMode::ControlOnly
        && !matches!(
            decision,
            RouteDecision::LocalHealthz | RouteDecision::LocalShutdown
        )
    {
        return write_json_response(
            &mut writer,
            503,
            "Service Unavailable",
            &[("Retry-After", "1"), ("Cache-Control", "no-store")],
            br#"{"error":"child_busy"}"#,
        );
    }
    if !committed && decision != RouteDecision::LocalHealthz {
        return write_json_response(
            &mut writer,
            503,
            "Service Unavailable",
            &[("Retry-After", "1"), ("Cache-Control", "no-store")],
            br#"{"error":"child_starting"}"#,
        );
    }

    match decision {
        RouteDecision::LocalShutdown => {
            let valid_frame = |frame: &HttpRequestHead| {
                frame.method == "POST"
                    && frame.path == "/__ocx_child/shutdown"
                    && frame.query.is_empty()
                    && frame.header("origin").is_none()
                    && frame.header("upgrade").is_none()
                    && frame.headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("host")).count() == 1
                    && frame.header("host") == Some(format!("127.0.0.1:{}", shared.listen_port).as_str())
                    && validate_and_sanitize_request_headers(&frame.headers)
                        .is_ok_and(|h| h.framing == BodyFraming::ContentLength(0))
            };
            let challenge_count = req.headers.iter()
                .filter(|(k, _)| k.eq_ignore_ascii_case("x-ocx-child-shutdown-challenge"))
                .count();
            let Some(nonce) = req.header("x-ocx-child-shutdown-challenge") else {
                return write_json_response(&mut writer, 404, "Not Found", &[], br#"{"error":"not_found"}"#);
            };
            let StateReadOutcome::Valid(state) = read_child_state(&shared.paths.state_file) else {
                return write_json_response(&mut writer, 404, "Not Found", &[], br#"{"error":"not_found"}"#);
            };
            if !valid_frame(&req) || challenge_count != 1 || !crate::relay_auth::is_valid_hex64(nonce) {
                return write_json_response(&mut writer, 404, "Not Found", &[], br#"{"error":"not_found"}"#);
            }
            let Ok(server_nonce) = random_hex(32) else {
                return write_json_response(&mut writer, 503, "Service Unavailable", &[], br#"{"error":"unavailable"}"#);
            };
            let binding = format!("{nonce}{server_nonce}");
            let Some(listener_proof) = compute_child_shutdown_proof(&state.shutdown_secret, "listener", &binding) else {
                return write_json_response(&mut writer, 404, "Not Found", &[], br#"{"error":"not_found"}"#);
            };
            let Some(caller_proof) = compute_child_shutdown_proof(&state.shutdown_secret, "caller", &binding) else {
                return Ok(());
            };
            write!(
                writer,
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nx-ocx-child-shutdown-nonce: {server_nonce}\r\nx-ocx-child-shutdown-proof: {listener_proof}\r\nConnection: keep-alive\r\n\r\n"
            )?;
            writer.flush()?;
            let Ok(next) = read_request_head(&mut reader) else { return Ok(()) };
            let proof_count = next.headers.iter()
                .filter(|(k, _)| k.eq_ignore_ascii_case("x-ocx-child-shutdown-proof"))
                .count();
            let still_current = match read_child_state(&shared.paths.state_file) {
                StateReadOutcome::Valid(current) => constant_time_eq(
                    current.shutdown_secret.as_bytes(),
                    state.shutdown_secret.as_bytes(),
                ),
                _ => false,
            };
            if valid_frame(&next)
                && proof_count == 1
                && still_current
                && next.header("x-ocx-child-shutdown-proof")
                    .is_some_and(|proof| constant_time_eq(proof.as_bytes(), caller_proof.as_bytes()))
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
                "generationCommitted": committed,
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
    let Ok(creds) = shared.load_live_creds() else {
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
            let link_obj = match up.connection_generation {
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
    client_reader: &mut BufReader<DeadlineStream>,
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
    let Ok(creds) = shared.load_live_creds() else {
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

    if std::str::from_utf8(creds.raw_token.as_slice()).is_err() {
        return write_json_response(
            client_writer,
            503,
            "Service Unavailable",
            &[],
            br#"{"error":"link_credential_unavailable"}"#,
        );
    }

    let before = format!(
        "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept-Encoding: identity\r\nConnection: close\r\n{LINK_RELAY_SESSION_HEADER}: {}\r\n",
        req.method, req.target, st.tunnel_port, upstream.nonce
    );
    let mut after = String::new();
    for (k, v) in &validated.sanitized {
        if k.eq_ignore_ascii_case("accept-encoding") {
            continue;
        }
        after.push_str(&format!("{k}: {v}\r\n"));
    }
    if req.method != "GET" && req.method != "HEAD" {
        after.push_str(&format!("Content-Length: {}\r\n", req_body.len()));
    }
    after.push_str("\r\n");
    let out_head = token_request_head(&before, auth_kind, creds.raw_token.as_slice(), &after);

    if upstream.writer.write_all(out_head.as_slice()).is_err()
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
