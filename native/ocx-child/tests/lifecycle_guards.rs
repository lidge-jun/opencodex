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

use ocx_child::daemon::pick_ephemeral_link_port;

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
    assert_eq!(
        snapshot_dir(&codex),
        before,
        "B changed shared files while A held them"
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
    assert_eq!(
        snapshot_dir(&codex),
        after_a,
        "refused attach B changed shared files"
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
