//! The Responses WebSocket over a Remote Link in ocx-child (design T4 3.2-3.3; what the gate-opening change
//! still owes: devlog/_plan/261113_link_websocket_gate_opening).
//!
//! Codex's upgrade on /v1/responses is tried only when ocx-child's release gate is open and the Home
//! advertised the feature on the last answer applied for the current link; otherwise today's 426 stays,
//! byte for byte, with no network I/O (relay.rs decides that before calling here). A tried upgrade:
//! no Origin; a valid Codex handshake; the caps (8 open or setting up, 4 setting up) and a 32 MiB
//! reservation from 256 MiB; one relay-auth preflight and the upgrade on one connection, inside one
//! 8 s deadline, proceeding only on that answer's own verified "on"; a complete 101 on that connection.
//! Every failure is today's 426. ocx-child has no tunnel supervisor, so there is no 503 of its own.
//!
//! After the upgrade each socket has two threads: the worker reads Codex and writes Codex's messages to
//! the Home; one spawned thread reads the Home and writes its messages to Codex. Every frame write is one
//! operation under that socket's write lock with an absolute deadline (data 600 s, control 30 s) that a
//! single reaper thread enforces by shutting both sockets down; the per-call write timeout is 300 s of no
//! progress. One idempotent terminal transition closes both legs with a 5 s bound. A stop aborts setups,
//! closes every socket with 1001 (best effort) and shuts everything down within 5 s.

use std::collections::HashMap;
use std::io::{BufReader, Cursor, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

use crate::http_wire::{
    CALLER_CREDENTIAL_HEADERS, HOP_BY_HOP_HEADERS, HttpRequestHead, HttpResponseHead,
    read_response_head, write_json_response,
};
use crate::link_ws_frame::{
    FrameEvent, FrameReader, Role, close_payload, control_frame, frame_header, is_wire_close_code,
    mask_in_place,
};
use crate::platform::fill_random_bytes;
use crate::relay::{
    CancelSlot, DeadlineStream, RelayCredentials, RequestLimits, open_link_ws_upstream,
    token_request_head, write_all_before,
};
use crate::relay_auth::LINK_RELAY_SESSION_HEADER;
use crate::routes::RelayAuthKind;

const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;

/// Every cap, budget and timeout, in one place (the TypeScript Child's link-websocket-limits.ts).
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub setup: Duration,
    pub open_sockets: usize,
    pub setting_up: usize,
    pub socket_reservation: usize,
    pub memory_budget: usize,
    pub home_message: usize,
    pub local_message: usize,
    pub max_fragments: usize,
    pub close_bound: Duration,
    pub stall: Duration,
    pub data_operation: Duration,
    pub control_operation: Duration,
}

pub const LIMITS: Limits = Limits {
    setup: Duration::from_secs(8),
    open_sockets: 8,
    setting_up: 4,
    socket_reservation: 32 * MIB,
    memory_budget: 256 * MIB,
    home_message: 4 * MIB + 64 * KIB,
    local_message: 8 * MIB,
    max_fragments: 4_096,
    close_bound: Duration::from_secs(5),
    stall: Duration::from_secs(300),
    data_operation: Duration::from_secs(600),
    control_operation: Duration::from_secs(30),
};

const SPAWNED_STACK: usize = 256 * KIB;
/// A stop gives each socket's close at most this long: `stop_owned_daemon` (detach, restart, sync) waits 3 s
/// for the port to close, so the link WebSocket's share of a stop must leave room for the rest of it.
const STOP_CLOSE_BOUND: Duration = Duration::from_secs(1);
const MAX_MESSAGE_HEADER: &str = "x-codex-websocket-max-message-bytes";
const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const UPGRADE_REQUIRED_BODY: &[u8] =
    br#"{"error":{"message":"Responses WebSocket transport is disabled; use HTTP","type":"invalid_request_error","code":"upgrade_required"}}"#;

/// Today's answer to Codex's upgrade, which codex-rs turns into HTTP for the session.
pub fn write_upgrade_required<W: Write>(w: &mut W) -> std::io::Result<()> {
    write_json_response(w, 426, "Upgrade Required", &[], UPGRADE_REQUIRED_BODY)
}

// ---------------------------------------------------------------------------------------------
// SHA-1, only for the Sec-WebSocket-Accept value of RFC 6455 (not a security primitive here).

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());
    for block in message.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

pub fn websocket_accept(key: &str) -> String {
    BASE64.encode(sha1(format!("{key}{WEBSOCKET_GUID}").as_bytes()))
}

// ---------------------------------------------------------------------------------------------
// Headers.

fn header_values<'a>(headers: &'a [(String, String)], name: &str) -> Vec<&'a str> {
    headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
        .collect()
}

fn single<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    let values = header_values(headers, name);
    if values.len() == 1 {
        Some(values[0])
    } else {
        None
    }
}

fn names_token(value: &str, token: &str) -> bool {
    value
        .split(',')
        .any(|t| t.trim().eq_ignore_ascii_case(token))
}

/// Codex's handshake: GET /v1/responses without a query, Upgrade websocket, Connection upgrade,
/// version 13 and a 16-byte key, no body framing. Returns the key.
pub fn codex_handshake_key(req: &HttpRequestHead) -> Option<String> {
    if req.method != "GET" || req.path != "/v1/responses" || !req.query.is_empty() {
        return None;
    }
    let h = &req.headers;
    if !single(h, "upgrade").is_some_and(|v| v.trim().eq_ignore_ascii_case("websocket")) {
        return None;
    }
    if !header_values(h, "connection")
        .iter()
        .any(|v| names_token(v, "upgrade"))
    {
        return None;
    }
    if single(h, "sec-websocket-version") != Some("13") {
        return None;
    }
    if !header_values(h, "content-length").is_empty()
        || !header_values(h, "transfer-encoding").is_empty()
    {
        return None;
    }
    let key = single(h, "sec-websocket-key")?.trim();
    match BASE64.decode(key) {
        Ok(bytes) if bytes.len() == 16 => Some(key.to_owned()),
        _ => None,
    }
}

const INTERNAL_HEADERS: &[&str] = &["x-opencodex-link-session", "x-opencodex-link-turn"];

/// Codex's headers for the Home leg: its handshake, the hop-by-hop set and every header Connection
/// nominates, Origin, Host, framing, caller credentials and the relay's internal headers dropped.
/// None when a value carries CR or LF or Host is repeated.
pub fn forward_upgrade_headers(headers: &[(String, String)]) -> Option<Vec<(String, String)>> {
    if header_values(headers, "host").len() > 1 {
        return None;
    }
    let nominated: Vec<String> = header_values(headers, "connection")
        .iter()
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    let mut out = Vec::new();
    for (name, value) in headers {
        if name.contains(['\r', '\n', ':']) || value.contains(['\r', '\n']) || name.is_empty() {
            return None;
        }
        let lower = name.to_ascii_lowercase();
        if HOP_BY_HOP_HEADERS.contains(&lower.as_str())
            || CALLER_CREDENTIAL_HEADERS.contains(&lower.as_str())
            || INTERNAL_HEADERS.contains(&lower.as_str())
            || nominated.contains(&lower)
            || lower.starts_with("sec-websocket-")
            || matches!(
                lower.as_str(),
                "origin" | "host" | "content-length" | "accept-encoding" | "proxy-connection"
            )
        {
            continue;
        }
        out.push((name.clone(), value.clone()));
    }
    Some(out)
}

/// A 101 that completes the Home-leg upgrade and nothing more.
pub fn valid_home_upgrade(resp: &HttpResponseHead, key: &str) -> bool {
    resp.status == 101
        && single(&resp.headers, "upgrade")
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("websocket"))
        && header_values(&resp.headers, "connection")
            .iter()
            .any(|v| names_token(v, "upgrade"))
        && single(&resp.headers, "sec-websocket-accept") == Some(websocket_accept(key).as_str())
        && header_values(&resp.headers, "sec-websocket-extensions").is_empty()
        && header_values(&resp.headers, "sec-websocket-protocol").is_empty()
}

// ---------------------------------------------------------------------------------------------
// Admission, registry and the reaper.

struct Registry {
    stopping: bool,
    open: usize,
    setting_up: usize,
    reserved: usize,
    next_id: u64,
    sockets: HashMap<u64, Arc<SocketShared>>,
    setups: HashMap<u64, Arc<CancelSlot>>,
}

fn registry() -> &'static (Mutex<Registry>, Condvar) {
    static REGISTRY: OnceLock<(Mutex<Registry>, Condvar)> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        (
            Mutex::new(Registry {
                stopping: false,
                open: 0,
                setting_up: 0,
                reserved: 0,
                next_id: 0,
                sockets: HashMap::new(),
                setups: HashMap::new(),
            }),
            Condvar::new(),
        )
    })
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A setup slot: released on drop unless it became an open socket's lease.
struct SetupSlot {
    id: u64,
    reservation: usize,
    converted: bool,
}

impl Drop for SetupSlot {
    fn drop(&mut self) {
        if self.converted {
            return;
        }
        let (m, cv) = registry();
        let mut r = lock(m);
        r.setting_up -= 1;
        r.reserved -= self.reservation;
        r.setups.remove(&self.id);
        cv.notify_all();
    }
}

/// An open socket's slot and reservation: released when the last owner of its shared part drops it.
struct Lease {
    id: u64,
    reservation: usize,
}

impl Drop for Lease {
    fn drop(&mut self) {
        let (m, cv) = registry();
        let mut r = lock(m);
        r.open -= 1;
        r.reserved -= self.reservation;
        r.sockets.remove(&self.id);
        cv.notify_all();
    }
}

