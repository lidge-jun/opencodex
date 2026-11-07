use std::io::{BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::http_wire::{read_bounded_body, read_response_head, response_framing};
use crate::platform::{
    constant_time_eq, now_epoch_ms, process_is_alive, random_hex, spawn_detached_serve,
};
use crate::relay_auth::compute_child_shutdown_proof;
use crate::state::{ChildPaths, ChildStateV1, write_child_state};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHealthz {
    pub service: String,
    pub role: Option<String>,
    pub ephemeral_child: Option<bool>,
    pub pid: u32,
    pub port: u16,
    pub started_at: Option<String>,
}

pub fn pick_ephemeral_link_port() -> Result<u16, String> {
    let seed_hex = random_hex(2).unwrap_or_else(|_| "0000".to_owned());
    let offset = u16::from_str_radix(&seed_hex, 16).unwrap_or(0) % 10_000;
    for step in 0..64u16 {
        let candidate = 20_000 + ((offset.wrapping_add(step.wrapping_mul(137))) % 10_000);
        if let Ok(listener) = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], candidate))) {
            let p = listener.local_addr().map(|a| a.port()).unwrap_or(candidate);
            drop(listener);
            return Ok(p);
        }
    }
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .map_err(|e| format!("failed to allocate loopback port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();
    Ok(port)
}

pub fn probe_local_healthz(port: u16, timeout: Duration) -> Option<LocalHealthz> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let req =
        format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    stream.flush().ok()?;
    let mut reader = BufReader::new(stream);
    let head = read_response_head(&mut reader).ok()?;
    if head.status != 200 {
        return None;
    }
    let framing = response_framing(head.status, "GET", &head.headers).ok()?;
    let body = read_bounded_body(&mut reader, framing, 64 * 1024).ok()?;
    serde_json::from_slice(&body).ok()
}

pub fn is_port_bound(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(150),
    )
    .is_ok()
}

pub fn ensure_port_available_for_attach(port: u16, owned_pid: Option<u32>) -> Result<(), String> {
    if let Some(health) = probe_local_healthz(port, Duration::from_millis(500)) {
        if health.service == "opencodex"
            && health.ephemeral_child == Some(true)
            && owned_pid == Some(health.pid)
        {
            return Ok(());
        }
        return Err(format!(
            "attach refused: 127.0.0.1:{port} is already served by foreign listener (pid {})",
            health.pid
        ));
    }
    if TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).is_err() {
        return Err(format!(
            "attach refused: 127.0.0.1:{port} is already in use"
        ));
    }
    Ok(())
}

fn send_attested_shutdown(port: u16, shutdown_secret: &str) -> bool {
    let Ok(nonce) = random_hex(32) else {
        return false;
    };
    let Some(expected) = compute_child_shutdown_proof(shutdown_secret, "listener", &nonce) else {
        return false;
    };
    let Some(caller) = compute_child_shutdown_proof(shutdown_secret, "caller", &nonce) else {
        return false;
    };
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let req = format!(
        "POST /__ocx_child/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-ocx-child-shutdown-challenge: {nonce}\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() || stream.flush().is_err() {
        return false;
    }
    let Ok(read_stream) = stream.try_clone() else {
        return false;
    };
    let mut reader = BufReader::new(read_stream);
    let Ok(head) = read_response_head(&mut reader) else {
        return false;
    };
    let proof_count = head
        .headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("x-ocx-child-shutdown-proof"))
        .count();
    let lengths: Vec<&str> = head
        .headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .map(|(_, v)| v.as_str())
        .collect();
    if head.status != 204
        || proof_count != 1
        || lengths != ["0"]
        || head
            .headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("transfer-encoding"))
        || !head
            .header("x-ocx-child-shutdown-proof")
            .is_some_and(|proof| constant_time_eq(proof.as_bytes(), expected.as_bytes()))
    {
        return false;
    }
    let req = format!(
        "POST /__ocx_child/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-ocx-child-shutdown-proof: {caller}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() || stream.flush().is_err() {
        return false;
    }
    read_response_head(&mut reader).is_ok_and(|h| h.status == 200)
}

