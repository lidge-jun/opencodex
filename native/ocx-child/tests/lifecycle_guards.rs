#![deny(unsafe_op_in_unsafe_fn)]
//! Process-level regressions for ocx-child lifecycle serialization, recovery, daemon commit,
//! and shutdown guarantees.

mod common;
use common::*;

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Child, Output, Stdio};
use std::time::Duration;

use ocx_child::cli::AttachRollbackSnapshot;
use ocx_child::codex_home::{ClaimPolicy, CodexHomeGuard};
use ocx_child::codex_settings::HomeCodexSettings;
use ocx_child::daemon::pick_ephemeral_link_port;
use ocx_child::journal::apply_attach_or_sync;
use ocx_child::state::ChildPaths;

const LINK_ID: &str = "lnk_0123456789abcdef";
const KEY_ID: &str = "link:rust-test";

fn raw_token() -> String {
    format!("ocx_data_{}", "a".repeat(40))
}

fn creds_json() -> String {
    format!(r#"{{"apiKeyId":"{KEY_ID}","key":"{}"}}"#, raw_token())
}

fn distinct_port(taken: &[u16]) -> u16 {
    loop {
        let port = pick_ephemeral_link_port().unwrap();
        if !taken.contains(&port) {
            return port;
        }
    }
}

fn spawn_with_creds(mut cmd: std::process::Command) -> Child {
    cmd.stdin(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(creds_json().as_bytes())
        .unwrap();
    child
}

fn text(output: &Output) -> String {
    format!(
        "status={:?} stdout={} stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// Bytes of every regular file directly inside `dir`, except the never-deleted lock file.
fn snapshot_dir(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    for entry in fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".ocx-child.lock" || !entry.file_type().unwrap().is_file() {
            continue;
        }
        out.insert(name, fs::read(entry.path()).unwrap());
    }
    out
}

fn assert_same_files(
    actual: &BTreeMap<String, Vec<u8>>,
    expected: &BTreeMap<String, Vec<u8>>,
    what: &str,
) {
    let differing: Vec<&String> = actual
        .keys()
        .chain(expected.keys())
        .filter(|name| actual.get(*name) != expected.get(*name))
        .collect();
    assert!(differing.is_empty(), "{what}: {differing:?}");
}

fn without_owner_record(mut files: BTreeMap<String, Vec<u8>>) -> BTreeMap<String, Vec<u8>> {
    files.remove(".ocx-child-owner.json");
    files
}

#[test]
fn two_child_homes_sharing_one_codex_home_are_serialized_and_exclusive() {
    let scratch = Scratch::new("shared-codex");
    let ocx_a = scratch.0.join("ocx-a");
    let ocx_b = scratch.0.join("ocx-b");
    let codex = scratch.0.join("codex");
    for dir in [&ocx_a, &ocx_b, &codex] {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(
        codex.join("config.toml"),
        b"approval_policy = 'on-request'\n",
    )
    .unwrap();
    let home = MockHomeServer::start(&raw_token(), KEY_ID, LINK_ID);
    let tunnel = home.port.to_string();
    let port_a = distinct_port(&[]);
    let port_b = distinct_port(&[port_a]);
    let (pa, pb) = (port_a.to_string(), port_b.to_string());

    let barrier_a = Barrier::new(&scratch.0, "a");
    let mut args_a = attach_args(&tunnel, LINK_ID, &pa);
    args_a.push("--no-daemon");
    let mut cmd_a = child_command(&ocx_a, &codex, port_a, &args_a);
    barrier_a.apply(&mut cmd_a, "attach-protected");
    let a = spawn_with_creds(cmd_a);
    assert!(
        barrier_a.wait_reached("attach-protected", Duration::from_secs(20)),
        "A never entered the protected attach section"
    );
    let before = snapshot_dir(&codex);

    let barrier_b = Barrier::new(&scratch.0, "b");
    let mut args_b = attach_args(&tunnel, LINK_ID, &pb);
    args_b.push("--no-daemon");
    let mut cmd_b = child_command(&ocx_b, &codex, port_b, &args_b);
    barrier_b.apply(&mut cmd_b, "attach-protected");
    let b = spawn_with_creds(cmd_b);

    let b_entered = barrier_b.wait_reached("attach-protected", Duration::from_millis(1500));
    if b_entered {
        barrier_b.release("attach-protected");
    }
    barrier_a.release("attach-protected");
    assert!(
        !b_entered,
        "B entered the protected section while A held the shared CODEX_HOME"
    );
    assert_same_files(
        &snapshot_dir(&codex),
        &before,
        "B changed shared files while A held them",
    );

    let out_a = a.wait_with_output().unwrap();
    assert!(out_a.status.success(), "A attach failed: {}", text(&out_a));
    assert!(
        !String::from_utf8_lossy(&out_a.stdout).contains(KEY_ID)
            && !String::from_utf8_lossy(&out_a.stderr).contains(KEY_ID),
        "attach output must not name the link key id: {}",
        text(&out_a)
    );
    let after_a = snapshot_dir(&codex);
    let out_b = b.wait_with_output().unwrap();
    assert!(
        !out_b.status.success(),
        "B attached a CODEX_HOME owned by A: {}",
        text(&out_b)
    );
    assert!(
        String::from_utf8_lossy(&out_b.stderr).contains("owned by another ocx-child"),
        "B refusal lacks an ownership recovery message: {}",
        text(&out_b)
    );
    assert!(!barrier_b.reached("attach-protected"));
    assert_same_files(
        &snapshot_dir(&codex),
        &after_a,
        "refused attach B changed shared files",
    );
    assert!(!ocx_b.join("child").join("codex-journal.json").exists());
    assert!(!ocx_b.join("child").join("state.json").exists());

    let (code, _, err) = run_bin(&ocx_a, &codex, port_a, &["detach"], None);
    assert_eq!(code, 0, "A detach failed: {err}");
    assert!(!codex.join(".ocx-child-owner.json").exists());

    let mut args_b = attach_args(&tunnel, LINK_ID, &pb);
    args_b.push("--no-daemon");
    let out_b = spawn_with_creds(child_command(&ocx_b, &codex, port_b, &args_b))
        .wait_with_output()
        .unwrap();
    assert!(
        out_b.status.success(),
        "B attach after A detach failed: {}",
        text(&out_b)
    );
    let (code, _, err) = run_bin(&ocx_b, &codex, port_b, &["detach"], None);
    assert_eq!(code, 0, "B detach failed: {err}");
    assert_eq!(
        fs::read(codex.join("config.toml")).unwrap(),
        b"approval_policy = 'on-request'\n"
    );
}

fn swap_in_sentinel_home(codex: &Path, saved: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::rename(codex, saved).unwrap();
    fs::create_dir(codex).unwrap();
    for (name, bytes) in [
        ("config.toml", &b"sentinel-config"[..]),
        ("opencodex-catalog.json", &b"sentinel-catalog"[..]),
        ("models_cache.json", &b"sentinel-cache"[..]),
    ] {
        fs::write(codex.join(name), bytes).unwrap();
    }
    snapshot_dir(codex)
}

/// An attach that crashed after its rollback snapshot and journal application: the durable
/// snapshot is still pending and detach must recover it.
fn crashed_attach_fixture(scratch: &Scratch) -> (ChildPaths, Vec<u8>) {
    let paths = ChildPaths::new(scratch.0.join("ocx"), scratch.0.join("codex"));
    fs::create_dir_all(&paths.opencodex_home).unwrap();
    fs::create_dir_all(&paths.codex_home).unwrap();
    let original = b"approval_policy = 'on-request'\n".to_vec();
    fs::write(paths.codex_config_path(), &original).unwrap();
    let guard = CodexHomeGuard::acquire(&paths, true, true, ClaimPolicy::Attach).unwrap();
    let snapshot = AttachRollbackSnapshot::capture(&guard, None).unwrap();
    apply_attach_or_sync(
        &guard,
        LINK_ID,
        KEY_ID,
        10100,
        br#"{"models":[{"slug":"home"}]}"#,
        &HomeCodexSettings {
            fast_mode: None,
            multi_agent_mode: None,
            web_search_sidecar_enabled: true,
            subagent_defaults: None,
        },
    )
    .unwrap();
    drop(snapshot);
    drop(guard);
    assert!(paths.rollback_file.is_file());
    (paths, original)
}

fn detach_through_swap(
    paths: &ChildPaths,
    barrier: &Barrier,
    point: &str,
    saved: &Path,
) -> (Output, BTreeMap<String, Vec<u8>>) {
    let mut cmd = child_command(&paths.opencodex_home, &paths.codex_home, 0, &["detach"]);
    cmd.stdin(Stdio::null());
    barrier.apply(&mut cmd, point);
    let child = cmd.spawn().unwrap();
    assert!(
        barrier.wait_reached(point, Duration::from_secs(20)),
        "detach never reached {point}"
    );
    let sentinels = swap_in_sentinel_home(&paths.codex_home, saved);
    barrier.release(point);
    (child.wait_with_output().unwrap(), sentinels)
}

#[cfg(unix)]
#[test]
fn crash_recovery_rechecks_codex_home_identity_before_each_restore_write() {
    let scratch = Scratch::new("recover-pre-write");
    let (paths, _) = crashed_attach_fixture(&scratch);
    let barrier = Barrier::new(&scratch.0, "pre");
    let saved = scratch.0.join("saved-codex");
    let saved_before = snapshot_dir(&paths.codex_home);
    let (out, sentinels) = detach_through_swap(&paths, &barrier, "restore-before-write", &saved);
    assert!(
        !out.status.success(),
        "detach wrote into a replaced home: {}",
        text(&out)
    );
    assert_same_files(
        &snapshot_dir(&paths.codex_home),
        &sentinels,
        "sentinel files were touched",
    );
    assert_same_files(
        &without_owner_record(snapshot_dir(&saved)),
        &without_owner_record(saved_before),
        "original home changed after the swap",
    );
    assert!(
        saved.join(".ocx-child-owner.json").is_file(),
        "ownership was released"
    );
    assert!(paths.rollback_file.is_file(), "rollback record was removed");
    assert!(paths.journal_file.is_file(), "journal was removed");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("recovery records were kept"),
        "missing recovery error: {}",
        text(&out)
    );
}

#[cfg(unix)]
#[test]
fn crash_recovery_keeps_records_when_the_home_changes_after_a_restore_write() {
    let scratch = Scratch::new("recover-post-write");
    let (paths, original) = crashed_attach_fixture(&scratch);
    let barrier = Barrier::new(&scratch.0, "post");
    let saved = scratch.0.join("saved-codex");
    let (out, sentinels) = detach_through_swap(&paths, &barrier, "restore-after-write", &saved);
    assert!(
        !out.status.success(),
        "detach finished in a replaced home: {}",
        text(&out)
    );
    assert_same_files(
        &snapshot_dir(&paths.codex_home),
        &sentinels,
        "sentinel files were touched",
    );
    // The one write that completed before the swap landed in the original directory.
    assert_eq!(fs::read(saved.join("config.toml")).unwrap(), original);
    assert!(paths.rollback_file.is_file(), "rollback record was removed");
    assert!(paths.journal_file.is_file(), "journal was removed");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("recovery records were kept"),
        "missing recovery error: {}",
        text(&out)
    );
}

#[cfg(unix)]
#[test]
fn offline_detach_rechecks_codex_home_identity_before_each_restore_write() {
    let scratch = Scratch::new("detach-pre-write");
    let paths = ChildPaths::new(scratch.0.join("ocx"), scratch.0.join("codex"));
    fs::create_dir_all(&paths.opencodex_home).unwrap();
    fs::create_dir_all(&paths.codex_home).unwrap();
    fs::write(
        paths.codex_config_path(),
        b"approval_policy = 'on-request'\n",
    )
    .unwrap();
    let home = MockHomeServer::start(&raw_token(), KEY_ID, LINK_ID);
    let tunnel = home.port.to_string();
    let port = distinct_port(&[]);
    let p = port.to_string();
    let mut args = attach_args(&tunnel, LINK_ID, &p);
    args.push("--no-daemon");
    let out = spawn_with_creds(child_command(
        &paths.opencodex_home,
        &paths.codex_home,
        port,
        &args,
    ))
    .wait_with_output()
    .unwrap();
    assert!(out.status.success(), "attach failed: {}", text(&out));

    let barrier = Barrier::new(&scratch.0, "detach");
    let saved = scratch.0.join("saved-codex");
    let saved_before = snapshot_dir(&paths.codex_home);
    let (out, sentinels) = detach_through_swap(&paths, &barrier, "restore-before-write", &saved);
    assert!(
        !out.status.success(),
        "detach wrote into a replaced home: {}",
        text(&out)
    );
    assert_same_files(
        &snapshot_dir(&paths.codex_home),
        &sentinels,
        "sentinel files were touched",
    );
    assert_same_files(
        &without_owner_record(snapshot_dir(&saved)),
        &without_owner_record(saved_before),
        "original home changed after the swap",
    );
    assert!(
        saved.join(".ocx-child-owner.json").is_file(),
        "ownership was released"
    );
    assert!(paths.journal_file.is_file(), "journal was removed");
    assert!(paths.key_file.is_file(), "link key was removed");
}

fn try_http_exchange(port: u16, raw_req: &str) -> Option<String> {
    use std::io::Read;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut sock = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    sock.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    sock.write_all(raw_req.as_bytes()).ok()?;
    let mut out = Vec::new();
    let _ = sock.read_to_end(&mut out);
    Some(String::from_utf8_lossy(&out).into_owned())
}

fn models_request(port: u16) -> String {
    format!("GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
}

/// Kills a leftover daemon if an assertion fails before the test cleans up.
struct KillOnDrop(Option<u32>);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if let Some(pid) = self.0
            && ocx_child::platform::process_is_alive(pid)
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
        }
    }
}

