#![deny(unsafe_op_in_unsafe_fn)]
//! Process-level coverage for the link id in the CODEX_HOME ownership record
//! (ocx.child.codex-home-owner/2) and for detach --expect-link, which restores a Child only
//! when both its state and its ownership record name the expected link.

mod common;
use common::*;

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::Duration;

use ocx_child::platform::{FileLock, LockAcquireError};

const LINK_A: &str = "lnk_0123456789abcdef";
const LINK_B: &str = "lnk_fedcba9876543210";
const KEY_ID: &str = "link:rust-test";
const ORIGINAL_CONFIG: &[u8] = b"approval_policy = 'on-request'\n";

fn raw_token() -> String {
    format!("ocx_data_{}", "a".repeat(40))
}

fn creds_json() -> String {
    format!(r#"{{"apiKeyId":"{KEY_ID}","key":"{}"}}"#, raw_token())
}

struct Homes {
    scratch: Scratch,
    ocx: PathBuf,
    codex: PathBuf,
    port: u16,
}

impl Homes {
    fn new(label: &str) -> Self {
        let scratch = Scratch::new(label);
        let ocx = scratch.0.join("ocx");
        let codex = scratch.0.join("codex");
        fs::create_dir_all(&ocx).unwrap();
        fs::create_dir_all(&codex).unwrap();
        fs::write(codex.join("config.toml"), ORIGINAL_CONFIG).unwrap();
        let port = ocx_child::daemon::pick_ephemeral_link_port().unwrap();
        Self {
            scratch,
            ocx,
            codex,
            port,
        }
    }

    fn owner_path(&self) -> PathBuf {
        self.codex.join(".ocx-child-owner.json")
    }

    fn state_path(&self) -> PathBuf {
        self.ocx.join("child").join("state.json")
    }

    fn owner(&self) -> serde_json::Value {
        serde_json::from_slice(&fs::read(self.owner_path()).unwrap()).unwrap()
    }

    fn write_owner(&self, value: &serde_json::Value) {
        fs::write(self.owner_path(), serde_json::to_vec_pretty(value).unwrap()).unwrap();
    }

    fn attach_command(&self, home: &MockHomeServer, link: &str) -> std::process::Command {
        let tunnel = home.port.to_string();
        let listen = self.port.to_string();
        let mut args = attach_args(&tunnel, link, &listen);
        args.push("--no-daemon");
        child_command(&self.ocx, &self.codex, self.port, &args)
    }

    fn attach(&self, link: &str) -> MockHomeServer {
        let home = MockHomeServer::start(&raw_token(), KEY_ID, link);
        let out = spawn_with_creds(self.attach_command(&home, link))
            .wait_with_output()
            .unwrap();
        assert!(
            out.status.success(),
            "attach failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        home
    }

    fn detach_expect(&self, link: &str) -> (i32, serde_json::Value, String) {
        let (code, stdout, stderr) = run_bin(
            &self.ocx,
            &self.codex,
            self.port,
            &["detach", "--purge", "--json", "--expect-link", link],
            None,
        );
        let line = stdout
            .lines()
            .rev()
            .find(|l| l.trim_start().starts_with('{'));
        let report = line
            .and_then(|l| serde_json::from_str(l).ok())
            .unwrap_or(serde_json::Value::Null);
        (code, report, stderr)
    }

    /// Every regular file under both homes except the two never-deleted lock files.
    fn snapshot(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut out = BTreeMap::new();
        collect(&self.scratch.0, &mut out);
        out
    }
}

fn collect(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries {
        let entry = entry.unwrap();
        let path = entry.path();
        let kind = entry.file_type().unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        if kind.is_dir() {
            if !name.starts_with("barrier-") {
                collect(&path, out);
            }
        } else if kind.is_file() && name != ".ocx-child.lock" && name != "child.lock" {
            out.insert(path, fs::read(entry.path()).unwrap());
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

fn assert_refused_untouched(
    homes: &Homes,
    link: &str,
    expected_code: i32,
    expected_outcome: &str,
) -> serde_json::Value {
    let before = homes.snapshot();
    let (code, report, stderr) = homes.detach_expect(link);
    assert_eq!(code, expected_code, "report={report} stderr={stderr}");
    assert_eq!(report["outcome"], expected_outcome, "report={report}");
    assert_eq!(report["linkId"], link, "report={report}");
    assert_eq!(report["restored"], false, "report={report}");
    assert!(
        homes.snapshot() == before,
        "a refused detach --expect-link changed files"
    );
    report
}

#[test]
fn attach_records_its_link_id_in_the_owner_record_before_any_codex_home_write() {
    let homes = Homes::new("owner-link-attach");
    let home = MockHomeServer::start(&raw_token(), KEY_ID, LINK_A);
    let barrier = Barrier::new(&homes.scratch.0, "attach");
    let mut cmd = homes.attach_command(&home, LINK_A);
    barrier.apply(&mut cmd, "attach-protected");
    let child = spawn_with_creds(cmd);
    assert!(
        barrier.wait_reached("attach-protected", Duration::from_secs(20)),
        "attach never entered its protected section"
    );
    let owner = homes.owner();
    assert_eq!(owner["schema"], "ocx.child.codex-home-owner/2");
    assert_eq!(owner["linkId"], LINK_A);
    assert_eq!(owner["phase"], "attaching");
    assert_eq!(
        fs::read(homes.codex.join("config.toml")).unwrap(),
        ORIGINAL_CONFIG,
        "Codex home was written before the owner record named the link"
    );
    barrier.release("attach-protected");
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "attach failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let owner = homes.owner();
    assert_eq!(owner["schema"], "ocx.child.codex-home-owner/2");
    assert_eq!(owner["linkId"], LINK_A);
    assert_eq!(owner["phase"], "attached");

    // A later attach of the same Child for another link names that link before it writes.
    drop(home);
    let _home_b = homes.attach(LINK_B);
    assert_eq!(homes.owner()["linkId"], LINK_B);
    let (code, _, err) = run_bin(&homes.ocx, &homes.codex, homes.port, &["detach"], None);
    assert_eq!(code, 0, "detach failed: {err}");
    assert!(!homes.owner_path().exists());
}

#[test]
fn detach_expect_link_restores_when_state_and_owner_record_name_the_link() {
    let homes = Homes::new("owner-link-restore");
    let _home = homes.attach(LINK_A);
    let (code, report, stderr) = homes.detach_expect(LINK_A);
    assert_eq!(code, 0, "report={report} stderr={stderr}");
    assert_eq!(report["restored"], true);
    assert_eq!(report["linkId"], LINK_A);
    assert_eq!(report["daemonRunning"], false);
    // The test binary lives outside the managed plant directory, so nothing is purged.
    assert_eq!(report["purged"], false);
    assert_eq!(
        fs::read(homes.codex.join("config.toml")).unwrap(),
        ORIGINAL_CONFIG
    );
    assert!(!homes.owner_path().exists());
    assert!(!homes.state_path().exists());
}

#[test]
fn detach_expect_link_on_a_clean_child_reports_nothing_to_restore() {
    let homes = Homes::new("owner-link-clean");
    let (code, report, stderr) = homes.detach_expect(LINK_A);
    assert_eq!(code, 0, "report={report} stderr={stderr}");
    assert_eq!(report["restored"], true);
    assert_eq!(report["outcome"], "NotAttached");
    assert_eq!(report["linkId"], LINK_A);
}

#[test]
fn detach_expect_link_refuses_a_child_linked_to_another_link() {
    let homes = Homes::new("owner-link-other");
    let _home = homes.attach(LINK_B);
    let report = assert_refused_untouched(&homes, LINK_A, 5, "conflict");
    assert_eq!(report["purged"], false);
    // The owner's own link still detaches normally afterwards.
    let (code, _, err) = homes.detach_expect(LINK_B);
    assert_eq!(code, 0, "{err}");
}

#[test]
fn detach_expect_link_refuses_a_state_naming_another_link() {
    let homes = Homes::new("owner-link-state-other");
    let _home = homes.attach(LINK_A);
    let mut owner = homes.owner();
    owner["linkId"] = serde_json::Value::String(LINK_B.to_owned());
    homes.write_owner(&owner);
    assert_refused_untouched(&homes, LINK_B, 5, "conflict");
}

#[test]
fn detach_expect_link_answers_residual_for_a_version_one_owner_record() {
    let homes = Homes::new("owner-link-v1");
    let _home = homes.attach(LINK_A);
    let mut owner = homes.owner();
    owner["schema"] = serde_json::Value::String("ocx.child.codex-home-owner/1".to_owned());
    owner.as_object_mut().unwrap().remove("linkId");
    homes.write_owner(&owner);
    let report = assert_refused_untouched(&homes, LINK_A, 6, "residual");
    assert_eq!(report["record"], "codex-home-owner");
    // A current build also writes /1 when it adopts a pre-ownership attachment, so the reason names no build.
    assert_eq!(
        report["reason"],
        "the ownership record names no link (schema /1)"
    );
    assert!(
        report["path"]
            .as_str()
            .is_some_and(|p| p.ends_with(".ocx-child-owner.json")),
        "report={report}"
    );
}

#[test]
fn detach_expect_link_answers_residual_when_state_is_missing_but_the_owner_record_remains() {
    let homes = Homes::new("owner-link-no-state");
    let _home = homes.attach(LINK_A);
    fs::remove_file(homes.state_path()).unwrap();
    let report = assert_refused_untouched(&homes, LINK_A, 6, "residual");
    assert_eq!(report["record"], "codex-home-owner");
}

#[test]
fn detach_expect_link_finishes_a_detach_of_that_link_interrupted_after_the_state_went() {
    // A detach marks the owner record detaching, then removes state.json before it releases the
    // record; interrupted there, a plain detach finishes it, and so does the bound one.
    let homes = Homes::new("owner-link-detach-resume");
    let _home = homes.attach(LINK_A);
    let mut owner = homes.owner();
    owner["phase"] = serde_json::Value::String("detaching".to_owned());
    homes.write_owner(&owner);
    fs::remove_file(homes.state_path()).unwrap();
    let (code, report, stderr) = homes.detach_expect(LINK_A);
    assert_eq!(code, 0, "report={report} stderr={stderr}");
    assert_eq!(report["linkId"], LINK_A);
    assert_eq!(
        fs::read(homes.codex.join("config.toml")).unwrap(),
        ORIGINAL_CONFIG
    );
    assert!(!homes.owner_path().exists());
}

#[test]
fn detach_expect_link_does_not_finish_another_links_interrupted_detach() {
    let homes = Homes::new("owner-link-detach-other");
    let _home = homes.attach(LINK_A);
    let mut owner = homes.owner();
    owner["phase"] = serde_json::Value::String("detaching".to_owned());
    homes.write_owner(&owner);
    fs::remove_file(homes.state_path()).unwrap();
    assert_refused_untouched(&homes, LINK_B, 5, "conflict");
}

#[test]
fn detach_expect_link_answers_conflict_for_an_unreadable_owner_record() {
    let homes = Homes::new("owner-link-corrupt");
    let _home = homes.attach(LINK_A);
    fs::write(homes.owner_path(), b"{not json").unwrap();
    assert_refused_untouched(&homes, LINK_A, 5, "conflict");
}

#[test]
fn detach_expect_link_answers_conflict_for_another_opencodex_home() {
    let homes = Homes::new("owner-link-foreign");
    let _home = homes.attach(LINK_A);
    let other_ocx = homes.scratch.0.join("ocx-other");
    fs::create_dir_all(&other_ocx).unwrap();
    let before = homes.snapshot();
    let (code, stdout, stderr) = run_bin(
        &other_ocx,
        &homes.codex,
        homes.port,
        &["detach", "--purge", "--json", "--expect-link", LINK_A],
        None,
    );
    assert_eq!(code, 5, "stdout={stdout} stderr={stderr}");
    let report: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(report["outcome"], "conflict");
    assert!(
        homes.snapshot() == before,
        "the foreign detach changed files"
    );
}

#[test]
fn detach_expect_link_holds_both_locks_from_its_check_through_the_restore() {
    let homes = Homes::new("owner-link-locks");
    let _home = homes.attach(LINK_A);
    let barrier = Barrier::new(&homes.scratch.0, "detach");
    let mut cmd = child_command(
        &homes.ocx,
        &homes.codex,
        homes.port,
        &["detach", "--purge", "--json", "--expect-link", LINK_A],
    );
    barrier.apply(&mut cmd, "expect-link-checked");
    cmd.stdin(Stdio::null());
    let child = cmd.spawn().unwrap();
    assert!(
        barrier.wait_reached("expect-link-checked", Duration::from_secs(20)),
        "detach never reached its link check"
    );
    // A competing attach or sync needs both locks; neither can be taken here.
    let local = FileLock::try_acquire_nonblocking(&homes.ocx.join("child.lock"));
    let codex = FileLock::acquire_in_existing_dir(&homes.codex.join(".ocx-child.lock"), false);
    let local_busy = matches!(local, Err(LockAcquireError::Busy));
    let codex_busy = matches!(codex, Err(LockAcquireError::Busy));
    drop(local);
    drop(codex);
    barrier.release("expect-link-checked");
    let out = child.wait_with_output().unwrap();
    assert!(
        local_busy,
        "the lifecycle lock was free between check and restore"
    );
    assert!(
        codex_busy,
        "the CODEX_HOME lock was free between check and restore"
    );
    assert!(
        out.status.success(),
        "detach failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!homes.owner_path().exists());
}

#[test]
fn a_refused_attach_puts_back_the_owner_record_it_replaced() {
    let homes = Homes::new("owner-link-revert");
    let _home = homes.attach(LINK_A);
    let before = homes.owner();
    // The listen port is taken by something other than our daemon, so attach refuses before
    // writing anything and must restore the record naming the first link.
    let held = std::net::TcpListener::bind(("127.0.0.1", homes.port)).unwrap();
    let home_b = MockHomeServer::start(&raw_token(), KEY_ID, LINK_B);
    let out = spawn_with_creds(homes.attach_command(&home_b, LINK_B))
        .wait_with_output()
        .unwrap();
    drop(held);
    assert!(!out.status.success(), "attach over a busy port succeeded");
    assert_eq!(homes.owner(), before);
    let (code, _, err) = homes.detach_expect(LINK_A);
    assert_eq!(code, 0, "{err}");
}

#[test]
fn an_owner_record_whose_link_id_does_not_match_its_schema_is_unreadable() {
    let homes = Homes::new("owner-link-schema");
    let _home = homes.attach(LINK_A);
    let mut owner = homes.owner();
    owner.as_object_mut().unwrap().remove("linkId");
    homes.write_owner(&owner);
    assert_refused_untouched(&homes, LINK_A, 5, "conflict");
    let mut owner = homes.owner();
    owner["schema"] = serde_json::Value::String("ocx.child.codex-home-owner/1".to_owned());
    owner["linkId"] = serde_json::Value::String(LINK_A.to_owned());
    homes.write_owner(&owner);
    assert_refused_untouched(&homes, LINK_A, 5, "conflict");
}

fn attach_until_barrier(homes: &Homes, link: &str, barrier_name: &str, start_daemon: bool) {
    let home = MockHomeServer::start(&raw_token(), KEY_ID, link);
    let tunnel = home.port.to_string();
    let listen = homes.port.to_string();
    let mut args = attach_args(&tunnel, link, &listen);
    if !start_daemon {
        args.push("--no-daemon");
    }
    let mut cmd = child_command(&homes.ocx, &homes.codex, homes.port, &args);
    let barrier = Barrier::new(&homes.scratch.0, &format!("crash-{link}"));
    barrier.apply(&mut cmd, barrier_name);
    let mut child = spawn_with_creds(cmd);
    assert!(
        barrier.wait_reached(barrier_name, Duration::from_secs(20)),
        "attach never reached {barrier_name}"
    );
    // A crash at this point: the process is gone, its records stay.
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn an_attach_interrupted_before_it_wrote_anything_leaves_both_links_residual() {
    let homes = Homes::new("owner-link-reattach-early");
    let _home = homes.attach(LINK_A);
    attach_until_barrier(&homes, LINK_B, "attach-protected", false);
    assert_eq!(homes.owner()["linkId"], LINK_B);
    assert_eq!(homes.owner()["phase"], "attaching");
    assert_refused_untouched(&homes, LINK_A, 6, "residual");
    assert_refused_untouched(&homes, LINK_B, 6, "residual");
    // The owner's plain detach still finishes it.
    let (code, _, err) = run_bin(&homes.ocx, &homes.codex, homes.port, &["detach"], None);
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        fs::read(homes.codex.join("config.toml")).unwrap(),
        ORIGINAL_CONFIG
    );
}

#[test]
fn detach_expect_link_finishes_its_own_attach_interrupted_before_any_write() {
    // A first attach of A on a machine with no link, stopped right after it wrote the owner record (phase attaching): no
    // other link is involved, so the bound detach finishes it as a plain detach would.
    let homes = Homes::new("owner-link-own-attach-early");
    attach_until_barrier(&homes, LINK_A, "attach-protected", false);
    assert_eq!(homes.owner()["phase"], "attaching");
    assert!(!homes.state_path().exists());
    // Another link's bound detach still changes nothing.
    assert_refused_untouched(&homes, LINK_B, 5, "conflict");
    let (code, report, stderr) = homes.detach_expect(LINK_A);
    assert_eq!(code, 0, "report={report} stderr={stderr}");
    assert_eq!(report["linkId"], LINK_A);
    assert_eq!(
        fs::read(homes.codex.join("config.toml")).unwrap(),
        ORIGINAL_CONFIG
    );
    assert!(!homes.owner_path().exists());
}

#[test]
fn detach_expect_link_finishes_its_own_attach_interrupted_before_the_state_write() {
    // Stopped after the attach changed CODEX_HOME and left its rollback snapshot (which names no prior link), before it
    // wrote the state: the bound detach restores the snapshot and releases the record.
    let homes = Homes::new("owner-link-own-attach-late");
    attach_until_barrier(&homes, LINK_A, "attach-before-state-write", false);
    assert_eq!(homes.owner()["phase"], "attaching");
    assert!(!homes.state_path().exists());
    let rollback = homes.ocx.join("child").join("attach-rollback.json");
    assert!(rollback.exists());
    assert_ne!(
        fs::read(homes.codex.join("config.toml")).unwrap(),
        ORIGINAL_CONFIG
    );
    let (code, report, stderr) = homes.detach_expect(LINK_A);
    assert_eq!(code, 0, "report={report} stderr={stderr}");
    assert_eq!(report["linkId"], LINK_A);
    assert_eq!(
        fs::read(homes.codex.join("config.toml")).unwrap(),
        ORIGINAL_CONFIG
    );
    assert!(!homes.owner_path().exists());
    assert!(!rollback.exists());
}

#[test]
fn detach_expect_link_finishes_its_own_detach_killed_while_it_restored_an_interrupted_attach() {
    // The attach of A stopped before its state write, leaving its rollback (which names no prior link). A bound detach of A
    // marks the record detaching, then dies while it restores that rollback: the record says detaching and the rollback
    // is still there. Nothing names another link, so the next bound detach of A finishes it.
    let homes = Homes::new("owner-link-own-attach-detach-killed");
    attach_until_barrier(&homes, LINK_A, "attach-before-state-write", false);
    let rollback = homes.ocx.join("child").join("attach-rollback.json");
    assert!(rollback.exists());
    let mut cmd = child_command(
        &homes.ocx,
        &homes.codex,
        homes.port,
        &["detach", "--purge", "--json", "--expect-link", LINK_A],
    );
    let barrier = Barrier::new(&homes.scratch.0, "detach-killed");
    barrier.apply(&mut cmd, "restore-before-write");
    let mut child = spawn_with_creds(cmd);
    assert!(
        barrier.wait_reached("restore-before-write", Duration::from_secs(20)),
        "detach never reached restore-before-write"
    );
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(homes.owner()["phase"], "detaching");
    assert_eq!(homes.owner()["linkId"], LINK_A);
    assert!(rollback.exists());
    assert!(!homes.state_path().exists());
    let (code, report, stderr) = homes.detach_expect(LINK_A);
    assert_eq!(code, 0, "report={report} stderr={stderr}");
    assert_eq!(report["linkId"], LINK_A);
    assert_eq!(
        fs::read(homes.codex.join("config.toml")).unwrap(),
        ORIGINAL_CONFIG
    );
    assert!(!homes.owner_path().exists());
    assert!(!rollback.exists());
}

#[test]
fn a_reattach_interrupted_after_its_state_write_never_restores_the_previous_link() {
    let homes = Homes::new("owner-link-reattach-late");
    let _home = homes.attach(LINK_A);
    attach_until_barrier(&homes, LINK_B, "attach-before-daemon-start", true);
    // State and owner record already name B, but the rollback would put back A.
    assert!(
        homes
            .ocx
            .join("child")
            .join("attach-rollback.json")
            .exists()
    );
    let report = assert_refused_untouched(&homes, LINK_B, 6, "residual");
    assert_eq!(report["record"], "attach-rollback");
    assert_refused_untouched(&homes, LINK_A, 6, "residual");
    assert_refused_untouched(&homes, "lnk_00000000000000aa", 5, "conflict");
}

#[test]
fn an_attach_over_an_unreadable_state_never_restores_the_files_it_snapshotted() {
    let homes = Homes::new("owner-link-unreadable-prior");
    let _home = homes.attach(LINK_B);
    // Attach reads this as no prior state, yet its rollback snapshot keeps B's files.
    fs::write(homes.state_path(), b"{not json").unwrap();
    attach_until_barrier(&homes, LINK_A, "attach-before-daemon-start", true);
    assert_eq!(homes.owner()["linkId"], LINK_A);
    let report = assert_refused_untouched(&homes, LINK_A, 5, "conflict");
    assert_eq!(report["record"], "attach-rollback");
}

#[cfg(unix)]
#[test]
fn purge_removes_the_planted_binary_while_the_lifecycle_lock_is_held() {
    let homes = Homes::new("owner-link-purge-lock");
    let fake_home = homes.scratch.0.join("home");
    let bin_dir = fake_home.join(".cache").join("opencodex").join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let planted = bin_dir.join("ocx-child");
    fs::copy(env!("CARGO_BIN_EXE_ocx-child"), &planted).unwrap();
    let _home = homes.attach(LINK_A);
    let barrier = Barrier::new(&homes.scratch.0, "purge");
    let mut cmd = std::process::Command::new(&planted);
    cmd.args(["detach", "--purge", "--json", "--expect-link", LINK_A])
        .env("HOME", &fake_home)
        .env("OPENCODEX_HOME", &homes.ocx)
        .env("CODEX_HOME", &homes.codex)
        .env("OCX_CHILD_LISTEN_PORT", homes.port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    barrier.apply(&mut cmd, "purge-before-remove");
    let child = cmd.spawn().unwrap();
    assert!(
        barrier.wait_reached("purge-before-remove", Duration::from_secs(20)),
        "detach never reached the purge"
    );
    let local = FileLock::try_acquire_nonblocking(&homes.ocx.join("child.lock"));
    let busy = matches!(local, Err(LockAcquireError::Busy));
    drop(local);
    barrier.release("purge-before-remove");
    let out = child.wait_with_output().unwrap();
    assert!(
        busy,
        "an attach could take the lifecycle lock before the purge"
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("\"purged\":true"));
    assert!(!planted.exists());
    assert_eq!(
        receipt(&homes, LINK_A).expect("no receipt")["restored"],
        true
    );
}

fn receipt(homes: &Homes, link: &str) -> Option<serde_json::Value> {
    fs::read(homes.ocx.join("link-receipts").join(format!("{link}.json")))
        .ok()
        .map(|bytes| serde_json::from_slice(&bytes).unwrap())
}

#[test]
fn a_restore_for_the_expected_link_leaves_a_durable_receipt_naming_it() {
    let homes = Homes::new("owner-link-receipt");
    let _home = homes.attach(LINK_A);
    let (code, _, err) = homes.detach_expect(LINK_A);
    assert_eq!(code, 0, "{err}");
    let found = receipt(&homes, LINK_A).expect("no receipt");
    assert_eq!(found["schema"], "ocx.child.detach-receipt/1");
    assert_eq!(found["linkId"], LINK_A);
    assert_eq!(found["restored"], true);
    // It records the restore only; whether the binary is gone is read from the binary.
    assert!(found.get("purged").is_none());
    assert!(receipt(&homes, LINK_B).is_none());
    // A plain detach writes none.
    let other = Homes::new("owner-link-receipt-plain");
    let _home = other.attach(LINK_A);
    let (code, _, err) = run_bin(&other.ocx, &other.codex, other.port, &["detach"], None);
    assert_eq!(code, 0, "{err}");
    assert!(receipt(&other, LINK_A).is_none());
}

#[test]
fn a_clean_child_records_a_receipt_for_the_expected_link() {
    let homes = Homes::new("owner-link-receipt-clean");
    let (code, _, err) = homes.detach_expect(LINK_A);
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        receipt(&homes, LINK_A).expect("no receipt")["outcome"],
        "NotAttached"
    );
}

#[test]
fn a_rollback_snapshot_recovery_would_refuse_is_refused_before_anything_changes() {
    let homes = Homes::new("owner-link-bad-rollback");
    let _home = homes.attach(LINK_A);
    fs::write(
        homes.ocx.join("child").join("attach-rollback.json"),
        br#"{"priorState":null}"#,
    )
    .unwrap();
    let report = assert_refused_untouched(&homes, LINK_A, 5, "conflict");
    assert_eq!(report["record"], "attach-rollback");
}

#[test]
fn a_new_attach_of_the_same_link_removes_its_old_receipt() {
    let homes = Homes::new("owner-link-receipt-reattach");
    let _home = homes.attach(LINK_A);
    let (code, _, err) = homes.detach_expect(LINK_A);
    assert_eq!(code, 0, "{err}");
    assert!(receipt(&homes, LINK_A).is_some());
    let _home = homes.attach(LINK_A);
    assert!(
        receipt(&homes, LINK_A).is_none(),
        "an old receipt would vouch for the new attachment"
    );
}

#[cfg(unix)]
fn planted_command(
    planted: &Path,
    fake_home: &Path,
    ocx: &Path,
    codex: &Path,
    port: u16,
    args: &[&str],
) -> std::process::Command {
    let mut cmd = std::process::Command::new(planted);
    cmd.args(args)
        .env("HOME", fake_home)
        .env("OPENCODEX_HOME", ocx)
        .env("CODEX_HOME", codex)
        .env("OCX_CHILD_LISTEN_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

#[cfg(unix)]
#[test]
fn a_relay_of_another_home_keeps_the_planted_binary_from_being_purged() {
    // Home X runs a relay from the shared planted binary; Home Y (another OPENCODEX_HOME and
    // CODEX_HOME of the same OS user) recovers a link and must not remove that binary.
    let x = Homes::new("owner-link-cross-x");
    let y = Homes::new("owner-link-cross-y");
    let fake_home = x.scratch.0.join("home");
    let bin_dir = fake_home.join(".cache").join("opencodex").join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let planted = bin_dir.join("ocx-child");
    fs::copy(env!("CARGO_BIN_EXE_ocx-child"), &planted).unwrap();

    let home = MockHomeServer::start(&raw_token(), KEY_ID, LINK_A);
    let tunnel = home.port.to_string();
    let listen = x.port.to_string();
    let args = attach_args(&tunnel, LINK_A, &listen);
    let mut attach = planted_command(&planted, &fake_home, &x.ocx, &x.codex, x.port, &args);
    attach.stdin(Stdio::piped());
    let out = spawn_with_creds(attach).wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "relay attach failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let purge = |label: &str| {
        let out = planted_command(
            &planted,
            &fake_home,
            &y.ocx,
            &y.codex,
            y.port,
            &["detach", "--purge", "--json", "--expect-link", LINK_B],
        )
        .output()
        .unwrap();
        assert!(
            out.status.success(),
            "{label}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let kept = purge("purge while X serves");
    assert!(kept.contains("\"purged\":false"), "{kept}");
    assert!(
        planted.exists(),
        "the purge removed a binary another home's relay runs from"
    );

    let out = planted_command(&planted, &fake_home, &x.ocx, &x.codex, x.port, &["detach"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "X detach failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let removed = purge("purge after X stopped");
    assert!(removed.contains("\"purged\":true"), "{removed}");
    assert!(!planted.exists());
}

#[cfg(unix)]
#[test]
fn the_in_use_lock_file_stays_so_no_relay_can_lock_a_fresh_one_during_a_purge() {
    let homes = Homes::new("owner-link-stable-lock");
    let fake_home = homes.scratch.0.join("home");
    let bin_dir = fake_home.join(".cache").join("opencodex").join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let planted = bin_dir.join("ocx-child");
    fs::copy(env!("CARGO_BIN_EXE_ocx-child"), &planted).unwrap();
    let lock_path = bin_dir.join(".ocx-child-in-use.lock");
    let barrier = Barrier::new(&homes.scratch.0, "stable");
    let mut cmd = planted_command(
        &planted,
        &fake_home,
        &homes.ocx,
        &homes.codex,
        homes.port,
        &["detach", "--purge", "--json", "--expect-link", LINK_A],
    );
    barrier.apply(&mut cmd, "purge-holding-in-use");
    let child = cmd.spawn().unwrap();
    assert!(
        barrier.wait_reached("purge-holding-in-use", Duration::from_secs(20)),
        "the purge never took the in-use lock"
    );
    // A relay starting now finds the purge holding the lock and must not serve.
    let starting = FileLock::try_acquire_shared_in_existing_dir(&lock_path);
    let refused = matches!(starting, Err(LockAcquireError::Busy));
    drop(starting);
    barrier.release("purge-holding-in-use");
    let out = child.wait_with_output().unwrap();
    assert!(
        refused,
        "a relay could lock the in-use file during the purge"
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!planted.exists());
    assert!(
        lock_path.exists(),
        "the lock file was unlinked; a relay could lock a fresh file of the same name"
    );
}