pub fn stop_owned_daemon(state: &ChildStateV1) -> Result<(), String> {
    let port = state.listen_port;
    let live_health = probe_local_healthz(port, Duration::from_millis(500));
    let verified_pid = match (state.daemon_pid, &live_health) {
        (Some(expected_pid), Some(h))
            if h.service == "opencodex"
                && h.ephemeral_child == Some(true)
                && expected_pid == h.pid =>
        {
            Some(h.pid)
        }
        (Some(pid), None) if !is_port_bound(port) && !process_is_alive(pid) => return Ok(()),
        (None, None) if !is_port_bound(port) => return Ok(()),
        _ => return Err("cannot establish that the child daemon has stopped".to_owned()),
    };

    if !send_attested_shutdown(port, &state.shutdown_secret) {
        return Err("child daemon did not accept the authenticated shutdown".to_owned());
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        let port_down = !is_port_bound(port);
        let pid_down = verified_pid.is_none_or(|p| !process_is_alive(p));
        if port_down && pid_down {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(40));
    }

    Err(format!(
        "child daemon on 127.0.0.1:{port} did not stop; refusing unverified termination"
    ))
}

pub fn start_or_rollover_daemon(
    paths: &ChildPaths,
    state: &mut ChildStateV1,
    min_started_at_ms: Option<u64>,
) -> Result<(u32, u64), String> {
    stop_owned_daemon(state)?;
    if let Some(floor_ms) = min_started_at_ms {
        let now = now_epoch_ms();
        if now < floor_ms {
            thread::sleep(Duration::from_millis((floor_ms - now).min(100)));
        }
    }
    ensure_port_available_for_attach(state.listen_port, None)?;
    let exe = std::env::current_exe()
        .map_err(|e| format!("failed to resolve current executable: {e}"))?;
    let pending_attach = match std::fs::symlink_metadata(&paths.rollback_file) {
        Ok(_) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("cannot inspect rollback snapshot: {e}")),
    };
    let mut spawned = spawn_detached_serve(
        &exe,
        &paths.opencodex_home,
        &paths.codex_home,
        state.listen_port,
        pending_attach.then_some(state.shutdown_secret.as_str()),
    )?;
    let spawned_pid = spawned.id();

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(status) = spawned
            .try_wait()
            .map_err(|e| format!("failed to observe spawned child: {e}"))?
        {
            return Err(format!("ocx-child serve exited before readiness: {status}"));
        }
        if let Some(h) = probe_local_healthz(state.listen_port, Duration::from_millis(400))
            && h.service == "opencodex"
            && h.role.as_deref() == Some("client")
            && h.ephemeral_child == Some(true)
            && h.pid == spawned_pid
        {
            let started_ms = now_epoch_ms().max(min_started_at_ms.unwrap_or(0));
            state.daemon_pid = Some(spawned_pid);
            state.daemon_started_at_ms = Some(started_ms);
            if let Err(e) = write_child_state(&paths.state_file, state) {
                let cleanup = spawned.kill().and_then(|()| spawned.wait().map(|_| ()));
                return Err(format!(
                    "failed to record spawned child: {e}; cleanup: {cleanup:?}"
                ));
            }
            return Ok((spawned_pid, started_ms));
        }
        thread::sleep(Duration::from_millis(50));
    }
    if spawned
        .try_wait()
        .map_err(|e| format!("failed to observe spawned child: {e}"))?
        .is_none()
    {
        spawned
            .kill()
            .map_err(|e| format!("failed to terminate spawned child: {e}"))?;
        spawned
            .wait()
            .map_err(|e| format!("failed to reap spawned child: {e}"))?;
    }
    Err(format!(
        "ocx-child serve failed to answer /healthz on 127.0.0.1:{}",
        state.listen_port
    ))
}