fn read_state(ocx: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(ocx.join("child").join("state.json")).unwrap()).unwrap()
}

#[cfg(unix)]
#[test]
fn daemon_exits_without_serving_when_its_parent_dies_before_commit() {
    use ocx_child::platform::process_is_alive;

    let scratch = Scratch::new("parent-crash");
    let ocx = scratch.0.join("ocx");
    let codex = scratch.0.join("codex");
    fs::create_dir_all(&ocx).unwrap();
    fs::create_dir_all(&codex).unwrap();
    let home = MockHomeServer::start(&raw_token(), KEY_ID, LINK_ID);
    let tunnel = home.port.to_string();
    let port = distinct_port(&[]);
    let p = port.to_string();
    let barrier = Barrier::new(&scratch.0, "commit");
    let mut cmd = child_command(&ocx, &codex, port, &attach_args(&tunnel, LINK_ID, &p));
    barrier.apply(&mut cmd, "daemon-before-commit");
    let mut parent = spawn_with_creds(cmd);
    assert!(
        barrier.wait_reached("daemon-before-commit", Duration::from_secs(20)),
        "attach never reached the commit point"
    );
    let pid = read_state(&ocx)["daemonPid"]
        .as_u64()
        .expect("daemon pid recorded") as u32;
    let mut leftover = KillOnDrop(Some(pid));
    assert!(process_is_alive(pid));

    parent.kill().unwrap();
    let _ = parent.wait();
    let relayed_before = home.state.observed_data_headers.lock().unwrap().len();
    let _ = try_http_exchange(port, &models_request(port));
    assert!(
        wait_until(Duration::from_secs(5), || !process_is_alive(pid)),
        "uncommitted daemon kept running after its parent died"
    );
    leftover.0 = None;
    assert_eq!(
        home.state.observed_data_headers.lock().unwrap().len(),
        relayed_before,
        "uncommitted daemon relayed a data request"
    );
    assert!(
        try_http_exchange(port, &models_request(port)).is_none_or(|r| r.is_empty()),
        "uncommitted daemon still answers after its parent died"
    );
    // The recorded attachment stays recoverable.
    let (code, _, err) = run_bin(&ocx, &codex, port, &["detach"], None);
    assert_eq!(code, 0, "detach after the parent crash failed: {err}");
}

