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
