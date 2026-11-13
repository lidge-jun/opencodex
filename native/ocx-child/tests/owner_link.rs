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