#[cfg(unix)]
#[test]
fn attach_rollback_commits_the_restarted_prior_relay_only_after_removing_its_record() {
    let scratch = Scratch::new("rollback-restart");
    let ocx = scratch.0.join("ocx");
    let codex = scratch.0.join("codex");
    fs::create_dir_all(&ocx).unwrap();
    fs::create_dir_all(&codex).unwrap();
    let home = MockHomeServer::start(&raw_token(), KEY_ID, LINK_ID);
    let tunnel = home.port.to_string();
    let port = distinct_port(&[]);
    let p = port.to_string();
    let out = spawn_with_creds(child_command(
        &ocx,
        &codex,
        port,
        &attach_args(&tunnel, LINK_ID, &p),
    ))
    .wait_with_output()
    .unwrap();
    assert!(out.status.success(), "first attach failed: {}", text(&out));
    let prior_pid = read_state(&ocx)["daemonPid"].as_u64().unwrap() as u32;
    let _prior_leftover = KillOnDrop(Some(prior_pid));

    // Re-attach on another port. The prior relay is serving when the rollback snapshot is
    // taken and is stopped before the new daemon starts; the occupied new port then fails the
    // start, so rollback has to restart the prior relay.
    let new_port = distinct_port(&[port]);
    let np = new_port.to_string();
    let barrier = Barrier::new(&scratch.0, "rollback-restart");
    let mut cmd = child_command(&ocx, &codex, new_port, &attach_args(&tunnel, LINK_ID, &np));
    barrier.apply(&mut cmd, "attach-before-daemon-start,daemon-before-commit");
    let parent = spawn_with_creds(cmd);
    assert!(
        barrier.wait_reached("attach-before-daemon-start", Duration::from_secs(20)),
        "re-attach never reached the daemon start"
    );
    let blocker =
        std::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], new_port)))
            .expect("occupy the new listen port");
    barrier.release("attach-before-daemon-start");
    let reached_commit = barrier.wait_reached("daemon-before-commit", Duration::from_secs(20));
    let record_at_commit = ocx.join("child").join("attach-rollback.json").exists();
    let restarted_pid = read_state(&ocx)["daemonPid"].as_u64().map(|pid| pid as u32);
    let _restarted_leftover = KillOnDrop(restarted_pid);
    barrier.release("daemon-before-commit");
    let out = parent.wait_with_output().unwrap();
    drop(blocker);
    assert!(
        reached_commit,
        "rollback never restarted the prior relay: {}",
        text(&out)
    );
    assert!(
        !record_at_commit,
        "the restarted prior relay was committed while the rollback record still existed"
    );
    assert!(!out.status.success(), "re-attach unexpectedly succeeded");
    assert!(
        !ocx.join("child").join("attach-rollback.json").exists(),
        "rollback record left behind: {}",
        text(&out)
    );
    let healthz =
        format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    let health = try_http_exchange(port, &healthz).unwrap_or_default();
    assert!(
        health.contains("200 OK") && health.contains("\"generationCommitted\":true"),
        "prior relay not serving after rollback: {health} / {}",
        text(&out)
    );
    let (code, _, err) = run_bin(&ocx, &codex, port, &["detach"], None);
    assert_eq!(code, 0, "detach after rollback failed: {err}");
}