fn admit(l: &Limits) -> Option<(SetupSlot, Arc<CancelSlot>)> {
    let (m, _) = registry();
    let mut r = lock(m);
    if r.stopping || r.open + r.setting_up >= l.open_sockets || r.setting_up >= l.setting_up {
        return None;
    }
    if r.reserved + l.socket_reservation > l.memory_budget {
        return None;
    }
    r.setting_up += 1;
    r.reserved += l.socket_reservation;
    r.next_id += 1;
    let id = r.next_id;
    let cancel = Arc::new(CancelSlot::default());
    r.setups.insert(id, Arc::clone(&cancel));
    Some((
        SetupSlot {
            id,
            reservation: l.socket_reservation,
            converted: false,
        },
        cancel,
    ))
}

struct Reaper {
    inner: Mutex<ReaperInner>,
    cv: Condvar,
}

struct ReaperInner {
    entries: Vec<(u64, Instant, Arc<SocketShared>)>,
    next: u64,
    exit: bool,
    started: bool,
}

static REAPER: OnceLock<Reaper> = OnceLock::new();
static REAPER_THREAD: Mutex<Option<thread::JoinHandle<()>>> = Mutex::new(None);

fn reaper() -> &'static Reaper {
    REAPER.get_or_init(|| Reaper {
        inner: Mutex::new(ReaperInner {
            entries: Vec::new(),
            next: 0,
            exit: false,
            started: false,
        }),
        cv: Condvar::new(),
    })
}

/// Start the reaper thread if it is not running; false when it cannot be created.
fn ensure_reaper() -> bool {
    let r = reaper();
    let mut inner = lock(&r.inner);
    if inner.started {
        return true;
    }
    inner.exit = false;
    let spawned = thread::Builder::new()
        .name("ocx-link-ws-reaper".into())
        .stack_size(SPAWNED_STACK)
        .spawn(reaper_loop);
    match spawned {
        Ok(handle) => {
            inner.started = true;
            *lock(&REAPER_THREAD) = Some(handle);
            true
        }
        Err(_) => false,
    }
}

fn reaper_loop() {
    let r = reaper();
    loop {
        let expired: Vec<Arc<SocketShared>> = {
            let mut inner = lock(&r.inner);
            loop {
                if inner.exit {
                    return;
                }
                let now = Instant::now();
                if inner.entries.iter().any(|(_, at, _)| *at <= now) {
                    break;
                }
                match inner.entries.iter().map(|(_, at, _)| *at).min() {
                    Some(next) => {
                        let (g, _) =
                            r.cv.wait_timeout(inner, next - now)
                                .unwrap_or_else(|e| e.into_inner());
                        inner = g;
                    }
                    None => inner = r.cv.wait(inner).unwrap_or_else(|e| e.into_inner()),
                }
            }
            let now = Instant::now();
            let mut fired = Vec::new();
            inner.entries.retain(|(_, at, s)| {
                if *at <= now {
                    fired.push(Arc::clone(s));
                    false
                } else {
                    true
                }
            });
            fired
        };
        // Outside the list lock: shut down, never taking a write lock.
        for shared in expired {
            shared.cut();
        }
    }
}

fn register_deadline(at: Instant, shared: &Arc<SocketShared>) -> u64 {
    let r = reaper();
    let mut inner = lock(&r.inner);
    inner.next += 1;
    let token = inner.next;
    inner.entries.push((token, at, Arc::clone(shared)));
    r.cv.notify_all();
    token
}

fn clear_deadline(token: u64) {
    let r = reaper();
    let mut inner = lock(&r.inner);
    inner.entries.retain(|(t, _, _)| *t != token);
    r.cv.notify_all();
}

/// Fire every remaining entry at once (serve shutdown).
fn reaper_drain() {
    let r = reaper();
    let fired: Vec<Arc<SocketShared>> = {
        let mut inner = lock(&r.inner);
        let all = inner.entries.drain(..).map(|(_, _, s)| s).collect();
        r.cv.notify_all();
        all
    };
    for shared in fired {
        shared.cut();
    }
}

fn reaper_exit_and_join() {
    {
        let r = reaper();
        let mut inner = lock(&r.inner);
        inner.exit = true;
        inner.started = false;
        r.cv.notify_all();
    }
    if let Some(handle) = lock(&REAPER_THREAD).take() {
        let _ = handle.join();
    }
}

// ---------------------------------------------------------------------------------------------
// One open socket.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lifecycle {
    Registered,
    Started,
    Aborted,
}

struct SockState {
    lifecycle: Lifecycle,
    terminal_started: bool,
    close_io: usize,
    cleanup_done: bool,
    close_token: Option<u64>,
    spawned_done: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Leg {
    Codex,
    Home,
}

/// What the terminal transition writes to one leg.
#[derive(Clone, Debug)]
enum CloseAction {
    /// A close frame with this code (and reason).
    Frame(u16, String),
    /// A close frame without a status code.
    Empty,
    /// No close frame: the connection ends at once.
    Cut,
    /// Nothing at all: the leg is not a WebSocket yet (before the local 101), its owner answers it.
    Leave,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Data,
    Control,
    Close,
}

pub(crate) struct SocketShared {
    codex: TcpStream,
    home: TcpStream,
    closing: AtomicBool,
    /// Set under Codex's write lock once the local 101 is written: no frame reaches Codex before it.
    upgraded: AtomicBool,
    codex_write: Mutex<()>,
    home_write: Mutex<()>,
    state: Mutex<SockState>,
    cv: Condvar,
    limits: Limits,
    _lease: Lease,
}

impl SocketShared {
    /// Shut both connections down (the reaper's action); ends every blocked read or write.
    fn cut(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let _ = self.codex.shutdown(Shutdown::Both);
        let _ = self.home.shutdown(Shutdown::Both);
    }
}

fn random_mask() -> [u8; 4] {
    let mut m = [0u8; 4];
    if fill_random_bytes(&mut m).is_err() {
        // A mask only has to be unpredictable to intermediaries; fall back to the clock.
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos())
            ^ 0x9e37_79b9;
        m = n.to_le_bytes();
    }
    m
}

/// One bounded frame write: the deadline is registered before the lock.
fn write_frame(
    shared: &Arc<SocketShared>,
    leg: Leg,
    opcode: u8,
    mut payload: Vec<u8>,
    kind: Kind,
) -> std::io::Result<()> {
    let bound = if kind == Kind::Data {
        shared.limits.data_operation
    } else {
        shared.limits.control_operation
    };
    let token = register_deadline(Instant::now() + bound, shared);
    let result = (|| {
        let (lock_m, mut stream) = match leg {
            Leg::Codex => (&shared.codex_write, &shared.codex),
            Leg::Home => (&shared.home_write, &shared.home),
        };
        let _guard = lock(lock_m);
        if leg == Leg::Codex && !shared.upgraded.load(Ordering::SeqCst) {
            // Before the local 101 Codex's connection is still HTTP; its owner answers it.
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "link websocket not upgraded",
            ));
        }
        if shared.closing.load(Ordering::SeqCst) && kind != Kind::Close {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "link websocket closing",
            ));
        }
        // Tests: the writer holds the lock and is past every early exit; its write starts now.
        #[cfg(test)]
        if kind == Kind::Data {
            tests::data_locked();
        }
        let mask = if leg == Leg::Home {
            Some(random_mask())
        } else {
            None
        };
        if opcode >= 8 {
            stream.write_all(&control_frame(opcode, &payload, mask))?;
        } else {
            stream.write_all(&frame_header(opcode, payload.len(), mask))?;
            if let Some(m) = mask {
                mask_in_place(&mut payload, m);
            }
            stream.write_all(&payload)?;
        }
        stream.flush()
    })();
    clear_deadline(token);
    result
}

fn close_bytes(action: &CloseAction) -> Option<Vec<u8>> {
    match action {
        CloseAction::Frame(code, reason) => Some(close_payload(Some(*code), reason)),
        CloseAction::Empty => Some(Vec::new()),
        CloseAction::Cut | CloseAction::Leave => None,
    }
}

/// The local 101: written under Codex's write lock inside a control
/// operation deadline, so a close frame can only follow it. Ok(false) when closing began first (a stop
/// between registration and the 101): nothing is written and the caller answers today's 426.
fn write_101(shared: &Arc<SocketShared>, reply: &[u8], fail: bool) -> std::io::Result<bool> {
    let token = register_deadline(Instant::now() + shared.limits.control_operation, shared);
    let result = (|| {
        let _guard = lock(&shared.codex_write);
        if shared.closing.load(Ordering::SeqCst) {
            return Ok(false);
        }
        if fail {
            return Err(std::io::Error::other("101 write refused by test"));
        }
        let mut stream = &shared.codex;
        stream.write_all(reply)?;
        stream.flush()?;
        shared.upgraded.store(true, Ordering::SeqCst);
        Ok(true)
    })();
    clear_deadline(token);
    result
}