/// Starts `serve --foreground --lifecycle-start` the way a lifecycle parent does, with a
/// start line for `generation`.
fn spawn_lifecycle_serve(ocx: &Path, codex: &Path, port: u16, generation: &str) -> Child {
    let secret = read_state(ocx)["shutdownSecret"]
        .as_str()
        .unwrap()
        .to_owned();
    let p = port.to_string();
    let mut cmd = child_command(
        ocx,
        codex,
        port,
        &[
            "serve",
            "--foreground",
            "--lifecycle-start",
            "--listen-port",
            &p,
        ],
    );
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("ocx-child-start/1 {generation} {secret}\n").as_bytes())
        .unwrap();
    child
}

fn wait_exit(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let mut status = None;
    wait_until(timeout, || {
        status = child.try_wait().unwrap();
        status.is_some()
    });
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    status
}

fn set_state_generation(ocx: &Path, generation: Option<&str>) {
    let path = ocx.join("child").join("state.json");
    let mut state = read_state(ocx);
    match generation {
        Some(g) => state["daemonGeneration"] = serde_json::Value::String(g.to_owned()),
        None => {
            state.as_object_mut().unwrap().remove("daemonGeneration");
        }
    }
    fs::write(path, serde_json::to_vec_pretty(&state).unwrap()).unwrap();
}

#[cfg(unix)]
#[test]
fn lifecycle_start_requires_the_recorded_generation_and_a_commit() {
    let scratch = Scratch::new("generation");
    let ocx = scratch.0.join("ocx");
    let codex = scratch.0.join("codex");
    fs::create_dir_all(&ocx).unwrap();
    fs::create_dir_all(&codex).unwrap();
    let home = MockHomeServer::start(&raw_token(), KEY_ID, LINK_ID);
    let tunnel = home.port.to_string();
    let port = distinct_port(&[]);
    let p = port.to_string();
    let mut args = attach_args(&tunnel, LINK_ID, &p);
    args.push("--no-daemon");
    let out = spawn_with_creds(child_command(&ocx, &codex, port, &args))
        .wait_with_output()
        .unwrap();
    assert!(out.status.success(), "attach failed: {}", text(&out));
    let relayed = || home.state.observed_data_headers.lock().unwrap().len();
    let stale = "a".repeat(32);
    let current = "b".repeat(32);

    // A generation the state never recorded is refused even with a matching commit line.
    set_state_generation(&ocx, None);
    let before = relayed();
    let mut child = spawn_lifecycle_serve(&ocx, &codex, port, &stale);
    let _ = child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("commit {stale}\n").as_bytes());
    let _ = try_http_exchange(port, &models_request(port));
    let status = wait_exit(&mut child, Duration::from_secs(5));
    assert!(
        status.is_some_and(|s| !s.success()),
        "stale generation was not refused: {status:?}"
    );
    assert_eq!(relayed(), before, "stale generation relayed a request");

    // A superseded generation is refused once state records a newer one.
    set_state_generation(&ocx, Some(&current));
    let mut child = spawn_lifecycle_serve(&ocx, &codex, port, &stale);
    let _ = child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("commit {stale}\n").as_bytes());
    let status = wait_exit(&mut child, Duration::from_secs(5));
    assert!(
        status.is_some_and(|s| !s.success()),
        "superseded generation served"
    );

    // The recorded generation without a commit exits on EOF and never relays.
    let mut child = spawn_lifecycle_serve(&ocx, &codex, port, &current);
    assert!(wait_until(Duration::from_secs(5), || {
        try_http_exchange(
            port,
            &format!(
                "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            ),
        )
        .is_some_and(|r| r.contains("200 OK"))
    }));
    let before = relayed();
    let pending = try_http_exchange(port, &models_request(port)).unwrap_or_default();
    assert!(
        !pending.contains("404"),
        "uncommitted daemon relayed: {pending}"
    );
    assert_eq!(relayed(), before, "uncommitted daemon relayed a request");
    drop(child.stdin.take());
    let status = wait_exit(&mut child, Duration::from_secs(5));
    assert!(
        status.is_some_and(|s| !s.success()),
        "daemon without a commit did not exit: {status:?}"
    );

    // Positive control: the recorded generation plus its commit serves.
    let mut child = spawn_lifecycle_serve(&ocx, &codex, port, &current);
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("commit {current}\n").as_bytes())
        .unwrap();
    // Reap the daemon as soon as it exits, as init does for a detached daemon; otherwise
    // the exited process lingers as a zombie that still looks alive to detach.
    let reaper = std::thread::spawn(move || child.wait().unwrap());
    assert!(
        wait_until(Duration::from_secs(5), || {
            try_http_exchange(
                port,
                &format!(
                    "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
                ),
            )
            .is_some_and(|r| r.contains("\"generationCommitted\":true"))
        }),
        "committed daemon never reported its commit"
    );
    let before = relayed();
    let _ = try_http_exchange(port, &models_request(port));
    assert_eq!(relayed(), before + 1, "committed daemon did not relay");
    let (code, _, err) = run_bin(&ocx, &codex, port, &["detach"], None);
    assert_eq!(code, 0, "detach failed: {err}");
    assert!(reaper.join().unwrap().success());
}