/// The terminal transition. Idempotent; only the first caller writes close frames, and it claims its close
/// I/O and registers the close deadline in the same state-lock section that starts the transition.
fn terminate(shared: &Arc<SocketShared>, codex: CloseAction, home: CloseAction) {
    let claimed = {
        let mut st = lock(&shared.state);
        if st.lifecycle == Lifecycle::Registered {
            st.lifecycle = Lifecycle::Aborted;
            shared.cv.notify_all();
        }
        if st.terminal_started {
            false
        } else {
            st.terminal_started = true;
            shared.closing.store(true, Ordering::SeqCst);
            st.close_token = Some(register_deadline(
                Instant::now() + shared.limits.close_bound,
                shared,
            ));
            st.close_io += 1;
            true
        }
    };
    if !claimed {
        return;
    }
    #[cfg(test)]
    tests::after_claim();
    for (leg, action) in [(Leg::Codex, &codex), (Leg::Home, &home)] {
        match close_bytes(action) {
            Some(payload) => {
                let _ = write_frame(shared, leg, 8, payload, Kind::Close);
            }
            None if matches!(action, CloseAction::Leave) => {}
            None => {
                let stream = if leg == Leg::Codex {
                    &shared.codex
                } else {
                    &shared.home
                };
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
    }
    let mut st = lock(&shared.state);
    st.close_io -= 1;
    retire_if_done(&mut st);
}

fn retire_if_done(st: &mut SockState) {
    if st.cleanup_done
        && st.close_io == 0
        && let Some(token) = st.close_token.take()
    {
        clear_deadline(token);
    }
}

/// A close code relayed to the other leg: absent, 1005, 1006, 1015 and anything that may not appear on
/// the wire become 1011.
fn relay_code(code: Option<u16>) -> u16 {
    code.filter(|c| is_wire_close_code(*c)).unwrap_or(1011)
}

/// Reads one leg and writes its messages to the other leg until either ends.
fn pump<R: Read>(shared: &Arc<SocketShared>, from: Leg, mut source: R) {
    let (role, limit, to) = match from {
        Leg::Codex => (Role::FromClient, shared.limits.local_message, Leg::Home),
        Leg::Home => (Role::FromServer, shared.limits.home_message, Leg::Codex),
    };
    let mut reader = FrameReader::new(role, limit, shared.limits.max_fragments);
    let mut buf = vec![0u8; 8 * KIB];
    loop {
        let n = match source.read(&mut buf) {
            Ok(0) | Err(_) => {
                // The leg ended without a close frame.
                match from {
                    // Codex dropped: the Home connection ends without a close frame (the Home's 1006).
                    Leg::Codex => terminate(shared, CloseAction::Cut, CloseAction::Cut),
                    // The Home dropped (a tunnel drop, a killed Home): 1011 to Codex.
                    Leg::Home => terminate(
                        shared,
                        CloseAction::Frame(1011, "home connection ended".into()),
                        CloseAction::Cut,
                    ),
                }
                return;
            }
            Ok(n) => n,
        };
        let mut events = Vec::new();
        let fault = reader.push(&buf[..n], &mut events).err();
        for event in events {
            match event {
                FrameEvent::Text(text) => {
                    #[cfg(test)]
                    tests::maybe_panic(from);
                    if write_frame(shared, to, 1, text.into_bytes(), Kind::Data).is_err() {
                        terminate(
                            shared,
                            CloseAction::Frame(1011, String::new()),
                            CloseAction::Frame(1001, String::new()),
                        );
                        return;
                    }
                }
                FrameEvent::Binary(_) => {
                    let reason = "binary messages are not relayed".to_owned();
                    terminate(
                        shared,
                        CloseAction::Frame(1003, reason),
                        CloseAction::Frame(1003, String::new()),
                    );
                    return;
                }
                FrameEvent::Ping(payload) => {
                    if write_frame(shared, from, 10, payload, Kind::Control).is_err() {
                        terminate(shared, CloseAction::Cut, CloseAction::Cut);
                        return;
                    }
                }
                FrameEvent::Pong(_) => {}
                FrameEvent::Close(code, reason) => {
                    match from {
                        // Codex closed: echo it to Codex and relay it to the Home (no status: an empty close).
                        Leg::Codex => {
                            let echo = match code {
                                Some(c) => CloseAction::Frame(c, String::new()),
                                None => CloseAction::Empty,
                            };
                            let to_home = match code {
                                Some(c) => CloseAction::Frame(relay_code(Some(c)), reason),
                                None => CloseAction::Empty,
                            };
                            terminate(shared, echo, to_home);
                        }
                        // The Home closed: echo it to the Home and relay it to Codex.
                        Leg::Home => {
                            let echo = match code {
                                Some(c) => CloseAction::Frame(c, String::new()),
                                None => CloseAction::Empty,
                            };
                            terminate(shared, CloseAction::Frame(relay_code(code), reason), echo);
                        }
                    }
                    return;
                }
            }
        }
        if let Some(fault) = fault {
            let code = fault.close_code();
            match from {
                Leg::Codex => terminate(
                    shared,
                    CloseAction::Frame(code, String::new()),
                    CloseAction::Frame(1011, String::new()),
                ),
                Leg::Home => terminate(
                    shared,
                    CloseAction::Frame(1011, "home message refused".into()),
                    CloseAction::Frame(code, String::new()),
                ),
            }
            return;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The upgrade.

/// Why an attempt fell back; kept for tests, never logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fallback {
    Origin,
    Handshake,
    Cap,
    Unavailable,
    Preflight,
    NotAdvertised,
    HomeRefused,
    Stopping,
}

/// Serve one upgrade relay.rs decided to try. `codex_reader` is the worker's reader: bytes it already
/// buffered after Codex's head are read before anything else.
pub(crate) fn serve(
    codex_reader: &mut BufReader<DeadlineStream>,
    codex_writer: &mut TcpStream,
    req: &HttpRequestHead,
    tunnel_port: u16,
    creds: RelayCredentials,
) -> std::io::Result<()> {
    match open(codex_reader, codex_writer, req, tunnel_port, creds, LIMITS) {
        Ok(()) => Ok(()),
        Err(_) => write_upgrade_required(codex_writer),
    }
}

fn open(
    codex_reader: &mut BufReader<DeadlineStream>,
    codex_writer: &mut TcpStream,
    req: &HttpRequestHead,
    tunnel_port: u16,
    creds: RelayCredentials,
    l: Limits,
) -> Result<(), Fallback> {
    if !header_values(&req.headers, "origin").is_empty() {
        return Err(Fallback::Origin);
    }
    let codex_key = codex_handshake_key(req).ok_or(Fallback::Handshake)?;
    let forwarded = forward_upgrade_headers(&req.headers).ok_or(Fallback::Handshake)?;
    let token_ok = std::str::from_utf8(creds.raw_token.as_slice()).is_ok();
    if !token_ok {
        return Err(Fallback::Unavailable);
    }
    let (mut slot, cancel) = admit(&l).ok_or(Fallback::Cap)?;
    if !ensure_reaper() {
        return Err(Fallback::Unavailable);
    }
    let deadline = Instant::now() + l.setup;
    let limits_for_setup = RequestLimits {
        deadline: Some(deadline),
        cancel: Some(&cancel),
    };
    let mut upstream = open_link_ws_upstream(tunnel_port, &creds, limits_for_setup)
        .map_err(|_| Fallback::Preflight)?;
    if !upstream.link_ws_on {
        return Err(Fallback::NotAdvertised);
    }
    let mut key_bytes = [0u8; 16];
    fill_random_bytes(&mut key_bytes).map_err(|_| Fallback::Unavailable)?;
    let home_key = BASE64.encode(key_bytes);
    let before = format!(
        "GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{tunnel_port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {home_key}\r\n{LINK_RELAY_SESSION_HEADER}: {}\r\n",
        upstream.nonce
    );
    let mut after = String::new();
    for (k, v) in &forwarded {
        after.push_str(&format!("{k}: {v}\r\n"));
    }
    after.push_str("\r\n");
    let head = token_request_head(
        &before,
        RelayAuthKind::Bearer,
        creds.raw_token.as_slice(),
        &after,
    );
    // Each write call gets only the time left before the setup deadline.
    write_all_before(
        &mut upstream.writer,
        head.as_slice(),
        deadline,
        l.setup,
        &Instant::now,
    )
    .map_err(|_| Fallback::Preflight)?;
    drop(head);
    let resp = read_response_head(&mut upstream.reader).map_err(|_| Fallback::HomeRefused)?;
    if !valid_home_upgrade(&resp, &home_key) {
        return Err(Fallback::HomeRefused);
    }
    let home_buffered = upstream.reader.buffer().to_vec();
    let home = upstream.writer;
    // Registration: refused once a stop began; the setup slot becomes this socket's lease.
    let (codex_clone, home_clone) = match (codex_writer.try_clone(), home.try_clone()) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return Err(Fallback::Unavailable),
    };
    let shared = {
        let (m, _) = registry();
        let mut r = lock(m);
        if r.stopping {
            let _ = home.shutdown(Shutdown::Both);
            return Err(Fallback::Stopping);
        }
        r.setting_up -= 1;
        r.open += 1;
        r.setups.remove(&slot.id);
        slot.converted = true;
        let shared = Arc::new(SocketShared {
            codex: codex_clone,
            home: home_clone,
            closing: AtomicBool::new(false),
            upgraded: AtomicBool::new(false),
            codex_write: Mutex::new(()),
            home_write: Mutex::new(()),
            state: Mutex::new(SockState {
                lifecycle: Lifecycle::Registered,
                terminal_started: false,
                close_io: 0,
                cleanup_done: false,
                close_token: None,
                spawned_done: false,
            }),
            cv: Condvar::new(),
            limits: l,
            _lease: Lease {
                id: slot.id,
                reservation: slot.reservation,
            },
        });
        r.sockets.insert(slot.id, Arc::clone(&shared));
        shared
    };
    // A panic from here on still unregisters the socket and frees its slot (every normal return calls finish).
    let _unwind = UnwindCleanup(Arc::clone(&shared));
    // Open-socket timeouts: no read timeout, 300 s of no write progress.
    for s in [&shared.codex, &shared.home] {
        let _ = s.set_read_timeout(None);
        let _ = s.set_write_timeout(Some(l.stall));
    }
    // The Home reader thread, created before the local 101; it waits for the start step.
    let home_reader = match home.try_clone() {
        Ok(h) => h,
        Err(_) => {
            terminate(&shared, CloseAction::Leave, CloseAction::Cut);
            finish(&shared, None);
            return Err(Fallback::Unavailable);
        }
    };
    let spawned_shared = Arc::clone(&shared);
    #[cfg(test)]
    let fail_spawn = tests::FAIL_SPAWN.swap(false, Ordering::SeqCst);
    #[cfg(not(test))]
    let fail_spawn = false;
    let spawned = if fail_spawn {
        Err(std::io::Error::other("spawn refused by test"))
    } else {
        thread::Builder::new()
            .name("ocx-link-ws-home".into())
            .stack_size(SPAWNED_STACK)
            .spawn(move || {
                let shared = spawned_shared;
                // Sets spawned_done however this thread ends, so the worker's finish never waits forever.
                let _done = SpawnedDone(Arc::clone(&shared));
                let started = {
                    let mut st = lock(&shared.state);
                    while st.lifecycle == Lifecycle::Registered {
                        st = shared.cv.wait(st).unwrap_or_else(|e| e.into_inner());
                    }
                    st.lifecycle == Lifecycle::Started
                };
                if started {
                    pump(
                        &shared,
                        Leg::Home,
                        Cursor::new(home_buffered).chain(home_reader),
                    );
                }
            })
    };
    let handle = match spawned {
        Ok(h) => h,
        Err(_) => {
            terminate(&shared, CloseAction::Leave, CloseAction::Cut);
            finish(&shared, None);
            return Err(Fallback::Unavailable);
        }
    };
    // The local 101, with the message limit Codex reads (x-codex-websocket-max-message-bytes).
    let accept = websocket_accept(&codex_key);
    let reply = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n{MAX_MESSAGE_HEADER}: {}\r\n\r\n",
        l.local_message
    );
    #[cfg(test)]
    let fail_101 = tests::FAIL_101.swap(false, Ordering::SeqCst);
    #[cfg(not(test))]
    let fail_101 = false;
    #[cfg(test)]
    tests::before_101();
    match write_101(&shared, reply.as_bytes(), fail_101) {
        Ok(true) => {}
        Ok(false) => {
            // A stop claimed this socket first: no 101, today's 426 from the caller.
            finish(&shared, Some(handle));
            return Err(Fallback::Stopping);
        }
        Err(_) => {
            terminate(&shared, CloseAction::Cut, CloseAction::Cut);
            finish(&shared, Some(handle));
            return Ok(());
        }
    }
    test_barrier("link-ws-before-start");
    #[cfg(test)]
    tests::before_start();
    // The start step: registry lock, then the socket's state lock.
    let started = {
        let (m, _) = registry();
        let r = lock(m);
        let mut st = lock(&shared.state);
        if !r.stopping && st.lifecycle == Lifecycle::Registered {
            st.lifecycle = Lifecycle::Started;
            shared.cv.notify_all();
            true
        } else {
            false
        }
    };
    if !started {
        terminate(
            &shared,
            CloseAction::Frame(1001, "link websocket stopping".into()),
            CloseAction::Frame(1001, String::new()),
        );
        finish(&shared, Some(handle));
        return Ok(());
    }
    // The worker reads Codex; the bytes its reader already buffered come first.
    let _ = codex_reader.get_ref().get_ref().set_read_timeout(None);
    pump(&shared, Leg::Codex, &mut *codex_reader);
    finish(&shared, Some(handle));
    Ok(())
}

/// Runs the worker's cleanup if the worker unwinds after registration (a panic): both connections end, the
/// socket is unregistered, and its slot is freed once the spawned thread, which then reads EOF, has ended.
struct UnwindCleanup(Arc<SocketShared>);

impl Drop for UnwindCleanup {
    fn drop(&mut self) {
        if thread::panicking() {
            finish(&self.0, None);
        }
    }
}

/// The spawned Home reader's exit: on a panic both connections end first; spawned_done is always set.
struct SpawnedDone(Arc<SocketShared>);

impl Drop for SpawnedDone {
    fn drop(&mut self) {
        if thread::panicking() {
            terminate(&self.0, CloseAction::Cut, CloseAction::Cut);
        }
        let mut st = lock(&self.0.state);
        st.spawned_done = true;
        self.0.cv.notify_all();
    }
}

/// The worker's cleanup: the terminal transition (idempotent), wait for the spawned thread (the reaper's
/// close deadline guarantees it ends), join it, then mark cleanup done so the close entry can retire.
fn finish(shared: &Arc<SocketShared>, handle: Option<thread::JoinHandle<()>>) {
    terminate(shared, CloseAction::Cut, CloseAction::Cut);
    if handle.is_some() {
        let mut st = lock(&shared.state);
        while !st.spawned_done {
            st = shared.cv.wait(st).unwrap_or_else(|e| e.into_inner());
        }
    }
    if let Some(h) = handle {
        let _ = h.join();
    }
    {
        let mut st = lock(&shared.state);
        st.cleanup_done = true;
        retire_if_done(&mut st);
    }
    // Unregister: the registry's reference goes, so the lease drops with the last owner (a reaper close
    // entry still running keeps it until it fires).
    let (m, _) = registry();
    lock(m).sockets.remove(&shared._lease.id);
}

#[cfg(feature = "link-ws-test-gate")]
fn test_barrier(name: &str) {
    crate::test_hooks::barrier(name);
}

#[cfg(not(feature = "link-ws-test-gate"))]
fn test_barrier(_name: &str) {}

/// Serve shutdown: abort setups, close every socket (1001, best effort), wait until every slot is free,
/// then stop the reaper. Bounded by the close deadline: the reaper shuts down whatever is still open.
pub fn stop_all() {
    let (sockets, setups) = {
        let (m, _) = registry();
        let mut r = lock(m);
        r.stopping = true;
        (
            r.sockets.values().cloned().collect::<Vec<_>>(),
            r.setups.values().cloned().collect::<Vec<_>>(),
        )
    };
    for setup in &setups {
        setup.cancel();
    }
    // Every close deadline starts before any close frame is attempted, and is at most STOP_CLOSE_BOUND: a
    // peer that does not read cannot hold the stop past detach's wait.
    let mut claimed = Vec::new();
    for shared in &sockets {
        let mut st = lock(&shared.state);
        if st.lifecycle == Lifecycle::Registered {
            st.lifecycle = Lifecycle::Aborted;
            shared.cv.notify_all();
        }
        if !st.terminal_started {
            st.terminal_started = true;
            shared.closing.store(true, Ordering::SeqCst);
            st.close_token = Some(register_deadline(
                Instant::now() + shared.limits.close_bound.min(STOP_CLOSE_BOUND),
                shared,
            ));
            st.close_io += 1;
            claimed.push(Arc::clone(shared));
        }
    }
    drop(sockets);
    for shared in &claimed {
        let _ = write_frame(
            shared,
            Leg::Codex,
            8,
            close_payload(Some(1001), "link websocket stopping"),
            Kind::Close,
        );
        let _ = write_frame(
            shared,
            Leg::Home,
            8,
            close_payload(Some(1001), ""),
            Kind::Close,
        );
        let mut st = lock(&shared.state);
        st.close_io -= 1;
        retire_if_done(&mut st);
    }
    drop(claimed);
    // Fire whatever is left so no blocked writer outlives the stop, then wait for every slot.
    let started = lock(&reaper().inner).started;
    if started {
        let (m, cv) = registry();
        let mut r = lock(m);
        loop {
            if r.open == 0 && r.setting_up == 0 {
                break;
            }
            drop(r);
            reaper_drain();
            r = lock(m);
            if r.open == 0 && r.setting_up == 0 {
                break;
            }
            let (g, _) = cv
                .wait_timeout(r, Duration::from_millis(50))
                .unwrap_or_else(|e| e.into_inner());
            r = g;
        }
        drop(r);
        reaper_exit_and_join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_and_accept_follow_rfc_6455() {
        assert_eq!(
            websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
        let empty = sha1(b"");
        assert_eq!(
            crate::platform::hex_encode(&empty),
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
        let abc = sha1(b"abc");
        assert_eq!(
            crate::platform::hex_encode(&abc),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        let long = sha1(&vec![b'a'; 1_000_000]);
        assert_eq!(
            crate::platform::hex_encode(&long),
            "34aa973cd4c4daa4f61eeb2bdbad27316534016f"
        );
    }

    fn req(headers: &[(&str, &str)]) -> HttpRequestHead {
        HttpRequestHead {
            method: "GET".into(),
            target: "/v1/responses".into(),
            path: "/v1/responses".into(),
            query: String::new(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";

    #[test]
    fn codex_handshake_validation() {
        let good = req(&[
            ("Host", "127.0.0.1"),
            ("Upgrade", "websocket"),
            ("Connection", "keep-alive, Upgrade"),
            ("Sec-WebSocket-Version", "13"),
            ("Sec-WebSocket-Key", KEY),
        ]);
        assert_eq!(codex_handshake_key(&good).as_deref(), Some(KEY));
        let mut q = good.clone();
        q.query = "a=1".into();
        assert!(codex_handshake_key(&q).is_none());
        for drop in [
            "Upgrade",
            "Connection",
            "Sec-WebSocket-Version",
            "Sec-WebSocket-Key",
        ] {
            let mut r = good.clone();
            r.headers.retain(|(k, _)| k != drop);
            assert!(codex_handshake_key(&r).is_none(), "{drop}");
        }
        let mut dup = good.clone();
        dup.headers.push(("Sec-WebSocket-Key".into(), KEY.into()));
        assert!(codex_handshake_key(&dup).is_none());
        let mut body = good.clone();
        body.headers.push(("Content-Length".into(), "0".into()));
        assert!(codex_handshake_key(&body).is_none());
        let mut short = good.clone();
        short.headers.retain(|(k, _)| k != "Sec-WebSocket-Key");
        short
            .headers
            .push(("Sec-WebSocket-Key".into(), "c2hvcnQ=".into()));
        assert!(codex_handshake_key(&short).is_none());
    }

    #[test]
    fn forwarded_headers_drop_handshake_credentials_and_nominated() {
        let headers: Vec<(String, String)> = [
            ("Host", "127.0.0.1:10100"),
            ("Upgrade", "websocket"),
            ("Connection", "Upgrade, x-private"),
            ("x-private", "1"),
            ("Sec-WebSocket-Key", KEY),
            ("Sec-WebSocket-Version", "13"),
            ("Sec-WebSocket-Extensions", "permessage-deflate"),
            ("Origin", "http://127.0.0.1"),
            ("Authorization", "Bearer codex"),
            ("x-api-key", "k"),
            ("Cookie", "c"),
            ("x-opencodex-link-session", "n"),
            ("x-opencodex-link-turn", "t"),
            ("thread-id", "thread-1"),
            ("Keep-Alive", "5"),
            ("Accept-Encoding", "gzip"),
            ("OpenAI-Beta", "responses_websockets=2026"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let out = forward_upgrade_headers(&headers).unwrap();
        let names: Vec<&str> = out.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, vec!["thread-id", "OpenAI-Beta"]);
        let mut dup_host = headers.clone();
        dup_host.push(("Host".into(), "x".into()));
        assert!(forward_upgrade_headers(&dup_host).is_none());
        assert!(forward_upgrade_headers(&[("x".into(), "a\r\nb".into())]).is_none());
    }

    #[test]
    fn home_101_validation() {
        let ok = |extra: &[(&str, &str)], omit: &str| {
            let mut headers: Vec<(String, String)> = vec![
                ("Upgrade".into(), "websocket".into()),
                ("Connection".into(), "Upgrade".into()),
                ("Sec-WebSocket-Accept".into(), websocket_accept(KEY)),
            ];
            headers.retain(|(k, _)| k != omit);
            headers.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
            valid_home_upgrade(
                &HttpResponseHead {
                    status: 101,
                    reason: "Switching Protocols".into(),
                    headers,
                },
                KEY,
            )
        };
        assert!(ok(&[], ""));
        assert!(!ok(&[], "Upgrade"));
        assert!(!ok(&[], "Connection"));
        assert!(!ok(&[], "Sec-WebSocket-Accept"));
        assert!(!ok(
            &[("Sec-WebSocket-Extensions", "permessage-deflate")],
            ""
        ));
        assert!(!ok(&[("Sec-WebSocket-Protocol", "x")], ""));
        let wrong = HttpResponseHead {
            status: 101,
            reason: String::new(),
            headers: vec![
                ("Upgrade".into(), "websocket".into()),
                ("Connection".into(), "Upgrade".into()),
                ("Sec-WebSocket-Accept".into(), websocket_accept("other")),
            ],
        };
        assert!(!valid_home_upgrade(&wrong, KEY));
        let plain = HttpResponseHead {
            status: 200,
            reason: String::new(),
            headers: vec![],
        };
        assert!(!valid_home_upgrade(&plain, KEY));
    }

    #[test]
    fn relayed_close_codes() {
        assert_eq!(relay_code(Some(4401)), 4401);
        assert_eq!(relay_code(Some(1012)), 1012);
        assert_eq!(relay_code(None), 1011);
        assert_eq!(relay_code(Some(1006)), 1011);
    }

    /// A Home that takes one byte per write call while time passes.
    struct Trickle {
        clock: std::rc::Rc<std::cell::Cell<u64>>,
        timeouts: Vec<Duration>,
        written: usize,
    }

    impl Write for Trickle {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.clock.set(self.clock.get() + 1);
            self.written += 1;
            Ok(buf.len().min(1))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl crate::relay::TimedWrite for Trickle {
        fn set_write_timeout_left(&mut self, left: Duration) -> std::io::Result<()> {
            self.timeouts.push(left);
            Ok(())
        }
    }

    #[test]
    fn a_setup_write_ends_at_the_absolute_deadline_however_the_home_drains() {
        let base = Instant::now();
        let clock = std::rc::Rc::new(std::cell::Cell::new(0u64));
        let mut home = Trickle {
            clock: std::rc::Rc::clone(&clock),
            timeouts: Vec::new(),
            written: 0,
        };
        let now = || base + Duration::from_secs(clock.get());
        let err = crate::relay::write_all_before(
            &mut home,
            &[b'h'; 20],
            base + Duration::from_secs(8),
            Duration::from_secs(30),
            &now,
        )
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert_eq!(home.written, 8, "no write starts after the deadline");
        let expected: Vec<Duration> = (1..=8).rev().map(Duration::from_secs).collect();
        assert_eq!(
            home.timeouts, expected,
            "each write gets only the time left"
        );
        // The per-call cap still applies when the deadline is far away.
        clock.set(0);
        home.timeouts.clear();
        crate::relay::write_all_before(
            &mut home,
            b"ok",
            base + Duration::from_secs(600),
            Duration::from_secs(10),
            &now,
        )
        .unwrap();
        assert_eq!(home.timeouts, vec![Duration::from_secs(10); 2]);
    }

    // ---- relay tests: a mock Home and a Codex-shaped client on real loopback sockets, in process ----

    use crate::http_wire::read_request_head;
    use crate::link_ws_advert::ws_state_proof;
    use crate::platform::SecretBytes;
    use crate::relay_auth::{compute_relay_proof, token_fingerprint_hex};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::mpsc;

    // One lock with the advertisement tests: both update the process-wide advertisement table.
    use crate::link_ws_advert::TEST_LOCK as SERIAL;
    pub(super) static FAIL_SPAWN: AtomicBool = AtomicBool::new(false);
    pub(super) static FAIL_101: AtomicBool = AtomicBool::new(false);
    static BEFORE_START: Mutex<Option<fn()>> = Mutex::new(None);
    static BEFORE_101: Mutex<Option<fn()>> = Mutex::new(None);
    /// Armed by a test: the next claiming terminal caller reports here, then waits for the release.
    static CLAIM_GATE: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>> = Mutex::new(None);
    /// Armed by a test: the next data write reports here once it holds its leg's write lock and has passed its
    /// upgraded and closing checks, just before its bytes are written.
    static DATA_LOCKED: Mutex<Option<mpsc::Sender<()>>> = Mutex::new(None);

    pub(super) fn before_start() {
        let hook = *lock(&BEFORE_START);
        if let Some(f) = hook {
            f();
        }
    }

    pub(super) fn before_101() {
        let hook = *lock(&BEFORE_101);
        if let Some(f) = hook {
            f();
        }
    }

    /// The claim a stop makes on each registered socket (without the reaper drain that follows it in
    /// stop_all), run on the worker just before its local 101.
    fn stop_claims_before_the_101() {
        let (m, _) = registry();
        lock(m).stopping = true;
        let shared = only_socket();
        terminate(
            &shared,
            CloseAction::Frame(1001, "link websocket stopping".into()),
            CloseAction::Frame(1001, String::new()),
        );
    }

    #[test]
    fn a_stop_claim_before_the_local_101_leaves_it_unwritten_and_codex_gets_no_frame() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        *lock(&BEFORE_101) = Some(stop_claims_before_the_101);
        let s = session(home_port, test_limits(), "", &[]);
        *lock(&BEFORE_101) = None;
        // No frame precedes the 101: with only the claim, Codex's connection is intact and gets the 426.
        assert_eq!(
            s.status, 426,
            "Codex gets an HTTP answer, never a close frame first"
        );
        assert_eq!(s.worker.join().unwrap(), Err(Fallback::Stopping));
        let mut home = homes.recv().unwrap();
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![FrameEvent::Close(Some(1001), String::new())]
        );
        wait_all_released();
        reset_registry();
    }

    static REAL_STOP: Mutex<Option<thread::JoinHandle<()>>> = Mutex::new(None);

    /// The real stop_all, from another thread, once it has claimed this socket (before the worker's 101).
    fn real_stop_before_the_101() {
        let shared = only_socket();
        *lock(&REAL_STOP) = Some(thread::spawn(stop_all));
        let mut st = lock(&shared.state);
        while st.lifecycle == Lifecycle::Registered {
            st = shared.cv.wait(st).unwrap_or_else(|e| e.into_inner());
        }
    }

    #[test]
    fn a_real_stop_before_the_local_101_gives_codex_the_426_at_best_and_never_a_frame_or_a_hang() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, _homes) = mock_home(HomeMode::Advertise);
        *lock(&BEFORE_101) = Some(real_stop_before_the_101);
        let s = session(home_port, test_limits(), "", &[]);
        *lock(&BEFORE_101) = None;
        // The stop also shuts Codex's connection down, so the 426 is best effort: an HTTP 426 or nothing.
        assert!(
            s.status == 426 || (s.status == 0 && s.response.is_empty()),
            "status {} {}",
            s.status,
            s.response
        );
        assert_eq!(s.worker.join().unwrap(), Err(Fallback::Stopping));
        lock(&REAL_STOP).take().unwrap().join().unwrap();
        wait_all_released();
        reset_registry();
    }

    /// Armed by a test: the reader of this leg panics on its next text message.
    pub(super) static PANIC_IN: Mutex<Option<Leg>> = Mutex::new(None);

    pub(super) fn maybe_panic(leg: Leg) {
        let armed = {
            let mut slot = lock(&PANIC_IN);
            if *slot == Some(leg) {
                slot.take()
            } else {
                None
            }
        };
        if armed.is_some() {
            panic!("panic injected by a test");
        }
    }

    #[test]
    fn a_panic_in_the_worker_unregisters_the_socket_and_frees_its_slot() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let mut s = session(home_port, test_limits(), "", &[]);
        assert_eq!(s.status, 101);
        let mut home = homes.recv().unwrap();
        *lock(&PANIC_IN) = Some(Leg::Codex);
        s.codex.write_all(&client_frame(1, b"boom")).unwrap();
        assert!(s.worker.join().is_err(), "the worker panicked");
        assert!(
            lock(&registry().0).sockets.is_empty(),
            "the socket was unregistered on unwind"
        );
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![]
        );
        wait_all_released();
    }

    #[test]
    fn a_panic_in_the_home_reader_ends_the_socket_and_the_worker_returns() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let mut s = session(home_port, test_limits(), "", &[]);
        assert_eq!(s.status, 101);
        let mut home = homes.recv().unwrap();
        *lock(&PANIC_IN) = Some(Leg::Home);
        home.stream.write_all(&server_frame(1, b"boom")).unwrap();
        assert!(
            s.worker.join().unwrap().is_ok(),
            "the worker ended instead of waiting for the spawned thread"
        );
        assert_eq!(
            read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 1),
            vec![]
        );
        wait_all_released();
    }

    pub(super) fn after_claim() {
        let gate = lock(&CLAIM_GATE).take();
        if let Some((reached, release)) = gate {
            let _ = reached.send(());
            let _ = release.recv();
        }
    }

    pub(super) fn data_locked() {
        if let Some(tx) = lock(&DATA_LOCKED).take() {
            let _ = tx.send(());
        }
    }

    /// The one registered socket (tests run one session at a time).
    fn only_socket() -> Arc<SocketShared> {
        let (m, _) = registry();
        let r = lock(m);
        assert_eq!(r.sockets.len(), 1);
        r.sockets.values().next().cloned().unwrap()
    }

    fn reaper_holds(token: u64) -> bool {
        lock(&reaper().inner)
            .entries
            .iter()
            .any(|(t, _, _)| *t == token)
    }

    const TOKEN: &str = "ocx-link-ws-test-token-0123456789";
    const KEY_ID: &str = "ws-key";
    const LINK_ID: &str = "lnk_0123456789abcdef";

    fn reset_registry() {
        let (m, _) = registry();
        let mut r = lock(m);
        r.stopping = false;
    }

    fn wait_all_released() {
        let (m, cv) = registry();
        let mut r = lock(m);
        while r.open != 0 || r.setting_up != 0 {
            r = cv.wait(r).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn test_limits() -> Limits {
        Limits {
            setup: Duration::from_secs(3),
            close_bound: Duration::from_millis(300),
            ..LIMITS
        }
    }

    #[derive(Clone, Copy, PartialEq)]
    enum HomeMode {
        Advertise,
        Silent,
        Refuse,
        WrongAccept,
        Hold,
    }

    struct HomeSide {
        stream: TcpStream,
        request: HttpRequestHead,
        leftover: Vec<u8>,
    }

    /// A mock Home: relay-auth v2 on each connection, then an upgrade on the same connection.
    fn mock_home(mode: HomeMode) -> (u16, mpsc::Receiver<HomeSide>) {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(stream) = conn else { return };
                let tx = tx.clone();
                thread::spawn(move || home_connection(stream, mode, tx));
            }
        });
        (port, rx)
    }

    fn home_connection(stream: TcpStream, mode: HomeMode, tx: mpsc::Sender<HomeSide>) {
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
                .to_owned()
        };
        let nonce = param("nonce");
        if compute_relay_proof(&fp, "caller", KEY_ID, LINK_ID, &nonce).as_deref()
            != Some(param("proof").as_str())
        {
            let _ = writer.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            return;
        }
        let mut answer = format!(
            "HTTP/1.1 204 No Content\r\nx-opencodex-link-proof: {}\r\n",
            compute_relay_proof(&fp, "listener", KEY_ID, LINK_ID, &nonce).unwrap()
        );
        if mode != HomeMode::Silent {
            answer.push_str(&format!(
                "x-opencodex-link-ws-state: on\r\nx-opencodex-link-ws-proof: {}\r\n",
                ws_state_proof(&fp, KEY_ID, LINK_ID, &nonce).unwrap()
            ));
        }
        answer.push_str("\r\n");
        writer.write_all(answer.as_bytes()).unwrap();
        let Ok(up) = read_request_head(&mut reader) else {
            return;
        };
        let key = up
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("sec-websocket-key"))
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        match mode {
            HomeMode::Refuse => {
                let _ =
                    writer.write_all(b"HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n");
                return;
            }
            HomeMode::Hold => {
                let leftover = reader.buffer().to_vec();
                let _ = tx.send(HomeSide {
                    stream: writer,
                    request: up,
                    leftover,
                });
                return;
            }
            _ => {}
        }
        let accept = if mode == HomeMode::WrongAccept {
            websocket_accept("other")
        } else {
            websocket_accept(&key)
        };
        writer.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").as_bytes()).unwrap();
        let leftover = reader.buffer().to_vec();
        let _ = tx.send(HomeSide {
            stream: writer,
            request: up,
            leftover,
        });
    }

    fn creds() -> RelayCredentials {
        RelayCredentials {
            api_key_id: KEY_ID.into(),
            link_id: LINK_ID.into(),
            token_fingerprint: token_fingerprint_hex(TOKEN),
            raw_token: SecretBytes::new(TOKEN.as_bytes().to_vec()),
        }
    }

    /// Reads frames off a raw socket (either role) until `count` events arrived or the connection ended.
    fn read_events(
        stream: &mut TcpStream,
        role: Role,
        leftover: &[u8],
        count: usize,
    ) -> Vec<FrameEvent> {
        let mut reader = FrameReader::new(role, 16 * MIB, 4096);
        let mut events = Vec::new();
        let _ = reader.push(leftover, &mut events);
        let mut buf = vec![0u8; 64 * KIB];
        while events.len() < count {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if reader.push(&buf[..n], &mut events).is_err() {
                        break;
                    }
                }
            }
        }
        events
    }

    fn client_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
        let mask = [9, 8, 7, 6];
        let mut body = payload.to_vec();
        mask_in_place(&mut body, mask);
        [frame_header(opcode, payload.len(), Some(mask)), body].concat()
    }

    fn server_frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
        [frame_header(opcode, payload.len(), None), payload.to_vec()].concat()
    }

    struct Session {
        codex: TcpStream,
        codex_leftover: Vec<u8>,
        status: u16,
        response: String,
        worker: thread::JoinHandle<Result<(), Fallback>>,
    }

    /// A Child worker serving one upgrade, and Codex's connection to it. `first` is sent with the head.
    fn session(home_port: u16, limits: Limits, extra: &str, first: &[u8]) -> Session {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut reader =
                BufReader::new(DeadlineStream::new(stream, None, Duration::from_secs(1)));
            let req = read_request_head(&mut reader).unwrap();
            let result = open(&mut reader, &mut writer, &req, home_port, creds(), limits);
            if result.is_err() {
                let _ = write_upgrade_required(&mut writer);
            }
            result
        });
        let mut codex = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port))).unwrap();
        let head = format!(
            "GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {KEY}\r\nAuthorization: Bearer codex-own\r\nthread-id: thread-1\r\n{extra}\r\n"
        );
        codex.write_all(&[head.as_bytes(), first].concat()).unwrap();
        let mut reader = BufReader::new(codex.try_clone().unwrap());
        let Ok(resp) = read_response_head(&mut reader) else {
            // The Child ended the connection without an answer.
            return Session {
                codex,
                codex_leftover: Vec::new(),
                status: 0,
                response: String::new(),
                worker,
            };
        };
        let leftover = reader.buffer().to_vec();
        let response = resp
            .headers
            .iter()
            .map(|(k, v)| format!("{}: {v}", k.to_ascii_lowercase()))
            .collect::<Vec<_>>()
            .join("\n");
        Session {
            codex,
            codex_leftover: leftover,
            status: resp.status,
            response,
            worker,
        }
    }

    #[test]
    fn relays_text_both_ways_with_the_link_key_and_the_coalesced_first_frame() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let first = client_frame(1, br#"{"type":"response.create"}"#);
        let mut s = session(home_port, test_limits(), "", &first);
        assert_eq!(s.status, 101);
        assert!(
            s.response
                .contains("x-codex-websocket-max-message-bytes: 8388608")
        );
        assert!(
            s.response
                .contains(&format!("sec-websocket-accept: {}", websocket_accept(KEY)))
        );
        let mut home = homes.recv().unwrap();
        let header = |n: &str| {
            home.request
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(n))
                .map(|(_, v)| v.clone())
        };
        assert_eq!(
            header("authorization").as_deref(),
            Some(format!("Bearer {TOKEN}").as_str())
        );
        assert_eq!(header("thread-id").as_deref(), Some("thread-1"));
        assert!(header("x-opencodex-link-session").is_some());
        assert!(header("origin").is_none() && header("sec-websocket-extensions").is_none());
        let got = read_events(&mut home.stream, Role::FromClient, &home.leftover, 1);
        assert_eq!(
            got,
            vec![FrameEvent::Text(r#"{"type":"response.create"}"#.into())]
        );
        home.stream
            .write_all(&server_frame(1, b"from-home"))
            .unwrap();
        let back = read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 1);
        assert_eq!(back, vec![FrameEvent::Text("from-home".into())]);
        s.codex
            .write_all(&client_frame(8, &close_payload(Some(1000), "")))
            .unwrap();
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &[], 1),
            vec![FrameEvent::Close(Some(1000), String::new())]
        );
        home.stream
            .write_all(&server_frame(8, &close_payload(Some(1000), "")))
            .unwrap();
        assert!(s.worker.join().unwrap().is_ok());
        wait_all_released();
    }

    #[test]
    fn a_failed_local_101_aborts_the_home_thread_and_cuts_the_home_connection() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        FAIL_101.store(true, Ordering::SeqCst);
        let s = session(home_port, test_limits(), "", &[]);
        assert_eq!(s.status, 0, "nothing is written after a failed 101");
        assert_eq!(s.worker.join().unwrap(), Ok(()));
        let mut home = homes.recv().unwrap();
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![],
            "the Home connection ends without a close frame"
        );
        wait_all_released();
    }

    #[test]
    fn a_close_claim_keeps_its_deadline_through_the_workers_cleanup() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        // A close bound that cannot fire during the test: only retirement can remove the entry.
        let limits = Limits {
            close_bound: Duration::from_secs(120),
            ..test_limits()
        };
        let s = session(home_port, limits, "", &[]);
        assert_eq!(s.status, 101);
        let home = homes.recv().unwrap();
        let shared = only_socket();
        let (reached_tx, reached) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        *lock(&CLAIM_GATE) = Some((reached_tx, release_rx));
        let closer = {
            let shared = Arc::clone(&shared);
            thread::spawn(move || {
                terminate(
                    &shared,
                    CloseAction::Frame(1001, String::new()),
                    CloseAction::Frame(1001, String::new()),
                );
            })
        };
        reached.recv().unwrap();
        // Between the claim and the first close write, both peers leave and the worker cleans up.
        home.stream.shutdown(Shutdown::Both).unwrap();
        s.codex.shutdown(Shutdown::Both).unwrap();
        assert!(s.worker.join().unwrap().is_ok());
        let token = {
            let st = lock(&shared.state);
            assert!(st.cleanup_done);
            assert_eq!(st.close_io, 1);
            st.close_token
                .expect("the claimed close keeps its deadline")
        };
        assert!(
            reaper_holds(token),
            "cleanup did not retire a claimed close entry"
        );
        release.send(()).unwrap();
        closer.join().unwrap();
        assert!(lock(&shared.state).close_token.is_none());
        assert!(
            !reaper_holds(token),
            "the last close caller retires the entry"
        );
        drop(shared);
        wait_all_released();
    }

    #[test]
    fn a_close_behind_a_blocked_data_write_returns_at_the_close_deadline() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        // Default stall (300 s) and data (600 s) bounds: only the 300 ms close deadline can end this.
        let s = session(home_port, test_limits(), "", &[]);
        let _home = homes.recv().unwrap();
        let shared = only_socket();
        let (locked_tx, locked) = mpsc::channel();
        *lock(&DATA_LOCKED) = Some(locked_tx);
        let writer = {
            let shared = Arc::clone(&shared);
            // Codex never reads: 64 MiB cannot fit in the loopback buffers, so this write blocks.
            thread::spawn(move || {
                write_frame(&shared, Leg::Codex, 1, vec![b'w'; 64 * MIB], Kind::Data)
            })
        };
        locked.recv().unwrap();
        let started = Instant::now();
        terminate(
            &shared,
            CloseAction::Frame(1001, String::new()),
            CloseAction::Frame(1001, String::new()),
        );
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(30),
            "the close waited {elapsed:?} behind the data write"
        );
        assert!(writer.join().unwrap().is_err());
        assert!(s.worker.join().unwrap().is_ok());
        drop(s.codex);
        drop(shared);
        wait_all_released();
    }

    #[test]
    fn maximum_messages_cross_in_both_directions_at_once() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let l = test_limits();
        let mut s = session(home_port, l, "", &[]);
        let mut home = homes.recv().unwrap();
        let up = "u".repeat(l.local_message);
        let down = "d".repeat(l.home_message);
        let mut codex_writer = s.codex.try_clone().unwrap();
        let up_frame = client_frame(1, up.as_bytes());
        let codex_send = thread::spawn(move || codex_writer.write_all(&up_frame).is_ok());
        let mut home_writer = home.stream.try_clone().unwrap();
        let down_frame = server_frame(1, down.as_bytes());
        let home_send = thread::spawn(move || home_writer.write_all(&down_frame).is_ok());
        let mut home_stream = home.stream.try_clone().unwrap();
        let leftover = std::mem::take(&mut home.leftover);
        let home_read =
            thread::spawn(move || read_events(&mut home_stream, Role::FromClient, &leftover, 1));
        let at_codex = read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 1);
        let at_home = home_read.join().unwrap();
        assert!(codex_send.join().unwrap() && home_send.join().unwrap());
        assert_eq!(at_codex, vec![FrameEvent::Text(down)]);
        assert_eq!(at_home, vec![FrameEvent::Text(up)]);
        s.codex.shutdown(Shutdown::Both).unwrap();
        assert!(s.worker.join().unwrap().is_ok());
        wait_all_released();
    }

    #[test]
    fn pings_during_large_messages_get_whole_pongs_between_frames() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let mut s = session(home_port, test_limits(), "", &[]);
        let home = homes.recv().unwrap();
        // Codex holds off reading while the Home sends large messages and Codex pings repeatedly.
        let mut home_writer = home.stream.try_clone().unwrap();
        let big = server_frame(1, &vec![b'm'; MIB]);
        let home_send = thread::spawn(move || {
            for _ in 0..3 {
                home_writer.write_all(&big).unwrap();
            }
        });
        let pings: Vec<u8> = (0..100u8).flat_map(|i| client_frame(9, &[i])).collect();
        s.codex.write_all(&pings).unwrap();
        let events = read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 103);
        home_send.join().unwrap();
        let texts: Vec<usize> = events
            .iter()
            .filter_map(|e| match e {
                FrameEvent::Text(t) => Some(t.len()),
                _ => None,
            })
            .collect();
        let pongs: Vec<Vec<u8>> = events
            .iter()
            .filter_map(|e| match e {
                FrameEvent::Pong(p) => Some(p.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec![MIB; 3]);
        assert_eq!(pongs, (0..100u8).map(|i| vec![i]).collect::<Vec<_>>());
        s.codex.shutdown(Shutdown::Both).unwrap();
        assert!(s.worker.join().unwrap().is_ok());
        wait_all_released();
    }

    #[test]
    fn codex_lost_while_a_write_to_it_is_blocked_ends_both_legs() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        // Default write bounds: only Codex's departure can end this promptly.
        let s = session(home_port, test_limits(), "", &[]);
        let mut home = homes.recv().unwrap();
        let (locked_tx, locked) = mpsc::channel();
        *lock(&DATA_LOCKED) = Some(locked_tx);
        let mut home_writer = home.stream.try_clone().unwrap();
        let flood = thread::spawn(move || {
            let message = server_frame(1, &vec![b'f'; MIB]);
            for _ in 0..64 {
                if home_writer.write_all(&message).is_err() {
                    return;
                }
            }
        });
        locked.recv().unwrap();
        s.codex.shutdown(Shutdown::Both).unwrap();
        assert!(s.worker.join().unwrap().is_ok());
        let mut rest = vec![0u8; 64 * KIB];
        loop {
            match home.stream.read(&mut rest) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
        // The flood is this test's own writer and may be blocked on a socket the Child has already shut down;
        // shutting our end wakes it at once (otherwise it waits for the kernel to drop the orphaned connection).
        let _ = home.stream.shutdown(Shutdown::Both);
        let _ = flood.join();
        wait_all_released();
    }

    #[test]
    fn stop_with_writes_blocked_both_ways_on_several_sockets_ends() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let mut sessions = Vec::new();
        let mut floods = Vec::new();
        for _ in 0..3 {
            // Default write bounds; neither peer reads, both send.
            let s = session(home_port, test_limits(), "", &[]);
            assert_eq!(s.status, 101);
            let home = homes.recv().unwrap();
            let mut codex_writer = s.codex.try_clone().unwrap();
            floods.push(thread::spawn(move || {
                let message = client_frame(1, &vec![b'c'; MIB]);
                for _ in 0..64 {
                    if codex_writer.write_all(&message).is_err() {
                        return;
                    }
                }
            }));
            let mut home_writer = home.stream.try_clone().unwrap();
            floods.push(thread::spawn(move || {
                let message = server_frame(1, &vec![b'h'; MIB]);
                for _ in 0..64 {
                    if home_writer.write_all(&message).is_err() {
                        return;
                    }
                }
            }));
            sessions.push((s, home));
        }
        let started = Instant::now();
        stop_all();
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(30),
            "stop took {elapsed:?} with writes blocked"
        );
        for (s, home) in sessions {
            assert!(s.worker.join().unwrap().is_ok());
            // The floods are this test's own writers: shutting our ends wakes them at once.
            let _ = home.stream.shutdown(Shutdown::Both);
            let _ = s.codex.shutdown(Shutdown::Both);
        }
        for f in floods {
            let _ = f.join();
        }
        wait_all_released();
        reset_registry();
    }

    #[test]
    fn a_home_that_does_not_advertise_refuses_or_answers_a_broken_101_gets_426() {
        let _serial = lock(&SERIAL);
        reset_registry();
        for (mode, why) in [
            (HomeMode::Silent, Fallback::NotAdvertised),
            (HomeMode::Refuse, Fallback::HomeRefused),
            (HomeMode::WrongAccept, Fallback::HomeRefused),
        ] {
            let (home_port, _homes) = mock_home(mode);
            let s = session(home_port, test_limits(), "", &[]);
            assert_eq!(s.status, 426);
            assert_eq!(s.worker.join().unwrap(), Err(why));
        }
        let s = session(1, test_limits(), "", &[]);
        assert_eq!(s.status, 426);
        assert_eq!(s.worker.join().unwrap(), Err(Fallback::Preflight));
        let (home_port, _homes) = mock_home(HomeMode::Advertise);
        let s = session(
            home_port,
            test_limits(),
            "Origin: http://127.0.0.1\r\n",
            &[],
        );
        assert_eq!(s.status, 426);
        assert_eq!(s.worker.join().unwrap(), Err(Fallback::Origin));
        wait_all_released();
    }

    #[test]
    fn binary_closes_both_legs_with_1003() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let mut s = session(home_port, test_limits(), "", &[]);
        let mut home = homes.recv().unwrap();
        s.codex.write_all(&client_frame(2, &[1, 2, 3])).unwrap();
        assert_eq!(
            read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 1),
            vec![FrameEvent::Close(
                Some(1003),
                "binary messages are not relayed".into()
            )]
        );
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![FrameEvent::Close(Some(1003), String::new())]
        );
        assert!(s.worker.join().unwrap().is_ok());
        wait_all_released();
    }

    #[test]
    fn codex_close_without_status_and_codex_drop_reach_the_home_as_such() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let mut s = session(home_port, test_limits(), "", &[]);
        let mut home = homes.recv().unwrap();
        s.codex.write_all(&client_frame(8, &[])).unwrap();
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![FrameEvent::Close(None, String::new())]
        );
        assert!(s.worker.join().unwrap().is_ok());
        // Codex gone without a close frame: the Home connection ends without one.
        let s = session(home_port, test_limits(), "", &[]);
        let mut home = homes.recv().unwrap();
        s.codex.shutdown(Shutdown::Both).unwrap();
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![]
        );
        assert!(s.worker.join().unwrap().is_ok());
        wait_all_released();
    }

    #[test]
    fn home_close_codes_are_relayed_and_a_dropped_home_is_1011() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        for code in [4401u16, 1012, 1013, 1014] {
            let mut s = session(home_port, test_limits(), "", &[]);
            let mut home = homes.recv().unwrap();
            home.stream
                .write_all(&server_frame(8, &close_payload(Some(code), "bye")))
                .unwrap();
            assert_eq!(
                read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 1),
                vec![FrameEvent::Close(Some(code), "bye".into())]
            );
            assert_eq!(
                read_events(&mut home.stream, Role::FromClient, &[], 1),
                vec![FrameEvent::Close(Some(code), String::new())]
            );
            assert!(s.worker.join().unwrap().is_ok());
        }
        let mut s = session(home_port, test_limits(), "", &[]);
        let home = homes.recv().unwrap();
        home.stream.shutdown(Shutdown::Both).unwrap();
        assert_eq!(
            read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 1),
            vec![FrameEvent::Close(
                Some(1011),
                "home connection ended".into()
            )]
        );
        assert!(s.worker.join().unwrap().is_ok());
        wait_all_released();
    }

    #[test]
    fn a_home_message_over_the_limit_closes_codex_1011_and_the_home_1009() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let mut s = session(
            home_port,
            Limits {
                home_message: 1024,
                ..test_limits()
            },
            "",
            &[],
        );
        let mut home = homes.recv().unwrap();
        home.stream
            .write_all(&server_frame(1, &[b'y'; 2048]))
            .unwrap();
        assert_eq!(
            read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 1),
            vec![FrameEvent::Close(Some(1011), "home message refused".into())]
        );
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![FrameEvent::Close(Some(1009), String::new())]
        );
        assert!(s.worker.join().unwrap().is_ok());
        wait_all_released();
    }

    #[test]
    fn caps_refuse_and_a_slot_returns_only_after_the_home_connection_closed() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let one = Limits {
            open_sockets: 1,
            ..test_limits()
        };
        let mut first = session(home_port, one, "", &[]);
        let mut home = homes.recv().unwrap();
        let second = session(home_port, one, "", &[]);
        assert_eq!(second.status, 426);
        assert_eq!(second.worker.join().unwrap(), Err(Fallback::Cap));
        // Codex closes; the Home never answers: the slot is held until the close bound shuts it down.
        first
            .codex
            .write_all(&client_frame(8, &close_payload(Some(1000), "")))
            .unwrap();
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![FrameEvent::Close(Some(1000), String::new())]
        );
        let mut rest = [0u8; 16];
        assert_eq!(
            home.stream.read(&mut rest).unwrap_or(0),
            0,
            "the Child ends the Home connection at the close bound"
        );
        assert!(first.worker.join().unwrap().is_ok());
        wait_all_released();
        let mem = Limits {
            memory_budget: 0,
            ..test_limits()
        };
        let refused = session(home_port, mem, "", &[]);
        assert_eq!(refused.worker.join().unwrap(), Err(Fallback::Cap));
    }

    #[test]
    fn the_setup_deadline_ends_a_held_upgrade() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Hold);
        let s = session(
            home_port,
            Limits {
                setup: Duration::from_millis(300),
                ..test_limits()
            },
            "",
            &[],
        );
        assert_eq!(s.status, 426);
        assert_eq!(s.worker.join().unwrap(), Err(Fallback::HomeRefused));
        drop(homes);
        wait_all_released();
    }

    #[test]
    fn stop_closes_open_sockets_with_1001_and_refuses_new_ones() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let mut s = session(home_port, test_limits(), "", &[]);
        let mut home = homes.recv().unwrap();
        stop_all();
        assert_eq!(
            read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 1),
            vec![FrameEvent::Close(
                Some(1001),
                "link websocket stopping".into()
            )]
        );
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![FrameEvent::Close(Some(1001), String::new())]
        );
        assert!(s.worker.join().unwrap().is_ok());
        let after = session(home_port, test_limits(), "", &[]);
        assert_eq!(after.worker.join().unwrap(), Err(Fallback::Cap));
        reset_registry();
    }

    #[test]
    fn pings_are_answered_per_hop() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let mut s = session(home_port, test_limits(), "", &[]);
        let mut home = homes.recv().unwrap();
        home.stream.write_all(&server_frame(9, b"hp")).unwrap();
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![FrameEvent::Pong(b"hp".to_vec())]
        );
        s.codex.write_all(&client_frame(9, b"cp")).unwrap();
        assert_eq!(
            read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 1),
            vec![FrameEvent::Pong(b"cp".to_vec())]
        );
        home.stream.write_all(&server_frame(1, b"after")).unwrap();
        assert_eq!(
            read_events(&mut s.codex, Role::FromServer, &[], 1),
            vec![FrameEvent::Text("after".into())]
        );
        s.codex.shutdown(Shutdown::Both).unwrap();
        assert!(s.worker.join().unwrap().is_ok());
        wait_all_released();
    }

    #[test]
    fn a_codex_that_stops_reading_is_disconnected_by_the_write_bounds() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let limits = Limits {
            stall: Duration::from_millis(200),
            data_operation: Duration::from_millis(400),
            ..test_limits()
        };
        let s = session(home_port, limits, "", &[]);
        let home = homes.recv().unwrap();
        let mut writer = home.stream.try_clone().unwrap();
        let flood = thread::spawn(move || {
            let message = server_frame(1, &vec![b'z'; MIB]);
            for _ in 0..64 {
                if writer.write_all(&message).is_err() {
                    return;
                }
            }
        });
        // Codex never reads: the write toward it stalls, the operation bound shuts both legs down.
        assert!(s.worker.join().unwrap().is_ok());
        // The flood is this test's own writer and may be blocked on a socket the Child has already shut down;
        // shutting our end wakes it at once (otherwise it waits for the kernel to drop the orphaned connection).
        let _ = home.stream.shutdown(Shutdown::Both);
        let _ = flood.join();
        drop(s.codex);
        wait_all_released();
    }

    #[test]
    fn a_home_close_while_the_worker_is_blocked_writing_ends_within_the_close_bound() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        let mut s = session(home_port, test_limits(), "", &[]);
        let mut home = homes.recv().unwrap();
        // The Home stops reading; Codex floods until the worker blocks writing to the Home.
        let mut codex_writer = s.codex.try_clone().unwrap();
        let flood = thread::spawn(move || {
            let message = client_frame(1, &vec![b'q'; MIB]);
            for _ in 0..64 {
                if codex_writer.write_all(&message).is_err() {
                    return;
                }
            }
        });
        home.stream
            .write_all(&server_frame(8, &close_payload(Some(4000), "home")))
            .unwrap();
        let events = read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 1);
        assert_eq!(events, vec![FrameEvent::Close(Some(4000), "home".into())]);
        assert!(s.worker.join().unwrap().is_ok());
        // The flood is this test's own writer and may be blocked on a socket the Child has already shut down;
        // shutting our end wakes it at once (otherwise it waits for the kernel to drop the orphaned connection).
        let _ = s.codex.shutdown(Shutdown::Both);
        let _ = flood.join();
        wait_all_released();
    }

    #[test]
    fn a_stop_between_the_101_and_the_start_aborts_and_releases_the_home_thread() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        *lock(&BEFORE_START) = Some(stop_all_without_join);
        let mut s = session(home_port, test_limits(), "", &[]);
        let mut home = homes.recv().unwrap();
        assert_eq!(s.status, 101);
        assert_eq!(
            read_events(&mut s.codex, Role::FromServer, &s.codex_leftover, 1),
            vec![FrameEvent::Close(
                Some(1001),
                "link websocket stopping".into()
            )]
        );
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![FrameEvent::Close(Some(1001), String::new())]
        );
        assert!(s.worker.join().unwrap().is_ok());
        *lock(&BEFORE_START) = None;
        wait_all_released();
        reset_registry();
    }

    /// The registry half of stop_all (used inside the start hook, where joining the reaper would wait on this socket).
    fn stop_all_without_join() {
        let (m, _) = registry();
        lock(m).stopping = true;
    }

    /// `stop_owned_daemon` (detach, restart, sync) waits 3 s for the port to close; the link WebSocket's share
    /// of a stop must leave room for the listener to close and the process to exit.
    const DETACH_WAIT: Duration = Duration::from_secs(3);

    #[test]
    fn a_stop_with_a_codex_that_does_not_read_ends_well_inside_detachs_wait() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        // The default limits: a 5 s close bound, 300 s stall, 600 s data operations.
        let s = session(home_port, LIMITS, "", &[]);
        assert_eq!(s.status, 101);
        let _home = homes.recv().unwrap();
        let shared = only_socket();
        let (locked_tx, locked) = mpsc::channel();
        *lock(&DATA_LOCKED) = Some(locked_tx);
        // Codex never reads; a large message holds Codex's write lock, so the stop's 1001 cannot be written.
        let writer = {
            let shared = Arc::clone(&shared);
            thread::spawn(move || {
                write_frame(&shared, Leg::Codex, 1, vec![b's'; 64 * MIB], Kind::Data)
            })
        };
        locked.recv().unwrap();
        drop(shared);
        let started = Instant::now();
        stop_all();
        let elapsed = started.elapsed();
        assert!(
            elapsed < DETACH_WAIT - Duration::from_secs(1),
            "stop took {elapsed:?}; detach gives up after {DETACH_WAIT:?}"
        );
        assert!(writer.join().unwrap().is_err());
        assert!(s.worker.join().unwrap().is_ok());
        drop(s.codex);
        wait_all_released();
        reset_registry();
    }

    #[test]
    fn a_failed_thread_spawn_answers_426_and_closes_the_home_connection() {
        let _serial = lock(&SERIAL);
        reset_registry();
        let (home_port, homes) = mock_home(HomeMode::Advertise);
        FAIL_SPAWN.store(true, Ordering::SeqCst);
        let s = session(home_port, test_limits(), "", &[]);
        assert_eq!(s.status, 426);
        assert_eq!(s.worker.join().unwrap(), Err(Fallback::Unavailable));
        let mut home = homes.recv().unwrap();
        assert_eq!(
            read_events(&mut home.stream, Role::FromClient, &home.leftover, 1),
            vec![]
        );
        wait_all_released();
    }
}