/// Attach without a daemon, then run an operator foreground relay whose exit is reaped by a
/// background thread (as init reaps a detached daemon).
fn attached_foreground_relay(
    scratch: &Scratch,
    home: &MockHomeServer,
) -> (
    std::path::PathBuf,
    std::path::PathBuf,
    u16,
    std::thread::JoinHandle<std::process::ExitStatus>,
) {
    let ocx = scratch.0.join("ocx");
    let codex = scratch.0.join("codex");
    fs::create_dir_all(&ocx).unwrap();
    fs::create_dir_all(&codex).unwrap();
    let tunnel = home.port.to_string();
    let port = distinct_port(&[]);
    let p = port.to_string();
    let mut args = attach_args(&tunnel, LINK_ID, &p);
    args.push("--no-daemon");
    let out = spawn_with_creds(child_command(&ocx, &codex, port, &args))
        .wait_with_output()
        .unwrap();
    assert!(out.status.success(), "attach failed: {}", text(&out));
    let mut cmd = child_command(
        &ocx,
        &codex,
        port,
        &["serve", "--foreground", "--listen-port", &p],
    );
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().unwrap();
    let healthz =
        format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    assert!(
        wait_until(Duration::from_secs(5), || try_http_exchange(port, &healthz)
            .is_some_and(|r| r.contains("200 OK"))),
        "foreground relay never became healthy"
    );
    let reaper = std::thread::spawn(move || child.wait().unwrap());
    (ocx, codex, port, reaper)
}

fn join_within(
    reaper: std::thread::JoinHandle<std::process::ExitStatus>,
    timeout: Duration,
) -> bool {
    wait_until(timeout, || reaper.is_finished()) && reaper.join().is_ok()
}

#[cfg(unix)]
#[test]
fn detach_stops_a_relay_whose_parity_request_stalls_or_trickles() {
    for (mode, label) in [(1u8, "stall"), (2u8, "trickle")] {
        let scratch = Scratch::new(&format!("parity-{label}"));
        let home = MockHomeServer::start(&raw_token(), KEY_ID, LINK_ID);
        home.state
            .parity_mode
            .store(mode, std::sync::atomic::Ordering::SeqCst);
        let (ocx, codex, port, reaper) = attached_foreground_relay(&scratch, &home);
        assert!(
            wait_until(Duration::from_secs(10), || home
                .state
                .parity_stalled
                .load(std::sync::atomic::Ordering::SeqCst)
                > 0),
            "{label}: relay never sent a parity report"
        );
        let started = std::time::Instant::now();
        let (code, _, err) = run_bin(&ocx, &codex, port, &["detach"], None);
        let elapsed = started.elapsed();
        assert_eq!(code, 0, "{label}: detach failed after {elapsed:?}: {err}");
        assert!(
            elapsed < Duration::from_secs(4),
            "{label}: detach took {elapsed:?}"
        );
        assert!(
            join_within(reaper, Duration::from_secs(2)),
            "{label}: relay process still running after detach"
        );
    }
}

#[cfg(unix)]
#[test]
fn detach_stops_a_relay_whose_workers_are_all_busy() {
    let scratch = Scratch::new("saturated");
    let home = MockHomeServer::start(&raw_token(), KEY_ID, LINK_ID);
    let (ocx, codex, port, reaper) = attached_foreground_relay(&scratch, &home);
    // Every worker blocks reading a request head that never completes.
    let mut idle = Vec::new();
    for _ in 0..40 {
        let mut sock =
            std::net::TcpStream::connect(std::net::SocketAddr::from(([127, 0, 0, 1], port)))
                .unwrap();
        sock.write_all(b"GET /healthz HTTP/1.1\r\n").unwrap();
        idle.push(sock);
    }
    std::thread::sleep(Duration::from_millis(300));
    let started = std::time::Instant::now();
    let (code, _, err) = run_bin(&ocx, &codex, port, &["detach"], None);
    let elapsed = started.elapsed();
    assert_eq!(code, 0, "detach failed after {elapsed:?}: {err}");
    assert!(elapsed < Duration::from_secs(4), "detach took {elapsed:?}");
    assert!(
        join_within(reaper, Duration::from_secs(2)),
        "relay process still running after detach"
    );
    drop(idle);
}

#[cfg(unix)]
#[test]
fn control_connections_that_trickle_their_request_head_are_cut_off() {
    use std::io::Read;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let scratch = Scratch::new("control-trickle");
    let home = MockHomeServer::start(&raw_token(), KEY_ID, LINK_ID);
    let (ocx, codex, port, reaper) = attached_foreground_relay(&scratch, &home);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    // Every worker blocks reading a request head that never completes.
    let mut idle = Vec::new();
    for _ in 0..40 {
        let mut sock = std::net::TcpStream::connect(addr).unwrap();
        sock.write_all(b"GET /healthz HTTP/1.1\r\n").unwrap();
        idle.push(sock);
    }
    std::thread::sleep(Duration::from_millis(300));
    // Fill every control slot with a sender that writes one header byte every 300 ms, inside
    // the per-read timeout, and record when the relay closes each connection.
    let started = std::time::Instant::now();
    let closed = Arc::new(AtomicUsize::new(0));
    let mut senders = Vec::new();
    for _ in 0..256 {
        let closed = Arc::clone(&closed);
        senders.push(std::thread::spawn(move || {
            let Ok(mut sock) = std::net::TcpStream::connect(addr) else {
                closed.fetch_add(1, Ordering::SeqCst);
                return;
            };
            let _ = sock.set_read_timeout(Some(Duration::from_millis(300)));
            let mut head = b"GET /healthz HTTP/1.1\r\nx-slow: "
                .iter()
                .copied()
                .chain(std::iter::repeat(b'a'));
            let mut buf = [0u8; 256];
            while started.elapsed() < Duration::from_secs(8) {
                let byte = [head.next().unwrap()];
                if sock.write_all(&byte).is_err() {
                    break;
                }
                match sock.read(&mut buf) {
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    _ => break,
                }
            }
            if started.elapsed() < Duration::from_secs(8) {
                closed.fetch_add(1, Ordering::SeqCst);
            }
        }));
    }
    let all_cut = wait_until(Duration::from_millis(4_500), || {
        closed.load(Ordering::SeqCst) == 256
    });
    let cut_count = closed.load(Ordering::SeqCst);
    let detach_started = std::time::Instant::now();
    let (code, _, err) = run_bin(&ocx, &codex, port, &["detach"], None);
    let elapsed = detach_started.elapsed();
    for sender in senders {
        let _ = sender.join();
    }
    assert!(
        all_cut,
        "only {cut_count} of 256 trickling control connections were closed within 4.5 s"
    );
    assert_eq!(code, 0, "detach failed after {elapsed:?}: {err}");
    assert!(elapsed < Duration::from_secs(4), "detach took {elapsed:?}");
    assert!(
        join_within(reaper, Duration::from_secs(2)),
        "relay process still running after detach"
    );
    drop(idle);
}

#[cfg(unix)]
#[test]
fn lock_open_refuses_a_symlink_swapped_in_after_the_symlink_check() {
    let scratch = Scratch::new("lock-symlink");
    let ocx = scratch.0.join("ocx");
    let codex = scratch.0.join("codex");
    fs::create_dir_all(&ocx).unwrap();
    fs::create_dir_all(&codex).unwrap();
    let lock = ocx.join("child.lock");
    let target = scratch.0.join("outside-target");
    let barrier = Barrier::new(&scratch.0, "lock-open");
    let mut cmd = child_command(&ocx, &codex, distinct_port(&[]), &["detach"]);
    cmd.stdin(Stdio::null());
    barrier.apply(&mut cmd, "lock-before-open");
    let child = cmd.spawn().unwrap();
    assert!(
        barrier.wait_reached("lock-before-open", Duration::from_secs(20)),
        "detach never reached the lock open"
    );
    let _ = fs::remove_file(&lock);
    std::os::unix::fs::symlink(&target, &lock).unwrap();
    barrier.release("lock-before-open");
    let out = child.wait_with_output().unwrap();
    assert!(
        !target.exists(),
        "the lock open followed a symlink and created {}: {}",
        target.display(),
        text(&out)
    );
    assert!(
        !out.status.success(),
        "detach ran without its lock: {}",
        text(&out)
    );
    assert!(
        fs::symlink_metadata(&lock)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
