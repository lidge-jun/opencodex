OpenCodex Desktop currently starts its bundled `ocx` without making that executable available to a terminal. This phase installs a Desktop-owned command automatically from a stable packaged installation, maintains shell PATH configuration, preserves an explicit off choice, and provides a local repair/removal page. POSIX launch provenance preserves shell-exported Anthropic settings before Bun loads dotenv; Windows retains its current direct-executable behavior. Installation status describes configuration, while actual shell selection remains a separately verified acceptance condition.

# 010 — wp1: Desktop-owned terminal command

## Execution boundary and loop specification

This is a delegated, plan-only satisfy-spec slice triggered by the owner's desktop PATH request. The goal is executable implementation instructions for A0–A6, A9, A10 Rust/UI and A11 POSIX provenance. Non-goals are implementing code now, changing any user's environment, package handoff/diagnostics (020), release/deploy, git mutations and child dispatch. Verifiers and their observed results appear below. Stop after delivering this one plan file; the memory artifact is this file. Expected outcomes are a reviewable plan or an explicitly unresolved integration issue. Escalate changes to the record contract, OS support, provenance contract or delivery scope to the parent; the parent owns FSM, loop, goals, independent review and branch operations.

[002_architecture.md](002_architecture.md), **Dispositions**, governs this plan; the proposal below it is evidence. Architect `01a11f35-9817-7fe2-a22a-27fb83025d32` proposed the split; the parent owns reflection in 003. A11 is accepted scope, including independent security review, even though the older proposal called direct-shim provenance out of scope.

All source references below are **68c9d354574ed240c17805493409f8c589682b91**, not the movable `origin/dev` ref. HEAD was that commit when read; `origin/dev` had already moved to `8ad91f4c03`. Rebase by the named function anchors. These are proposed bytes, not implemented/tested behavior.

| IN | OUT |
|---|---|
| Four Rust modules, authoritative record, cross-process lock and forward recovery | Service ownership, supervision or admin-token decisions based on this record |
| POSIX owned shim/helper, zsh/bash/fish rc editing and removal | Editing symlink targets, system PATH, `/etc/paths.d`, `/usr/local/bin` |
| macOS app, Windows sibling CLI, installed Linux deb | AppImage including extracted AppImage, debug/development launches |
| Raw HKCU Path transformation and bounded environment broadcast | Windows helper executable, machine Path writes, MSI/deb uninstall hooks |
| Startup hook, four page commands, tray entry, complete local page | User shell execution as an installer validation step |
| Source-contract test, Rust in-module regression cases, owning/public docs | Full local suites during this plan-only task |

| Acceptance / goalplan linkage | wp1 evidence and limit |
|---|---|
| c-1: app-only terminal command | Stable-bundle reconcile creates shim/rc or user Path. Real packaged shell evidence is completed in 030. |
| c-2: Desktop precedes npm | EOF block reposition and Path prepend tests; actual shell selection in 030. Windows machine-Path conflicts are partial, not success. |
| c-3: launcher handoff | Schema is provided to 020; handoff itself is OUT. |
| c-4: refusal, idempotence, cleanup | This phase's Rust tests, source-contract test and journal recovery. |
| c-5: gates | Exact commands and truthful coverage below; new files need later implementation validation. |
| c-6: reviews | Parent obtains independent code/security verdicts in 030; this document does not claim review approval. |
| c-7: merge | Parent-owned in 030; no merge or branch work in this worker. |

The c-1..c-7 labels are cross-checked against the parent's 030 criterion table; no goalplan file was present in the delegated checkout, so this is a linkage, not a claim that goalplan state was updated.

## Source grounding and exact file map

| Owning source at fixed base | Observation / insertion anchor |
|---|---|
| `desktop/src-tauri/src/sidecar.rs:201`, `start` | Existing `.sidecar("ocx")` uses bundled resources and `SUPERVISED_ENV`; terminal shim must not set that marker. |
| `structure/desktop-shell.md:385`, “Packaged native keyring binding”; `:402`, Linux layout | CLI resources follow its canonical bundle path; do not copy the CLI into the user bin. |
| `desktop/src-tauri/src/identity.rs:24`, `install_id`; `:35`, `install_id_in` | Reuse installation identity as metadata, not as file ownership authority. |
| `desktop/src-tauri/src/startup.rs:1449`, `register`; `:1473`, `adopt_launch_origin_argument` call | Schedule reconcile immediately after origin adoption and independently of proxy startup. |
| `desktop/src-tauri/src/lib.rs:216`, `update_status`; `:287`, `run/generate_handler!` | Pattern for four guarded commands and registration. |
| `desktop/src-tauri/src/window.rs:105`, `is_app_origin`; `:113`, `require_update_page` | Exact local origin + main label boundary, including Windows `http://tauri.localhost`. |
| `desktop/src-tauri/src/tray.rs:72`, `install`; `:219`, check-updates event | New terminal-command menu item and navigation event. |
| `desktop/src-tauri/src/startup.rs:1619`, `finish`; `:1688`, `keeps_update_page` | Ready navigation can otherwise replace a CLI settings page; preserve CLI page on any Ready completion. |
| `desktop/src-tauri/tauri.conf.json:8`, `build.frontendDist`; `desktop/ui/update.html:48`, nonce script | `../ui` already serves local pages. External `cli.js` obeys existing `script-src 'self'`; no remote IPC grants or configuration changes. |
| `src/cli/launcher-context.ts:8`, `NODE_LAUNCH_PROOF_PREFIX`; `:34`, `isLaunchProof`; `:54`, `initializeNodeLauncherContext` | Exactly one 43-character proof argv plus matching JSON version/proof; null inspection is valid. |
| `bin/ocx.mjs:1018`, `preBunAnthropicSlots`; `:1043`, launch context creation | Include only nonempty exported names, not values; random proof precedes dotenv. |
| `src/cli/claude.ts:65`, `deleteUntrustedAnthropicSlots`; `src/cli/index.ts:209`, initializer | Trusted slot names decide which shell exports survive; initializer consumes internal proof/context. |
| `desktop/src-tauri/src/logging.rs:6`, `log_once` | Log bounded reason codes once, never record/rc/context contents. |
| `.github/workflows/ci.yml:1576`, desktop shell commands | Ubuntu fmt/clippy/test does not exercise Windows registry/terminal behavior. |

| Exact path | Operation | Changed functions / interface |
|---|---|---|
| `desktop/src-tauri/src/cli_command_record.rs` | NEW | Types, validation, `Store::open/read/save/recover/transact`, safe IO, lock |
| `desktop/src-tauri/src/cli_command_posix.rs` | NEW | `stable_bundle`, `plan`, `remove_plan`, shim/helper/rc rendering |
| `desktop/src-tauri/src/cli_command_windows.rs` | NEW | Pure `prepend/remove/replace_owned_entry`, raw registry IO, broadcast |
| `desktop/src-tauri/src/cli_command.rs` | NEW | `State`, `run`, `reconcile_on_launch`, `status`, `set_enabled`, `install`, `remove`, `show_page` |
| `desktop/src-tauri/src/lib.rs` | MODIFY | Module declarations, four wrappers, `run` handler/state setup |
| `desktop/src-tauri/src/startup.rs` | MODIFY | `register`, `finish` |
| `desktop/src-tauri/src/window.rs` | MODIFY | `require_cli_page`, `shows_cli_page`, URL predicate/tests |
| `desktop/src-tauri/src/tray.rs` | MODIFY | `install`, event dispatch |
| `desktop/ui/cli.html`, `desktop/ui/cli.js` | NEW | Complete local UI below |
| `tests/clients/desktop-cli-command-surface.test.ts` | NEW | Command and UI contract / JS invocation tests |
| `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` | MODIFY | Exact explicit test registration |
| `structure/desktop-shell.md` | MODIFY | “Desktop-owned terminal command” contract, <=600 lines |
| `docs-site/src/content/docs/guides/desktop-app.md`, `docs-site/src/content/docs/ko/guides/desktop-app.md` | MODIFY | Terminal-command and pre-uninstall paragraphs |

No Cargo dependency is added. Reuse serde/serde_json/sha2/uuid and Windows-only winreg already pinned in `Cargo.toml:18–41`. A small documented FFI links the OS's existing `user32`/`kernel32` and POSIX libc. This still needs independent security review. `Cargo.toml`, `Cargo.lock`, capabilities and `tauri.conf.json` remain unchanged.

## Record contract and field chain (PLAN-FIELD-CHAIN-01)

Location is `$HOME/.opencodex-desktop/cli.json`, resolved from Tauri's user home, never cwd or `OPENCODEX_HOME`. POSIX root/bin/backups are real directories owned by effective uid with mode 0700; JSON/lock/backup files use 0600, shim 0700, helper 0600. On Windows this is the user's profile directory; POSIX numeric modes are inapplicable and profile ACL inheritance is the current limit. The registry is HKCU only. Never chmod an existing foreign directory into compliance.

JSON uses `camelCase`, platform `darwin|win32|linux`, bundle kind `macos-app|windows-install|linux-deb`. Both optional platform sections are explicit null when absent. A disabled record survives cleanup. A journal records exact before/after bytes and final record; sensitive rc bytes stay only in the private record/backups and are never returned to UI. A file journal target must be a fixed generated path or a validated supported rc target. Registry changes must have path `HKCU\\Environment\\Path`; neither UI nor record can select another key. Unknown schema versions, invalid UUID/digests, relative paths, unsupported platform/kind, mismatched sections, oversized/nested journals or unknown enum strings are invalid, not “first run”.

| Field / values | Generation → serialization → deserialization → all consumers |
|---|---|
| `version=1`, `ownerId`, `installId`, `generation`, `enabled` | Fresh record / intent operation → serde save → serde + validate on each read → Rust run/recovery/status; 020 reader/handoff/diagnostics. Generation is positive safe JS integer; increment only for a real committed change. Owner id plus exact hashes protects generated-content ownership only. |
| `bundle.platform/appExecutable/cliExecutable/version/kind` | Stable-bundle check → Bundle JSON → validated absolute paths/kind/platform → platform planner, UI `expectedExecutable`, 020 target validator/diagnostics. Never runtime authority. |
| `posix.binDirectory`, `files.kind/path/sha256/created` | Renderer + observed absence → JSON → fixed-path/kind/digest validation → owned replacement/removal, recovery, 020 reader. `kind=shim|path-helper`. |
| `posix.rcFiles.shell/path/blockSha256/created/backupPath/result` | Selected startup file + exact block hash → JSON → supported shell/path/digest and backup-root validation → install/reposition/remove/recovery/status. `shell=zsh|bash|fish`, `result=installed`. Partial failures live in status, never as forged installed entries. |
| `windows.key/value/entry/valueType/action/previousBefore/previousAfter` | Raw Path planner → JSON → fixed key/value, raw UTF-16 type and entry validation → replace/remove/recovery + 020 diagnostics. Type `REG_SZ|REG_EXPAND_SZ`; action `inserted|moved-existing`. Neighbors preserve restoration intent. |
| `pending.operation/changes/next`, change `kind/path/before/after/mode/backupPath` | Plan before writes → record persisted and fsynced → validate target/type/size + single-depth next → recovery executes only matching before/after states, reversing completed install changes if disabled → final next replaces pending (or original metadata plus off intent after rollback). `operation=install|remove`, `kind=file|registry-sz|registry-expand`; registry bytes retain exact unexpanded UTF-16LE. |
| UI `enabled/configured/phase/expectedExecutable/issues` | Post-operation record + result → Tauri serde → JS render via textContent → no further file or registry authority. `phase=unobserved|configured|partial|disabled|blocked`; `configured` is persisted setup, never actual parent-shell resolution. |
| reason codes | Guard failure → `Result<String>` / status issues → Tauri JSON, log_once code → JS text, parent review evidence. Consumers must tolerate unknown issue codes. |
| `OCX_NODE_LAUNCH_CONTEXT`, internal proof argv (not persisted) | POSIX shim pre-dotenv capture → fixed JSON text/export plus argv → existing initializer → trustedNodeLauncherContext → deleteUntrustedAnthropicSlots. `codexCliInspectionEnv=null`; no new updater inspection authority. |

The full definitions and validator below are the schema, replacing the proposal's schematic example. 020 must consume these definitions, including the pending journal, or reject pending records for handoff until reconciliation finishes. It must not execute a target selected from `pending.next`.

## Complete NEW file: `desktop/src-tauri/src/cli_command_record.rs`

```rust
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
pub fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn io<T>(value: std::io::Result<T>) -> Result<T> { value.map_err(|_| "io-failed".into()) }
fn digest(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn absolute(s: &str) -> bool {
    Path::new(s).is_absolute() && !s.contains(['\0', '\n', '\r'])
        && !Path::new(s).components().any(|c| matches!(c, std::path::Component::ParentDir))
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    pub platform: String, pub app_executable: String, pub cli_executable: String,
    pub version: String, pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnedFile { pub kind: String, pub path: String, pub sha256: String, pub created: bool }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RcFile {
    pub shell: String, pub path: String, pub block_sha256: String, pub created: bool,
    pub backup_path: Option<String>, pub result: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Posix { pub bin_directory: String, pub files: Vec<OwnedFile>, pub rc_files: Vec<RcFile> }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Windows {
    pub key: String, pub value: String, pub entry: String, pub value_type: String,
    pub action: String, pub previous_before: Option<String>, pub previous_after: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub kind: String, pub path: String, pub before: Option<Vec<u8>>, pub after: Option<Vec<u8>>,
    pub mode: u32, pub backup_path: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Journal { pub operation: String, pub changes: Vec<Change>, pub next: Box<Record> }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub version: u32, pub owner_id: String, pub install_id: String,
    pub generation: u64, pub enabled: bool, pub bundle: Option<Bundle>,
    pub posix: Option<Posix>, pub windows: Option<Windows>, pub pending: Option<Journal>,
}
impl Record {
    pub fn fresh(install_id: String) -> Self {
        Self { version: 1, owner_id: Uuid::new_v4().to_string(), install_id,
            generation: 1, enabled: true, bundle: None, posix: None, windows: None, pending: None }
    }
}
// The allowlist comes from the platform startup-file selector, not from JSON or UI.
pub struct Store { pub root: PathBuf, pub rc_allowed: Vec<PathBuf>, _lock: fs::File }
#[cfg(unix)]
unsafe extern "C" { fn geteuid() -> u32; fn flock(fd: i32, op: i32) -> i32; }
pub fn check(path: &Path, directory: bool) -> Result<()> {
    let m = io(fs::symlink_metadata(path))?;
    for parent in path.ancestors().skip(1) {
        if fs::symlink_metadata(parent).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
            return Err("unsafe-parent".into());
        }
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if fs::symlink_metadata(parent).map(|m| m.file_attributes() & 0x400 != 0).unwrap_or(true) {
                return Err("unsafe-parent".into());
            }
        }
    }
    if m.file_type().is_symlink() || (directory && !m.is_dir()) || (!directory && !m.is_file()) {
        return Err("unsafe-file".into());
    }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if m.uid() != unsafe { geteuid() } { return Err("foreign-owner".into()); }
        if m.mode() & 0o222 == 0 { return Err("read-only".into()); }
    }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 { return Err("unsafe-file".into()); }
    }
    if m.permissions().readonly() { return Err("read-only".into()); }
    Ok(())
}
pub fn private_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => check(path, true)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            #[cfg(unix)] {
                use std::os::unix::fs::DirBuilderExt;
                let mut b = fs::DirBuilder::new(); b.mode(0o700);
                io(b.create(path))?;
            }
            #[cfg(not(unix))] io(fs::create_dir(path))?;
        }
        Err(_) => return Err("io-failed".into()),
    }
    check(path, true)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        if io(fs::metadata(path))?.permissions().mode() & 0o777 != 0o700 {
            return Err("directory-permissions".into());
        }
    }
    Ok(())
}
pub fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("io-failed".into()),
        Ok(m) if m.len() > 8 * 1024 * 1024 => return Err("file-too-large".into()),
        Ok(_) => check(path, false)?,
    }
    let mut f = io(fs::File::open(path))?;
    let mut out = Vec::new(); io((&mut f).take(8 * 1024 * 1024 + 1).read_to_end(&mut out))?;
    if out.len() > 8 * 1024 * 1024 { return Err("file-too-large".into()); }
    Ok(Some(out))
}
fn new_file(path: &Path, mode: u32) -> Result<fs::File> {
    let mut o = fs::OpenOptions::new(); o.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; o.mode(mode); }
    #[cfg(not(unix))] let _ = mode;
    io(o.open(path))
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" { fn MoveFileExW(a: *const u16, b: *const u16, flags: u32) -> i32; }
    let a: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let b: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), 0x1 | 0x8) } == 0 {
        Err("rename-failed".into())
    } else { Ok(()) }
}
#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> Result<()> { io(fs::rename(from, to)) }
pub fn atomic(path: &Path, before: Option<&[u8]>, after: &[u8], mode: u32) -> Result<()> {
    let parent = path.parent().ok_or("unsafe-file")?; check(parent, true)?;
    let tmp = parent.join(format!(".ocx-cli-{}", Uuid::new_v4()));
    let result = (|| {
        let original = fs::symlink_metadata(path).ok();
        let mut f = new_file(&tmp, mode)?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt;
            io(f.set_permissions(fs::Permissions::from_mode(mode)))?;
        }
        io(f.write_all(after))?; io(f.sync_all())?;
        let observed = fs::symlink_metadata(path).ok();
        #[cfg(unix)] {
            use std::os::unix::fs::MetadataExt;
            if original.as_ref().map(|m| (m.dev(), m.ino(), m.mode(), m.mtime(), m.mtime_nsec()))
                != observed.as_ref().map(|m| (m.dev(), m.ino(), m.mode(), m.mtime(), m.mtime_nsec())) {
                return Err("concurrent-edit".into());
            }
        }
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            if original.as_ref().map(|m| (m.creation_time(), m.last_write_time(), m.file_attributes()))
                != observed.as_ref().map(|m| (m.creation_time(), m.last_write_time(), m.file_attributes())) {
                return Err("concurrent-edit".into());
            }
        }
        if read_bytes(path)?.as_deref() != before { return Err("concurrent-edit".into()); }
        replace(&tmp, path)?;
        #[cfg(unix)] io(fs::File::open(parent).and_then(|f| f.sync_all()))?;
        Ok(())
    })();
    let _ = fs::remove_file(tmp); result
}
fn lock(root: &Path) -> Result<fs::File> {
    let p = root.join("cli.lock");
    if fs::symlink_metadata(&p).is_ok() {
        check(&p, false)?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt;
            if io(fs::metadata(&p))?.permissions().mode() & 0o777 != 0o600 {
                return Err("lock-permissions".into());
            }
        }
    }
    let mut o = fs::OpenOptions::new(); o.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; o.mode(0o600); }
    let f = io(o.open(&p))?;
    #[cfg(unix)] {
        use std::os::fd::AsRawFd;
        // LOCK_EX | LOCK_NB: OS releases the lock on close/process death; no stale PID deletion.
        if unsafe { flock(f.as_raw_fd(), 2 | 4) } != 0 { return Err("lock-busy".into()); }
    }
    #[cfg(windows)] {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)] struct Overlapped { internal: usize, high: usize, offset: u32,
            offset_high: u32, event: *mut std::ffi::c_void }
        #[link(name = "kernel32")]
        unsafe extern "system" { fn LockFileEx(h: *mut std::ffi::c_void, flags: u32,
            reserved: u32, low: u32, high: u32, overlapped: *mut Overlapped) -> i32; }
        let mut v = Overlapped { internal: 0, high: 0, offset: 0, offset_high: 0,
            event: std::ptr::null_mut() };
        if unsafe { LockFileEx(f.as_raw_handle(), 1 | 2, 0, 1, 0, &mut v) } == 0 {
            return Err("lock-busy".into());
        }
    }
    Ok(f)
}
impl Store {
    pub fn open(root: PathBuf, rc_allowed: Vec<PathBuf>) -> Result<Self> {
        private_dir(&root)?; private_dir(&root.join("bin"))?; private_dir(&root.join("backups"))?;
        let guard = lock(&root)?; Ok(Self { root, rc_allowed, _lock: guard })
    }
    fn owned_path(&self, s: &str) -> bool {
        let p = Path::new(s);
        absolute(s) && (p == self.root.join("bin/ocx") || p == self.root.join("path.sh")
            || self.rc_allowed.iter().any(|r| r == p))
    }
    fn backup_path(&self, s: &str) -> bool {
        absolute(s) && Path::new(s).parent() == Some(self.root.join("backups").as_path())
    }
    pub fn validate(&self, r: &Record, nested: bool) -> Result<()> {
        if r.version != 1 || Uuid::parse_str(&r.owner_id).is_err() || r.install_id.is_empty()
            || r.install_id.len() > 256 || r.generation == 0 || r.generation > 9_007_199_254_740_991 {
            return Err("record-invalid".into());
        }
        if let Some(b) = &r.bundle {
            if !absolute(&b.app_executable) || !absolute(&b.cli_executable) || b.version.is_empty()
                || !matches!((b.platform.as_str(), b.kind.as_str()),
                    ("darwin", "macos-app") | ("win32", "windows-install") | ("linux", "linux-deb")) {
                return Err("record-invalid".into());
            }
            if (b.platform == "win32" && r.posix.is_some()) || (b.platform != "win32" && r.windows.is_some()) {
                return Err("record-invalid".into());
            }
        } else if r.posix.is_some() || r.windows.is_some() { return Err("record-invalid".into()); }
        if let Some(p) = &r.posix {
            if p.bin_directory != self.root.join("bin").to_string_lossy() || p.files.len() > 2
                || p.rc_files.len() > 5 { return Err("record-invalid".into()); }
            let mut paths = std::collections::HashSet::new();
            for f in &p.files {
                let expected = match f.kind.as_str() {
                    "shim" => self.root.join("bin/ocx"), "path-helper" => self.root.join("path.sh"),
                    _ => return Err("record-invalid".into()),
                };
                if Path::new(&f.path) != expected || !digest(&f.sha256) || !paths.insert(&f.path) {
                    return Err("record-invalid".into());
                }
            }
            for f in &p.rc_files {
                if !matches!(f.shell.as_str(), "zsh" | "bash" | "fish")
                    || !self.rc_allowed.iter().any(|p| p == Path::new(&f.path))
                    || !paths.insert(&f.path) || !digest(&f.block_sha256) || f.result != "installed"
                    || f.backup_path.as_deref().is_some_and(|s| !self.backup_path(s)) {
                    return Err("record-invalid".into());
                }
            }
        }
        if let Some(w) = &r.windows {
            if w.key != "HKCU\\Environment" || w.value != "Path" || !absolute(&w.entry)
                || w.entry.contains(';') || !matches!(w.value_type.as_str(), "REG_SZ" | "REG_EXPAND_SZ")
                || !matches!(w.action.as_str(), "inserted" | "moved-existing") {
                return Err("record-invalid".into());
            }
        }
        if let Some(j) = &r.pending {
            if nested || !matches!(j.operation.as_str(), "install" | "remove") || j.changes.len() > 8
                || j.next.pending.is_some() || r.owner_id != j.next.owner_id
                || r.install_id != j.next.install_id || r.enabled != j.next.enabled
                || j.next.generation != r.generation + 1 { return Err("record-invalid".into()); }
            self.validate(&j.next, true)?;
            let mut paths = std::collections::HashSet::new();
            for c in &j.changes {
                if !paths.insert(&c.path) || c.before.as_ref().is_some_and(|b| b.len() > 1_048_576)
                    || c.after.as_ref().is_some_and(|b| b.len() > 1_048_576)
                    || c.backup_path.as_deref().is_some_and(|s| !self.backup_path(s)) {
                    return Err("record-invalid".into());
                }
                match c.kind.as_str() {
                    "file" if self.owned_path(&c.path) && c.mode <= 0o777 => {},
                    "registry-sz" | "registry-expand" if c.path == "HKCU\\Environment\\Path" => {},
                    _ => return Err("record-invalid".into()),
                }
            }
        }
        Ok(())
    }
    pub fn read(&self) -> Result<Option<Record>> {
        let Some(b) = read_bytes(&self.root.join("cli.json"))? else { return Ok(None); };
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            if io(fs::metadata(self.root.join("cli.json")))?.permissions().mode() & 0o777 != 0o600 {
                return Err("record-permissions".into());
            }
        }
        let r: Record = serde_json::from_slice(&b).map_err(|_| "record-invalid")?;
        self.validate(&r, false)?; Ok(Some(r))
    }
    pub fn save(&self, r: &Record) -> Result<()> {
        self.validate(r, false)?; let p = self.root.join("cli.json"); let old = read_bytes(&p)?;
        let b = serde_json::to_vec_pretty(r).map_err(|_| "record-invalid")?;
        if b.len() > 8 * 1024 * 1024 { return Err("record-too-large".into()); }
        if old.as_deref() == Some(b.as_slice()) { return Ok(()); }
        atomic(&p, old.as_deref(), &b, 0o600)
    }
    pub fn transact(&self, current: &mut Record, mut next: Record, changes: Vec<Change>, op: &str) -> Result<()> {
        if changes.is_empty() && *current == next { return Ok(()); }
        next.generation = current.generation + 1; next.pending = None;
        current.pending = Some(Journal { operation: op.into(), changes, next: Box::new(next) });
        self.save(current)?; self.recover(current)
    }
    pub fn recover(&self, current: &mut Record) -> Result<()> {
        self.validate(current, false)?;
        let Some(j) = current.pending.clone() else { return Ok(()); };
        let rollback = j.operation == "install" && !current.enabled;
        let changes: Vec<_> = if rollback { j.changes.iter().rev().collect() }
            else { j.changes.iter().collect() };
        for c in changes {
            let (before, after) = if rollback { (&c.after, &c.before) } else { (&c.before, &c.after) };
            let found = if c.kind == "file" { read_bytes(Path::new(&c.path))? }
                else { crate::cli_command_windows::read_change(c)? };
            if found == *after { continue; }
            if found != *before { return Err("journal-conflict".into()); }
            if !rollback {
                if let (Some(name), Some(bytes)) = (&c.backup_path, &c.before) {
                    let p = Path::new(name);
                    if let Some(old) = read_bytes(p)? {
                        if old != *bytes { return Err("backup-conflict".into()); }
                    } else { let mut f = new_file(p, 0o600)?; io(f.write_all(bytes))?; io(f.sync_all())?; }
                }
            }
            if c.kind == "file" {
                let p = Path::new(&c.path);
                if let Some(b) = after { atomic(p, before.as_deref(), b, c.mode)?; }
                else {
                    if read_bytes(p)? != *before { return Err("concurrent-edit".into()); }
                    io(fs::remove_file(p))?;
                    #[cfg(unix)] io(fs::File::open(p.parent().ok_or("unsafe-file")?).and_then(|f| f.sync_all()))?;
                }
            } else {
                let mut step = c.clone(); step.before = before.clone(); step.after = after.clone();
                crate::cli_command_windows::apply_change(&step)?;
            }
        }
        if rollback { current.pending = None; current.generation += 1; }
        else { *current = *j.next; }
        self.save(current)
    }
}
```

IO limitation to review: identity/content are rechecked before rename, but no portable API atomically compares a regular file and renames only if unchanged. This is a concurrency guard against accidental editors, not a same-user adversarial filesystem boundary. A noncooperating writer in the final check-to-rename interval remains a known risk. Parent must not describe this as a hard security boundary. Kernel locking serializes cooperating Desktop processes and automatically releases after crashes, so journal recovery is reachable on the next launch.

## Complete NEW file: `desktop/src-tauri/src/cli_command_posix.rs`

The text constants are UTF-8, LF, one trailing LF, no BOM. Substitution is only `@OWNER@`, `@CLI@`, `@BIN@`, `@HELPER@`; path substitutions are whole POSIX single-quoted words (`'` becomes `'"'"'`). No values from Anthropic variables enter JSON. The shell only records presence of a nonempty exported variable, exactly matching Node's filter. `od` plus arithmetic awk generates the same base64url representation of 32 random bytes; the final character has only two significant bits. Missing utilities, unreadable urandom, short reads, awk failure or malformed output select a no-proof `exec` after deleting any inherited context. No deterministic/time/PID proof exists.

```rust
use crate::cli_command_record::{self as record, Bundle, Change, OwnedFile, Posix, RcFile, Record, Result, Store};
use std::{fs, path::{Path, PathBuf}};

pub const START: &str = "# >>> OpenCodex Desktop ocx PATH v1 >>>";
pub const END: &str = "# <<< OpenCodex Desktop ocx PATH v1 <<<";
const SHIM: &str = r#"#!/bin/sh
# OpenCodex Desktop ocx shim v1
# owner-id: @OWNER@
_ocx_cli=@CLI@
if [ ! -f "$_ocx_cli" ] || [ ! -x "$_ocx_cli" ]; then
  printf '%s\n' 'OpenCodex Desktop CLI is unavailable. Repair or remove the terminal command in Desktop.' >&2
  exit 127
fi
unset OCX_NODE_LAUNCH_CONTEXT OCX_PRE_BUN_ANTHROPIC_ENV
_ocx_proof=
if [ -r /dev/urandom ] && [ -x /usr/bin/od ] && [ -x /usr/bin/awk ]; then
  _ocx_proof=$(/usr/bin/od -An -tu1 -N32 /dev/urandom 2>/dev/null | /usr/bin/awk '
    BEGIN { a="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"; n=0; bits=0; count=0; out="" }
    { for (i=1; i<=NF; i++) {
        if ($i !~ /^[0-9]+$/ || $i < 0 || $i > 255) exit 1
        count++; n=n*256+$i; bits+=8
        while (bits>=6) { bits-=6; q=int(n/(2^bits)); out=out substr(a,q+1,1); n=n-q*(2^bits) }
    } }
    END { if (count!=32) exit 1; if (bits) out=out substr(a,n*(2^(6-bits))+1,1); print out }
  ') || _ocx_proof=
fi
case "$_ocx_proof" in
  *[!A-Za-z0-9_-]*) _ocx_proof= ;;
esac
if [ "${#_ocx_proof}" -eq 43 ]; then
  _ocx_slots=
  _ocx_sep=
  if [ -n "${ANTHROPIC_API_KEY-}" ]; then
    _ocx_slots='"ANTHROPIC_API_KEY"'; _ocx_sep=,
  fi
  if [ -n "${ANTHROPIC_AUTH_TOKEN-}" ]; then
    _ocx_slots=$_ocx_slots$_ocx_sep'"ANTHROPIC_AUTH_TOKEN"'; _ocx_sep=,
  fi
  if [ -n "${ANTHROPIC_BASE_URL-}" ]; then
    _ocx_slots=$_ocx_slots$_ocx_sep'"ANTHROPIC_BASE_URL"'
  fi
  OCX_NODE_LAUNCH_CONTEXT='{"version":1,"proof":"'$_ocx_proof'","anthropicEnvSlots":['$_ocx_slots'],"codexCliInspectionEnv":null}'
  export OCX_NODE_LAUNCH_CONTEXT
  exec "$_ocx_cli" "--ocx-internal-launch-proof=$_ocx_proof" "$@"
fi
exec "$_ocx_cli" "$@"
"#;
const HELPER: &str = r#"# OpenCodex Desktop ocx PATH helper v1
_ocx_desktop_path_v1() (
  _ocx_bin=@BIN@
  _ocx_new=$_ocx_bin
  _ocx_rest=${PATH-}
  if [ "${PATH+x}" = x ]; then
    while :; do
      case "$_ocx_rest" in
        *:*) _ocx_part=${_ocx_rest%%:*}; _ocx_rest=${_ocx_rest#*:}; _ocx_last=0 ;;
        *) _ocx_part=$_ocx_rest; _ocx_last=1 ;;
      esac
      if [ "$_ocx_part" != "$_ocx_bin" ]; then _ocx_new=$_ocx_new:$_ocx_part; fi
      [ "$_ocx_last" = 1 ] && break
    done
  fi
  printf '%s' "$_ocx_new"
)
PATH=$(_ocx_desktop_path_v1)
export PATH
unset -f _ocx_desktop_path_v1
"#;
fn text(p: &Path) -> Result<String> {
    let s = p.to_str().ok_or("path-not-utf8")?;
    if !p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) || s.contains(['\0', '\n', '\r', ':']) { return Err("path-unrepresentable".into()); }
    Ok(s.into())
}
fn quote(p: &Path) -> Result<String> { Ok(format!("'{}'", text(p)?.replace('\'', "'\"'\"'"))) }
pub fn render_shim(cli: &Path, owner: &str) -> Result<String> {
    // Replace the owner before substituting paths so a literal placeholder in a path stays literal.
    Ok(SHIM.replace("@OWNER@", owner).replace("@CLI@", &quote(cli)?))
}
pub fn render_helper(bin: &Path) -> Result<String> { Ok(HELPER.replace("@BIN@", &quote(bin)?)) }
pub fn block(shell: &str, root: &Path) -> Result<String> {
    let body = if shell == "fish" {
        format!("if status is-interactive\n    fish_add_path --path --prepend --move {}\nend\n", quote(&root.join("bin"))?)
    } else {
        let helper = quote(&root.join("path.sh"))?;
        format!("if [ -r {helper} ]; then\n  . {helper}\nfi\n")
    };
    Ok(format!("{START}\n{body}{END}\n"))
}
pub fn targets(home: &Path) -> Result<Vec<(String, PathBuf)>> {
    let z = std::env::var_os("ZDOTDIR").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.into());
    let fish = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from)
        .filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".config")).join("fish/config.fish");
    let mut out = vec![("zsh".into(), z.join(".zshrc")), ("zsh".into(), z.join(".zlogin")),
        ("bash".into(), home.join(".bashrc")), ("fish".into(), fish)];
    // Exists, including an unsafe symlink: it is the active candidate and must be refused, not skipped.
    if let Some(p) = [".bash_profile", ".bash_login", ".profile"].into_iter()
        .map(|n| home.join(n)).find(|p| fs::symlink_metadata(p).is_ok()) {
        out.push(("bash".into(), p));
    }
    for (_, p) in &out { text(p)?; }
    Ok(out)
}
pub fn stable_bundle(exe: &Path, debug: bool, version: &str) -> Result<Bundle> {
    if debug { return Err("development-launch".into()); }
    let raw = text(exe)?;
    if raw.starts_with("/Volumes/") || raw.starts_with("/private/var/folders/") && raw.contains("/AppTranslocation/")
        || raw.contains("/tmp/.mount_") || std::env::var_os("APPIMAGE").is_some()
        || std::env::var_os("APPDIR").is_some() { return Err("temporary-bundle".into()); }
    let real = fs::canonicalize(exe).map_err(|_| "bundle-unavailable")?;
    let s = text(&real)?;
    if s.starts_with("/Volumes/") || s.contains("/AppTranslocation/") || s.contains("/tmp/.mount_") {
        return Err("temporary-bundle".into());
    }
    let parent = real.parent().ok_or("unpackaged-launch")?;
    let (platform, kind, cli) = if cfg!(target_os = "macos") {
        if parent.file_name().and_then(|s| s.to_str()) != Some("MacOS")
            || parent.parent().and_then(|p| p.file_name()).and_then(|s| s.to_str()) != Some("Contents")
            || parent.parent().and_then(|p| p.parent()).and_then(|p| p.extension()).and_then(|s| s.to_str()) != Some("app") {
            return Err("unpackaged-launch".into());
        }
        ("darwin", "macos-app", parent.join("ocx"))
    } else {
        if parent != Path::new("/usr/bin") { return Err("unpackaged-launch".into()); }
        ("linux", "linux-deb", PathBuf::from("/usr/bin/ocx"))
    };
    let m = fs::symlink_metadata(&cli).map_err(|_| "bundle-cli-missing")?;
    if !m.is_file() || m.file_type().is_symlink() { return Err("bundle-cli-missing".into()); }
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt;
        if m.permissions().mode() & 0o111 == 0 { return Err("bundle-cli-not-executable".into()); }
    }
    Ok(Bundle { platform: platform.into(), kind: kind.into(), app_executable: s,
        cli_executable: text(&cli)?, version: version.into() })
}
// Return exact block range, including its line terminator. Reject malformed or changed markers.
fn range(bytes: &[u8], expected: &str) -> Result<Option<std::ops::Range<usize>>> {
    let s = std::str::from_utf8(bytes).map_err(|_| "rc-not-utf8")?;
    let begins: Vec<_> = s.match_indices(START).map(|(n, _)| n).collect();
    let ends: Vec<_> = s.match_indices(END).map(|(n, _)| n).collect();
    if s.lines().any(|line| (line.contains("OpenCodex Desktop ocx PATH")
        && (line.contains(">>>") || line.contains("<<<"))) && line != START && line != END) {
        return Err("rc-markers-invalid".into());
    }
    if begins.is_empty() && ends.is_empty() { return Ok(None); }
    if begins.len() != 1 || ends.len() != 1 || ends[0] < begins[0]
        || begins[0] > 0 && bytes[begins[0]-1] != b'\n' { return Err("rc-markers-invalid".into()); }
    let finish = ends[0] + END.len();
    let finish = if s[finish..].starts_with("\r\n") { finish + 2 }
        else if s[finish..].starts_with('\n') { finish + 1 }
        else if finish == s.len() { finish } else { return Err("rc-markers-invalid".into()); };
    let candidate = &s[begins[0]..finish];
    if candidate != expected && candidate.trim_end_matches(['\r', '\n']) != expected.trim_end_matches(['\r', '\n']) {
        return Err("rc-block-modified".into());
    }
    Ok(Some(begins[0]..finish))
}
fn newline(bytes: &[u8]) -> Result<&'static str> {
    let s = std::str::from_utf8(bytes).map_err(|_| "rc-not-utf8")?;
    if s.contains('\r') && (!s.contains("\r\n") || s.replace("\r\n", "").contains(['\r', '\n'])) {
        return Err("rc-mixed-newlines".into());
    }
    Ok(if s.contains("\r\n") { "\r\n" } else { "\n" })
}
pub fn edit_rc(bytes: &[u8], managed: &str, remove: bool) -> Result<Vec<u8>> {
    let nl = newline(bytes)?; let expected = managed.replace('\n', nl);
    let found = range(bytes, &expected)?;
    if let Some(r) = &found {
        if !remove && bytes[r.end..].iter().all(u8::is_ascii_whitespace) { return Ok(bytes.to_vec()); }
    }
    let mut out = bytes.to_vec();
    if let Some(r) = found { out.drain(r); }
    if remove { return Ok(out); }
    // Outside bytes and trailing whitespace stay in the same order; block is last nonblank content.
    if !out.is_empty() && !out.ends_with(b"\n") { out.extend_from_slice(nl.as_bytes()); }
    out.extend_from_slice(expected.as_bytes()); Ok(out)
}
fn mode(path: &Path) -> u32 {
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o600)
    }
    #[cfg(not(unix))] { let _ = path; 0o600 }
}
fn change(store: &Store, p: &Path, before: Option<Vec<u8>>, after: Option<Vec<u8>>, mode: u32) -> Change {
    let backup = before.as_ref().map(|_| store.root.join("backups").join(uuid::Uuid::new_v4().to_string()).to_string_lossy().into_owned());
    Change { kind: "file".into(), path: p.to_string_lossy().into_owned(), before, after, mode, backup_path: backup }
}
fn ensure_rc_parent(p: &Path, home: &Path) -> Result<()> {
    let parent = p.parent().ok_or("unsafe-file")?;
    if parent == home.join(".config/fish") {
        for directory in [home.join(".config"), home.join(".config/fish")] {
            match fs::symlink_metadata(&directory) {
                Ok(_) => record::check(&directory, true)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => record::private_dir(&directory)?,
                Err(_) => return Err("io-failed".into()),
            }
        }
    }
    record::check(parent, true)
}
pub fn plan(store: &Store, current: &Record, bundle: Bundle, home: &Path) -> Result<(Record, Vec<Change>, Vec<String>)> {
    let mut next = current.clone(); next.bundle = Some(bundle.clone());
    let mut changes = Vec::new(); let mut issues = Vec::new();
    let mut owned = Posix { bin_directory: text(&store.root.join("bin"))?, files: Vec::new(), rc_files: Vec::new() };
    for (kind, p, rendered, permissions) in [
        ("shim", store.root.join("bin/ocx"), render_shim(Path::new(&bundle.cli_executable), &current.owner_id)?, 0o700),
        ("path-helper", store.root.join("path.sh"), render_helper(&store.root.join("bin"))?, 0o600),
    ] {
        let old = record::read_bytes(&p)?;
        let previous = current.posix.as_ref().and_then(|v| v.files.iter().find(|f| f.path == p.to_string_lossy()));
        if let Some(b) = &old {
            if !previous.is_some_and(|f| record::hash(b) == f.sha256) { return Err("owned-file-conflict".into()); }
            if mode(&p) != permissions { return Err("owned-file-permissions".into()); }
        }
        if old.as_deref() != Some(rendered.as_bytes()) { changes.push(change(store, &p, old.clone(), Some(rendered.as_bytes().to_vec()), permissions)); }
        owned.files.push(OwnedFile { kind: kind.into(), path: text(&p)?, sha256: record::hash(rendered.as_bytes()),
            created: previous.map_or(old.is_none(), |f| f.created) });
    }
    let selected = targets(home)?;
    if selected.iter().filter(|(s, _)| s == "bash").count() == 1 { issues.push("login-file-absent".into()); }
    for (shell, p) in selected {
        // Never create an arbitrary external ZDOTDIR/XDG directory tree; absent parents are reported.
        let attempt: Result<RcFile> = (|| {
            ensure_rc_parent(&p, home)?;
            let old = record::read_bytes(&p)?;
            let previous = current.posix.as_ref().and_then(|v| v.rc_files.iter().find(|f| f.path == p.to_string_lossy()));
            let managed = block(&shell, &store.root)?;
            let nl = newline(old.as_deref().unwrap_or_default())?;
            let rendered = managed.replace('\n', nl);
            let found = range(old.as_deref().unwrap_or_default(), &rendered)?;
            if found.is_some() && !previous.is_some_and(|f| f.block_sha256 == record::hash(rendered.as_bytes())) {
                return Err("rc-block-unowned".into());
            }
            let after = edit_rc(old.as_deref().unwrap_or_default(), &managed, false)?;
            let mut backup = previous.and_then(|f| f.backup_path.clone());
            if old.as_deref() != Some(after.as_slice()) {
                let c = change(store, &p, old.clone(), Some(after), mode(&p));
                if backup.is_none() { backup = c.backup_path.clone(); }
                changes.push(c);
            }
            Ok(RcFile { shell, path: text(&p)?, block_sha256: record::hash(rendered.as_bytes()),
                created: previous.map_or(old.is_none(), |f| f.created), backup_path: backup, result: "installed".into() })
        })();
        match attempt {
            Ok(f) => owned.rc_files.push(f),
            Err(e) => {
                issues.push(e);
                // Retain old ownership so a refused file stays recoverable/removable after user repair.
                if let Some(f) = current.posix.as_ref().and_then(|v| v.rc_files.iter().find(|f| f.path == p.to_string_lossy())) {
                    owned.rc_files.push(f.clone());
                }
            }
        }
    }
    next.posix = Some(owned); next.windows = None; Ok((next, changes, issues))
}
pub fn remove_plan(store: &Store, current: &Record) -> Result<(Record, Vec<Change>, Vec<String>)> {
    let mut next = current.clone(); let mut changes = Vec::new(); let mut issues = Vec::new();
    let Some(mut owned) = current.posix.clone() else { return Ok((next, changes, issues)); };
    owned.rc_files.retain(|f| {
        let attempt: Result<()> = (|| {
            let p = Path::new(&f.path); let Some(old) = record::read_bytes(p)? else { return Ok(()); };
            let managed = block(&f.shell, &store.root)?;
            let expected = managed.replace('\n', newline(&old)?);
            if record::hash(expected.as_bytes()) != f.block_sha256 { return Err("rc-block-modified".into()); }
            let after = edit_rc(&old, &managed, true)?;
            let result = if f.created && after.iter().all(u8::is_ascii_whitespace) { None } else { Some(after) };
            if result.as_deref() != Some(old.as_slice()) { changes.push(change(store, p, Some(old), result, mode(p))); }
            Ok(())
        })();
        if let Err(e) = attempt { issues.push(e); true } else { false }
    });
    // If a refused rc still references helper/bin, keep both until repair/removal can finish.
    if owned.rc_files.is_empty() {
        owned.files.retain(|f| {
            let attempt: Result<()> = (|| {
                let p = Path::new(&f.path); let Some(old) = record::read_bytes(p)? else { return Ok(()); };
                if record::hash(&old) != f.sha256 { return Err("owned-file-conflict".into()); }
                changes.push(change(store, p, Some(old), None, mode(p))); Ok(())
            })();
            if let Err(e) = attempt { issues.push(e); true } else { false }
        });
    }
    next.posix = (!owned.files.is_empty() || !owned.rc_files.is_empty()).then_some(owned);
    Ok((next, changes, issues))
}
```

The module's shell block templates therefore generate exactly these examples (including final LF):

```sh
# >>> OpenCodex Desktop ocx PATH v1 >>>
if [ -r '/Users/user/.opencodex-desktop/path.sh' ]; then
  . '/Users/user/.opencodex-desktop/path.sh'
fi
# <<< OpenCodex Desktop ocx PATH v1 <<<
```

```fish
# >>> OpenCodex Desktop ocx PATH v1 >>>
if status is-interactive
    fish_add_path --path --prepend --move '/Users/user/.opencodex-desktop/bin'
end
# <<< OpenCodex Desktop ocx PATH v1 <<<
```

Bash and zsh share the sh block. Select `.bash_profile`, `.bash_login`, `.profile` in that priority, including unsafe existing candidates so refusal does not accidentally edit a lower-priority file. Do not create a login file. zsh handles both `.zshrc` and `.zlogin`; only Desktop's absolute `ZDOTDIR` is honored. Relative/absent `ZDOTDIR` falls back to home. Fish uses absolute XDG_CONFIG_HOME or `~/.config`. The default home-owned `.config/fish` parents are created as 0700 only if absent; existing directories keep their modes after ownership/symlink checks. Missing external config parents are partial rather than silently skipped. These empty standard directories, like backups, are retained on removal; the journal covers file/registry mutations, not harmless directory creation.

Removal saves `enabled=false` before making a removal journal. It removes only exact owned blocks and fingerprint-matching generated files, keeps files/ownership when a refused rc still needs them, never restores an entire old rc, and never removes user content outside the block. Existing empty files stay; files created by the installer are deleted only when nothing except whitespace remains. Backup files and the disabled record remain for user recovery. A user move/update refreshes the shim target on the next stable launch after exact old-shim fingerprint validation.

Security review scope is the pre-dotenv capture boundary and generated script/rc/record permissions. The proof is launch provenance, not authentication against a process already running as the same user. No key values, request bodies or provenance JSON are logged. Duplicate user-supplied internal proof arguments are deliberately not scrubbed by the shim: the existing initializer observes multiple proofs and fails closed. In the no-proof fallback Claude stripping is today's compiled-CLI behavior; show/document this capability limit, never weaken `deleteUntrustedAnthropicSlots`.

## Complete NEW file: `desktop/src-tauri/src/cli_command_windows.rs`

Pure Path functions compile on Ubuntu; OS IO is cfg(windows). Equality is deliberately limited to case-insensitive, slash-normalized, trailing-separator-normalized raw strings, without expanding `%VAR%`. Duplicate equivalent owned entries are ambiguous and refused. Unrelated entry bytes, empty elements, quoting and ordering remain intact. Moving a preexisting owned entry records its neighbors; removal restores it only when unambiguous surviving neighbors are present, otherwise keeps it and reports `path-restore-ambiguous`. Replacement first undoes the old ownership operation and then prepends the new entry. Repeated same-entry repair preserves the original action/neighbors rather than reclassifying an inserted item as preexisting.

```rust
use crate::cli_command_record::{Bundle, Change, Result, Windows};
use std::path::Path;
#[cfg(windows)] use crate::cli_command_record::Record;
fn normalized(s: &str) -> String { s.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase() }
fn parts(s: &str) -> Vec<String> { if s.is_empty() { Vec::new() } else { s.split(';').map(str::to_owned).collect() } }
fn index(v: &[String], entry: &str) -> Result<Option<usize>> {
    let hits: Vec<_> = v.iter().enumerate().filter(|(_, s)| normalized(s) == normalized(entry)).map(|(i, _)| i).collect();
    if hits.len() > 1 { Err("path-entry-ambiguous".into()) } else { Ok(hits.first().copied()) }
}
fn entry_ok(s: &str) -> bool { !s.is_empty() && !s.contains([';', '\0', '\r', '\n']) }
pub fn prepend(raw: &str, entry: &str, ty: &str) -> Result<(String, Windows)> {
    if !entry_ok(entry) || !matches!(ty, "REG_SZ" | "REG_EXPAND_SZ") { return Err("path-invalid".into()); }
    let mut v = parts(raw); let found = index(&v, entry)?;
    let before = found.and_then(|i| i.checked_sub(1)).map(|i| v[i].clone());
    let after = found.and_then(|i| v.get(i + 1)).cloned();
    let actual = found.map(|i| v.remove(i)).unwrap_or_else(|| entry.into());
    v.insert(0, actual);
    let result = v.join(";");
    if result.encode_utf16().count() + 1 > 32_767 { return Err("path-too-long".into()); }
    Ok((result, Windows { key: "HKCU\\Environment".into(), value: "Path".into(), entry: entry.into(),
        value_type: ty.into(), action: if found.is_some() { "moved-existing" } else { "inserted" }.into(),
        previous_before: before, previous_after: after }))
}
pub fn remove(raw: &str, owned: &Windows) -> Result<String> {
    let mut v = parts(raw); let Some(i) = index(&v, &owned.entry)? else { return Ok(raw.into()); };
    if owned.action == "inserted" { v.remove(i); return Ok(v.join(";")); }
    let actual = v.remove(i);
    let before = owned.previous_before.as_deref().map(|s| index(&v, s)).transpose()?.flatten();
    let after = owned.previous_after.as_deref().map(|s| index(&v, s)).transpose()?.flatten();
    let position = match (before, after, owned.previous_before.is_none(), owned.previous_after.is_none()) {
        (Some(b), Some(a), _, _) if b + 1 == a => a,
        (Some(b), None, _, true) if b + 1 == v.len() => v.len(),
        (None, Some(a), true, _) if a == 0 => 0,
        (None, None, true, true) if v.is_empty() => 0,
        _ => return Err("path-restore-ambiguous".into()),
    };
    v.insert(position, actual); Ok(v.join(";"))
}
pub fn replace_owned_entry(raw: &str, owned: Option<&Windows>, entry: &str, ty: &str) -> Result<(String, Windows)> {
    if let Some(old) = owned {
        if normalized(&old.entry) == normalized(entry) {
            let (out, _) = prepend(raw, entry, ty)?;
            let mut retained = old.clone(); retained.value_type = ty.into(); return Ok((out, retained));
        }
        prepend(&remove(raw, old)?, entry, ty)
    } else { prepend(raw, entry, ty) }
}
pub fn stable_bundle(exe: &Path, debug: bool, version: &str) -> Result<Bundle> {
    if debug { return Err("development-launch".into()); }
    let real = std::fs::canonicalize(exe).map_err(|_| "bundle-unavailable")?;
    let parent = real.parent().ok_or("unpackaged-launch")?;
    // current_exe is already absolute. Do not persist canonical Windows \\?\ extended syntax.
    let app = exe.to_str().ok_or("path-not-utf8")?;
    let cli = exe.parent().ok_or("unpackaged-launch")?.join("ocx.exe");
    let raw = cli.to_str().ok_or("path-not-utf8")?;
    let lower = app.to_ascii_lowercase().replace('/', "\\");
    if lower.contains("\\target\\") || lower.contains("\\temp\\") || lower.contains("\\tmp\\")
        || !std::fs::symlink_metadata(parent.join("ocx.exe")).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) {
        return Err("unpackaged-launch".into());
    }
    if !entry_ok(raw) || !exe.is_absolute() { return Err("path-invalid".into()); }
    Ok(Bundle { platform: "win32".into(), kind: "windows-install".into(), app_executable: app.into(),
        cli_executable: raw.into(), version: version.into() })
}
#[cfg(windows)]
mod os {
    use super::*;
    use winreg::{RegKey, RegValue, enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_SZ, REG_EXPAND_SZ}};
    pub fn raw() -> Result<Option<RegValue>> {
        let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Environment", KEY_READ).map_err(|_| "registry-read-failed")?;
        match key.get_raw_value("Path") {
            Ok(v) if matches!(v.vtype, REG_SZ | REG_EXPAND_SZ) => Ok(Some(v)),
            Ok(_) => Err("path-type-unsupported".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("registry-read-failed".into()),
        }
    }
    pub fn decode(b: &[u8]) -> Result<String> {
        if b.len() % 2 != 0 { return Err("path-invalid-utf16".into()); }
        let mut words: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0],c[1]])).collect();
        if words.pop() != Some(0) || words.contains(&0) { return Err("path-invalid-utf16".into()); }
        String::from_utf16(&words).map_err(|_| "path-invalid-utf16".into())
    }
    pub fn encode(s: &str) -> Vec<u8> { s.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect() }
    pub fn type_name(v: &RegValue) -> &'static str { if v.vtype == REG_EXPAND_SZ { "REG_EXPAND_SZ" } else { "REG_SZ" } }
    pub fn write(c: &Change) -> Result<()> {
        let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Environment", KEY_SET_VALUE).map_err(|_| "registry-write-failed")?;
        match &c.after {
            Some(b) => {
                decode(b)?;
                key.set_raw_value("Path", &RegValue { bytes: b.clone(), vtype: if c.kind == "registry-expand" { REG_EXPAND_SZ } else { REG_SZ } })
                    .map_err(|_| "registry-write-failed".into())
            }
            None => match key.delete_value("Path") {
                Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("registry-write-failed".into()),
            },
        }
    }
    pub fn machine_conflict() -> Result<bool> {
        let k = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(
            "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", KEY_READ).map_err(|_| "machine-path-unobserved")?;
        let v = match k.get_raw_value("Path") { Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("machine-path-unobserved".into()), };
        let raw = decode(&v.bytes)?;
        // Preserve raw text in storage; expansion below is observe-only for conflict detection.
        for p in parts(&raw) {
            let expanded = expand(&p)?;
            for name in ["ocx.exe", "ocx.com", "ocx.cmd", "ocx.bat"] {
                if Path::new(expanded.trim_matches('"')).join(name).is_file() { return Ok(true); }
            }
        }
        Ok(false)
    }
    fn expand(s: &str) -> Result<String> {
        #[link(name = "kernel32")]
        unsafe extern "system" { fn ExpandEnvironmentStringsW(src: *const u16, dst: *mut u16, size: u32) -> u32; }
        let src: Vec<u16> = s.encode_utf16().chain(Some(0)).collect();
        let mut dst = vec![0u16; 32_767];
        let n = unsafe { ExpandEnvironmentStringsW(src.as_ptr(), dst.as_mut_ptr(), dst.len() as u32) };
        if n == 0 || n as usize > dst.len() { return Err("machine-path-unobserved".into()); }
        let out = String::from_utf16(&dst[..n as usize - 1]).map_err(|_| "machine-path-unobserved")?;
        if out.contains('%') { return Err("machine-path-unobserved".into()); }
        Ok(out)
    }
    pub fn broadcast() -> Result<()> {
        #[link(name = "user32")]
        unsafe extern "system" { fn SendMessageTimeoutW(hwnd: *mut std::ffi::c_void, msg: u32,
            wparam: usize, lparam: isize, flags: u32, timeout: u32, result: *mut usize) -> isize; }
        let environment: Vec<u16> = "Environment".encode_utf16().chain(Some(0)).collect();
        let mut result = 0usize;
        // HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG; bounded per recipient.
        if unsafe { SendMessageTimeoutW(0xffffusize as *mut _, 0x001a, 0,
            environment.as_ptr() as isize, 0x0002, 1000, &mut result) } == 0 {
            Err("environment-broadcast-failed".into())
        } else { Ok(()) }
    }
}
#[cfg(windows)]
pub fn read_change(c: &Change) -> Result<Option<Vec<u8>>> {
    let found = os::raw()?;
    if let Some(v) = &found {
        if (c.kind == "registry-expand") != (os::type_name(v) == "REG_EXPAND_SZ") { return Err("path-type-changed".into()); }
    }
    Ok(found.map(|v| v.bytes))
}
#[cfg(not(windows))]
pub fn read_change(_: &Change) -> Result<Option<Vec<u8>>> { Err("registry-unsupported".into()) }
#[cfg(windows)]
pub fn apply_change(c: &Change) -> Result<()> {
    if read_change(c)? != c.before { return Err("concurrent-edit".into()); }
    os::write(c)
}
#[cfg(not(windows))]
pub fn apply_change(_: &Change) -> Result<()> { Err("registry-unsupported".into()) }
#[cfg(windows)]
pub fn plan(current: &Record, bundle: Bundle, remove_owned: bool) -> Result<(Record, Vec<Change>, Vec<String>)> {
    let old = os::raw()?; let ty = old.as_ref().map(os::type_name).unwrap_or("REG_EXPAND_SZ");
    let raw = old.as_ref().map(|v| os::decode(&v.bytes)).transpose()?.unwrap_or_default();
    let mut next = current.clone(); let mut issues = Vec::new();
    let result = if remove_owned {
        if let Some(owned) = &current.windows { remove(&raw, owned)? } else { return Ok((next, Vec::new(), issues)); }
    } else {
        let entry = Path::new(&bundle.cli_executable).parent().and_then(|p| p.to_str()).ok_or("path-invalid")?;
        let (s, owned) = replace_owned_entry(&raw, current.windows.as_ref(), entry, ty)?;
        next.bundle = Some(bundle); next.windows = Some(owned); s
    };
    if remove_owned { next.windows = None; }
    next.posix = None;
    let after = if old.is_none() && result.is_empty() { None } else { Some(os::encode(&result)) };
    let before = old.map(|v| v.bytes);
    let changes = if before == after { Vec::new() } else { vec![Change { kind: if ty == "REG_EXPAND_SZ" { "registry-expand" } else { "registry-sz" }.into(),
        path: "HKCU\\Environment\\Path".into(), before, after, mode: 0, backup_path: None }] };
    if !remove_owned {
        match os::machine_conflict() {
            Ok(true) => issues.push("machine-path-conflict".into()), Ok(false) => {}, Err(e) => issues.push(e),
        }
    }
    Ok((next, changes, issues))
}
#[cfg(windows)]
pub fn notify() -> Result<()> { os::broadcast() }
#[cfg(not(windows))]
pub fn notify() -> Result<()> { Ok(()) }
```

Raw HKCU Path is read through `get_raw_value`, never `get_value::<String>` followed by expansion or `setx`. A supported raw type survives every normal write. A concurrent type change blocks recovery. Broadcast is a notification, not proof of refreshed shell environments; SendMessageTimeout's timeout is per recipient, so many unresponsive windows can increase total duration. It runs only on the blocking worker after durable commit. Registry persistence lacks a portable file-like fsync/rename; record journal recovery compares the actual raw value after process interruption. The caller reports partial on broadcast failure and on machine conflicts/unobserved machine Path. Native Windows tests must separately verify the registry value type and a newly started terminal; Ubuntu proves only the pure transforms.

## Complete NEW file: `desktop/src-tauri/src/cli_command.rs`

```rust
use crate::{cli_command_record::{self as record, Record, Result, Store}, cli_command_windows as windows};
#[cfg(unix)] use crate::cli_command_posix as posix;
use serde::Serialize;
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool, pub configured: bool, pub phase: String,
    pub expected_executable: Option<String>, pub issues: Vec<String>,
}
impl Default for Status {
    fn default() -> Self { Self { enabled: true, configured: false, phase: "unobserved".into(), expected_executable: None, issues: Vec::new() } }
}
#[derive(Default)]
pub struct State { scheduled: AtomicBool, serial: Mutex<()>, latest: Mutex<Status> }
#[derive(Clone, Copy)]
pub enum Action { Reconcile, Repair, Enable(bool), Remove }
pub fn status(app: &AppHandle) -> Status {
    app.state::<State>().latest.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
}
fn perform(app: &AppHandle, action: Action) -> Result<Status> {
    let home = app.path().home_dir().map_err(|_| "home-unavailable")?;
    if !home.is_absolute() { return Err("home-unavailable".into()); }
    record::check(&home, true)?;
    #[cfg(unix)] let allowed = posix::targets(&home)?.into_iter().map(|(_, p)| p).collect();
    #[cfg(not(unix))] let allowed = Vec::new();
    let store = Store::open(home.join(".opencodex-desktop"), allowed)?;
    let mut r = match store.read()? {
        Some(r) => r,
        None => Record::fresh(crate::identity::install_id(app).ok_or("install-id-unavailable")?),
    };
    let explicit_remove = matches!(action, Action::Remove | Action::Enable(false));
    let desired = match action { Action::Enable(v) => Some(v), Action::Remove => Some(false), _ => None };
    if let Some(enabled) = desired {
        if r.enabled != enabled {
            r.enabled = enabled; r.generation += 1;
            if let Some(j) = &mut r.pending { j.next.enabled = enabled; j.next.generation = r.generation + 1; }
        }
        // Off is durable even if journal conflict prevents this cleanup attempt.
        store.save(&r)?;
    }
    app.state::<State>().latest.lock().unwrap_or_else(std::sync::PoisonError::into_inner).enabled = r.enabled;
    // A disabled interrupted install rolls back its completed prefix. It never finishes installing.
    store.recover(&mut r)?;
    let remove = explicit_remove || (!r.enabled && matches!(action, Action::Reconcile));
    if !remove && !r.enabled {
        return Ok(Status { enabled: false, phase: "disabled".into(), ..Status::default() });
    }
    let (next, changes, mut issues) = if remove {
        #[cfg(unix)] { posix::remove_plan(&store, &r)? }
        #[cfg(windows)] {
            if let Some(b) = r.bundle.clone() { windows::plan(&r, b, true)? }
            else { (r.clone(), Vec::new(), Vec::new()) }
        }
    } else {
        let exe = std::env::current_exe().map_err(|_| "bundle-unavailable")?;
        let version = app.package_info().version.to_string();
        #[cfg(unix)] { let b = posix::stable_bundle(&exe, cfg!(debug_assertions), &version)?;
            posix::plan(&store, &r, b, &home)? }
        #[cfg(windows)] { let b = windows::stable_bundle(&exe, cfg!(debug_assertions), &version)?;
            windows::plan(&r, b, false)? }
    };
    let registry_changed = changes.iter().any(|c| c.kind.starts_with("registry-"));
    store.transact(&mut r, next, changes, if remove { "remove" } else { "install" })?;
    if registry_changed { if let Err(e) = windows::notify() { issues.push(e); } }
    let configured = r.enabled && r.bundle.is_some() && (r.posix.is_some() || r.windows.is_some()) && issues.is_empty();
    let phase = if !issues.is_empty() { "partial" } else if !r.enabled { "disabled" }
        else if configured { "configured" } else { "unobserved" };
    Ok(Status { enabled: r.enabled, configured, phase: phase.into(),
        expected_executable: r.bundle.as_ref().map(|b| b.cli_executable.clone()), issues })
}
fn run(app: &AppHandle, action: Action) -> Status {
    let state = app.state::<State>();
    let _serial = state.serial.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let result = match perform(app, action) {
        Ok(v) => v,
        Err(code) => {
            crate::logging::log_once("terminal command", &code);
            let mut v = status(app); v.configured = false; v.phase = "blocked".into(); v.issues = vec![code]; v
        }
    };
    *state.latest.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = result.clone(); result
}
async fn execute(app: AppHandle, action: Action) -> Result<Status> {
    tauri::async_runtime::spawn_blocking(move || run(&app, action)).await.map_err(|_| "worker-failed".into())
}
pub fn reconcile_on_launch(app: &AppHandle) {
    if app.state::<State>().scheduled.swap(true, Ordering::AcqRel) { return; }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if execute(app, Action::Reconcile).await.is_err() { crate::logging::log_once("terminal command", "worker-failed"); }
    });
}
pub async fn set_enabled(app: AppHandle, enabled: bool) -> Result<Status> { execute(app, Action::Enable(enabled)).await }
pub async fn install(app: AppHandle) -> Result<Status> { execute(app, Action::Repair).await }
pub async fn remove(app: AppHandle) -> Result<Status> { execute(app, Action::Remove).await }
pub fn show_page(app: &AppHandle) {
    crate::popup::hide(app);
    if let Some(w) = app.get_webview_window("main") {
        // Fixed local URL; this works before a proxy exists, like the bundled update page.
        let origin = if cfg!(target_os = "windows") { "http://tauri.localhost/cli.html" } else { "tauri://localhost/cli.html" };
        if tauri::Url::parse(origin).ok().is_some_and(|url| w.navigate(url).is_ok()) {
            crate::window::show(&w);
        } else { crate::logging::log_once("terminal command", "page-unavailable"); }
    }
}
```

`cli_status` reads the cached snapshot without filesystem writes or initiating an install. Reconcile is scheduled once; UI polls that snapshot. All action IO runs on spawn_blocking and shares both the process mutex and the OS-backed user-directory lock. Lock contention is a visible blocked state, not a retry loop. Disabled intent is saved before removal and repair never changes an off choice. Startup failures never stop the app. User paths/rc contents are not used as logger messages.

## MODIFY diffs at the fixed-base function anchors

### `desktop/src-tauri/src/lib.rs`

```diff
@@ module declarations, before mod endpoint
+mod cli_command;
+mod cli_command_record;
+#[cfg_attr(target_os = "windows", allow(dead_code))]
+mod cli_command_posix;
+// The pure transforms are intentionally compiled for portable unit tests.
+#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
+mod cli_command_windows;
 mod endpoint;
@@ before update_status (base line 216)
+#[tauri::command]
+fn cli_status(window: tauri::WebviewWindow, app: tauri::AppHandle)
+    -> Result<cli_command::Status, String> {
+    window::require_cli_page(&window)?;
+    Ok(cli_command::status(&app))
+}
+
+#[tauri::command]
+async fn cli_set_enabled(window: tauri::WebviewWindow, app: tauri::AppHandle, enabled: bool)
+    -> Result<cli_command::Status, String> {
+    window::require_cli_page(&window)?;
+    cli_command::set_enabled(app, enabled).await
+}
+
+#[tauri::command]
+async fn cli_install(window: tauri::WebviewWindow, app: tauri::AppHandle)
+    -> Result<cli_command::Status, String> {
+    window::require_cli_page(&window)?;
+    cli_command::install(app).await
+}
+
+#[tauri::command]
+async fn cli_remove(window: tauri::WebviewWindow, app: tauri::AppHandle)
+    -> Result<cli_command::Status, String> {
+    window::require_cli_page(&window)?;
+    cli_command::remove(app).await
+}
+
 #[tauri::command]
 async fn update_status(
@@ run / generate_handler! (base line 287)
             decide_takeover,
+            cli_status,
+            cli_set_enabled,
+            cli_install,
+            cli_remove,
             update_status,
@@ run / setup (base line 300)
             app.manage(AppState::new());
+            app.manage(cli_command::State::default());
             app.manage(updater::PendingUpdate(Mutex::new(None)));
```

### `desktop/src-tauri/src/startup.rs`

```diff
@@ register, immediately after base line 1473
     first_run::adopt_launch_origin_argument(app);
+    crate::cli_command::reconcile_on_launch(app);
@@ finish, base line 1619
-        if keeps_update_page(mode, crate::window::shows_update_page(&window)) {
+        if crate::window::shows_cli_page(&window)
+            || keeps_update_page(mode, crate::window::shows_update_page(&window)) {
             return;
         }
```

The new finish guard is needed for a user opening the tray page during Launch as well as Recover; it does not change existing update-page policy. Test `ready_completion_preserves_cli_settings` activates both modes. This is an in-scope integration adjustment discovered while planning, not a new proxy-startup dependency.

### `desktop/src-tauri/src/window.rs`

```diff
@@ after is_update_page_url, before shows_update_page (base line 128)
+fn is_cli_page_url(url: &Url) -> bool {
+    is_app_origin(url) && url.path() == "/cli.html"
+        && url.username().is_empty() && url.password().is_none()
+        && url.query().is_none() && url.fragment().is_none()
+}
+
+pub fn require_cli_page(window: &WebviewWindow) -> Result<(), String> {
+    if window.label() != "main" { return Err("CLI page unavailable".into()); }
+    let url = window.url().map_err(|_| "CLI page unavailable")?;
+    if !is_cli_page_url(&url) { return Err("CLI page unavailable".into()); }
+    Ok(())
+}
+
+pub fn shows_cli_page(window: &WebviewWindow) -> bool {
+    window.url().is_ok_and(|url| is_cli_page_url(&url))
+}
@@ tests / imports
-    use super::{is_app_origin, is_update_page_url, opens_in_default_browser, webview_user_agent};
+    use super::{is_app_origin, is_cli_page_url, is_update_page_url, opens_in_default_browser, webview_user_agent};
@@ tests, before the existing first test
+    #[test]
+    fn cli_page_is_exact_local_origin_and_path() {
+        for s in ["tauri://localhost/cli.html", "http://tauri.localhost/cli.html"] {
+            assert!(is_cli_page_url(&url(s)));
+        }
+        for s in ["http://127.0.0.1:10100/cli.html", "https://tauri.localhost/cli.html",
+            "tauri://evil/cli.html", "tauri://localhost/cli.html.evil", "tauri://localhost/index.html",
+            "http://tauri.localhost:1420/cli.html", "tauri://localhost/cli.html?path=x",
+            "tauri://localhost/cli.html#x", "tauri://user@localhost/cli.html"] {
+            assert!(!is_cli_page_url(&url(s)), "{s}");
+        }
+    }
```

### `desktop/src-tauri/src/tray.rs`

```diff
@@ install, after browser item at base line 74
     let browser = MenuItem::with_id(app, "open-browser", "Open in Browser", true, None::<&str>)?;
+    let cli_command = MenuItem::with_id(app, "terminal-command", "Terminal command…", true, None::<&str>)?;
@@ install / Menu::with_items, base line 112
             &browser,
+            &cli_command,
             &PredefinedMenuItem::separator(app)?,
@@ install / on_menu_event, before open-dashboard at base line 191
+            "terminal-command" => crate::cli_command::show_page(app),
             "open-dashboard" => {
```

`frontendDist: "../ui"` at `tauri.conf.json:8` already includes both NEW UI files, exactly as it includes `update.html`. Existing local default capability covers main; no capabilities for `http://127.0.0.1:*` are added. The runtime guard is still required even with capability restrictions. Debug/devUrl cannot exercise mutation commands and stable-bundle gating rejects debug installation.

## Complete NEW file: `desktop/ui/cli.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenCodex terminal command</title>
  <style>
    :root { color-scheme: light dark; font: 15px system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { width: min(38rem, calc(100vw - 3rem)); padding: 1.5rem; }
    h1 { font-size: 1.5rem; } p { line-height: 1.5; }
    button { font: inherit; padding: .6rem 1rem; margin: .3rem .3rem .3rem 0; }
    button:focus-visible, input:focus-visible { outline: 3px solid #408bff; }
    #error { color: #b3261e; } #target { overflow-wrap: anywhere; }
    #titlebar { position: fixed; top: 0; left: 0; right: 0; height: 40px; }
    @media (prefers-color-scheme: dark) { #error { color: #ff9b92; } }
  </style>
</head>
<body>
  <div id="titlebar" hidden></div>
  <main>
    <h1>Terminal command</h1>
    <label><input id="enabled" type="checkbox" disabled /> Use Desktop's ocx command in new terminals</label>
    <p id="state" role="status" aria-live="polite">Reading command configuration…</p>
    <p id="target"></p>
    <ul id="issues"></ul>
    <p id="error" role="alert" hidden></p>
    <p>After enabling or repairing, open a new terminal. Existing shells and aliases can still select another command. Use <code>type -a ocx</code> on POSIX, or <code>Get-Command ocx -All</code> and <code>where.exe ocx</code> on Windows to check.</p>
    <p>Remove the terminal command here before uninstalling Desktop. Removing it keeps your off choice for the next launch.</p>
    <div>
      <button id="repair" type="button" disabled>Repair</button>
      <button id="remove" type="button" disabled>Remove terminal command</button>
      <button id="back" type="button" disabled>Back to dashboard</button>
    </div>
  </main>
  <script src="cli.js"></script>
</body>
</html>
```

## Complete NEW file: `desktop/ui/cli.js`

```javascript
"use strict";
const invoke = window.__TAURI__?.core?.invoke;
const nodes = Object.fromEntries(["enabled", "state", "target", "issues", "error", "repair", "remove", "back", "titlebar"]
  .map(id => [id, document.getElementById(id)]));
let busy = false;
let latest = null;
let polling = false;
function controls() {
  nodes.enabled.disabled = busy || !invoke;
  nodes.repair.disabled = busy || !invoke || !latest?.enabled;
  nodes.remove.disabled = busy || !invoke;
  nodes.back.disabled = busy || !invoke;
}
function render(s) {
  latest = s;
  nodes.enabled.checked = Boolean(s.enabled);
  nodes.state.textContent = {
    unobserved: "Configuration has not been inspected yet.",
    configured: "Desktop command configuration is installed. Check selection in a new terminal.",
    partial: "Some configuration could not be applied. Check the issues below.",
    disabled: "Automatic terminal command configuration is off.",
    blocked: "Configuration is blocked. Correct the reported issue and try Repair.",
  }[s.phase] || "Configuration state is unavailable.";
  nodes.target.textContent = s.expectedExecutable ? "Bundled executable: " + s.expectedExecutable : "";
  nodes.issues.replaceChildren(...(s.issues || []).map(code => {
    const li = document.createElement("li"); li.textContent = code; return li;
  }));
  controls();
}
function bounded(work) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Desktop did not answer within 30 seconds. Refresh status before retrying.")), 30000);
    Promise.resolve(work).then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}
async function refresh() {
  if (!invoke || busy || polling) return;
  polling = true;
  try { render(await bounded(invoke("cli_status"))); }
  catch (e) { nodes.error.textContent = String(e); nodes.error.hidden = false; }
  finally { polling = false; }
}
async function action(name, args) {
  if (!invoke || busy) return;
  busy = true; controls(); nodes.error.hidden = true;
  try {
    const s = await bounded(args === undefined ? invoke(name) : invoke(name, args));
    if (s) render(s);
  } catch (e) {
    nodes.error.textContent = String(e); nodes.error.hidden = false;
  } finally { busy = false; controls(); await refresh(); }
}
nodes.enabled.addEventListener("change", () => action("cli_set_enabled", { enabled: nodes.enabled.checked }));
nodes.repair.addEventListener("click", () => action("cli_install"));
nodes.remove.addEventListener("click", () => action("cli_remove"));
// Reuse the existing path-free dashboard command; only four NEW commands are introduced.
nodes.back.addEventListener("click", () => action("show_dashboard"));
if (invoke && typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent)) {
  nodes.titlebar.hidden = false;
  nodes.titlebar.addEventListener("mousedown", e => {
    if (e.button === 0) invoke("plugin:window|start_dragging").catch(() => {});
  });
  nodes.titlebar.addEventListener("dblclick", () => invoke("plugin:window|toggle_maximize").catch(() => {}));
}
if (!invoke) {
  nodes.state.textContent = "Open this page from OpenCodex Desktop's Terminal command menu.";
  controls();
} else {
  refresh();
  setInterval(refresh, 2000);
}
```

UI never passes a file path, command line, registry key, executable target or URL to Rust. Status strings use textContent, not HTML. A frontend deadline does not cancel a blocking operation; a retry serializes behind the operation, and status polling does not launch another write. Process death while pending is handled by journal recovery on next launch.

## Complete NEW file: `tests/clients/desktop-cli-command-surface.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { repoPath } from "../helpers/repo-root";
import { initializeNodeLauncherContext } from "../../src/cli/launcher-context";
const read = (p: string) => readFileSync(repoPath(p), "utf8");
const lib = read("desktop/src-tauri/src/lib.rs");
const policy = read("desktop/src-tauri/src/window.rs");
const page = read("desktop/ui/cli.html");
const script = read("desktop/ui/cli.js");
const posix = read("desktop/src-tauri/src/cli_command_posix.rs");
const commands = ["cli_status", "cli_set_enabled", "cli_install", "cli_remove"];
function harness(invoke?: (name: string, args?: unknown) => Promise<unknown>) {
  const handlers = new Map<string, () => void>();
  const nodes = new Map(["enabled", "state", "target", "issues", "error", "repair", "remove", "back", "titlebar"].map(id => [id, {
    checked: false, disabled: false, hidden: false, textContent: "", children: [] as unknown[],
    addEventListener: (event: string, cb: () => void) => { handlers.set(id + ":" + event, cb); },
    replaceChildren(...items: unknown[]) { this.children = items; },
  }]));
  runInNewContext(script, {
    window: { __TAURI__: invoke ? { core: { invoke } } : undefined },
    document: { getElementById: (id: string) => nodes.get(id), createElement: () => ({ textContent: "" }) },
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, Promise, Error,
  });
  return { nodes, handlers };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
describe("desktop CLI command surface", () => {
  test("registers four path-free commands and guards every wrapper", () => {
    const registered = lib.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] || "";
    for (const name of commands) {
      expect(registered).toContain(name);
      const body = lib.match(new RegExp("(?:async )?fn " + name + "\\([\\s\\S]*?(?=\\n#\\[tauri::command\\]|\\npub fn run)"))?.[0] || "";
      expect(body).toContain("window::require_cli_page(&window)?");
      expect(body).not.toMatch(/(?:path|command|executable|registry_key):\s*(?:String|PathBuf)/);
    }
    expect(policy).toContain('url.path() == "/cli.html"');
    expect(policy).toContain('window.label() != "main"');
    expect(page).toContain('<script src="cli.js"></script>');
    expect(read("desktop/src-tauri/tauri.conf.json")).toContain('"frontendDist": "../ui"');
  });
  test("UI never sends an arbitrary path and only toggles a boolean", async () => {
    const calls: Array<[string, unknown]> = [];
    const { nodes, handlers } = harness((name, args) => {
      calls.push([name, args]);
      return Promise.resolve({ enabled: true, phase: "configured", expectedExecutable: "/example/ocx", issues: [] });
    });
    await settle();
    nodes.get("enabled")!.checked = false;
    handlers.get("enabled:change")!(); await settle();
    handlers.get("repair:click")!(); await settle();
    handlers.get("remove:click")!(); await settle();
    for (const [name, args] of calls) {
      if (name === "cli_set_enabled") expect(args).toEqual({ enabled: false });
      else expect(args).toBeUndefined();
    }
    expect(calls.some(([n]) => n === "cli_install")).toBe(true);
    expect(calls.some(([n]) => n === "cli_remove")).toBe(true);
    expect(script).not.toContain("innerHTML");
    expect(page).not.toMatch(/<input[^>]*type="(?:text|file)"/);
  });
  test("missing Tauri disables controls and states the entry point", () => {
    const { nodes } = harness();
    for (const id of ["enabled", "repair", "remove", "back"]) expect(nodes.get(id)!.disabled).toBe(true);
    expect(nodes.get("state")!.textContent).toContain("Terminal command menu");
  });
  test("ready completion preserves CLI settings during launch and recovery", () => {
    const startup = read("desktop/src-tauri/src/startup.rs");
    expect(startup).toContain("crate::window::shows_cli_page(&window)");
    expect(startup).toContain("|| keeps_update_page(mode, crate::window::shows_update_page(&window))");
    expect(startup).toMatch(/adopt_launch_origin_argument\(app\);\s*crate::cli_command::reconcile_on_launch\(app\);/);
    expect(read("desktop/src-tauri/src/cli_command.rs")).toContain("spawn_blocking");
    expect(read("desktop/src-tauri/src/tray.rs")).toContain('"terminal-command" => crate::cli_command::show_page(app)');
  });
});
const shellTest = process.platform === "win32" ? test.skip : test;
function runShim(modify: (s: string) => string = s => s) {
  const root = mkdtempSync(join(tmpdir(), "ocx-shim-proof-"));
  try {
    const cli = join(root, "fake ocx"); const shim = join(root, "ocx");
    writeFileSync(cli, '#!/bin/sh\nprintf "%s\\n" "${OCX_NODE_LAUNCH_CONTEXT-}" "${1-}" "${2-}"\n'); chmodSync(cli, 0o700);
    const raw = posix.match(/const SHIM: &str = r#"([\s\S]*?)"#;/)?.[1];
    if (!raw) throw new Error("shim template absent");
    writeFileSync(shim, modify(raw.replace("@OWNER@", "00000000-0000-4000-8000-000000000001")
      .replace("@CLI@", "'" + cli.replaceAll("'", "'\"'\"'") + "'"))); chmodSync(shim, 0o700);
    const env = { ...process.env, ANTHROPIC_API_KEY: "shell-value", ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "https://example.invalid", OCX_NODE_LAUNCH_CONTEXT: "untrusted-old-context" };
    const child = spawnSync("/bin/sh", [shim, "claude"], { env, encoding: "utf8" });
    expect(child.status).toBe(0); return child.stdout.split("\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
}
shellTest("shim proof is accepted by the actual initializer and captures only nonempty exports", () => {
  const [raw, proof, command] = runShim();
  const argv = ["ocx", "entry", proof!, command!];
  const env = { OCX_NODE_LAUNCH_CONTEXT: raw };
  const context = initializeNodeLauncherContext(argv, env);
  expect(context?.anthropicEnvSlots).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
  expect(context?.codexCliInspectionEnv).toBeNull();
  expect(argv).toEqual(["ocx", "entry", "claude"]);
  expect(raw).not.toContain("shell-value");
  expect(raw).not.toContain("https://example.invalid");
});
shellTest("missing od falls back without inherited proof or context", () => {
  const [raw, command] = runShim(s => s.replaceAll("/usr/bin/od", "/not-present/ocx-od"));
  expect(raw).toBe(""); expect(command).toBe("claude");
});
shellTest("short random read falls back without context", () => {
  const [raw, command] = runShim(s => s.replace("-N32", "-N31"));
  expect(raw).toBe(""); expect(command).toBe("claude");
});
```

### Exact test-layout MODIFY diffs

```diff
--- a/scripts/test-layout/layout.json
+++ b/scripts/test-layout/layout.json
@@ explicit, before desktop-cli-contracts.test.ts (base line 850)
+    "desktop-cli-command-surface.test.ts": "clients",
     "desktop-cli-contracts.test.ts": "clients",
--- a/tests/fixtures/test-layout-expected.json
+++ b/tests/fixtures/test-layout-expected.json
@@ before desktop-cli-contracts.test.ts (base line 539)
+  "desktop-cli-command-surface.test.ts": "clients",
   "desktop-cli-contracts.test.ts": "clients", "desktop-exit-ownership.test.ts": "clients",
```

The filesystem path is `tests/clients/desktop-cli-command-surface.test.ts`; registration keys are basenames, not full paths. Run both root layout guards explicitly because source-read contract tests and JSON registrations are not discovered solely by import graph.

## Rust in-module tests and activation grounding

The NEW Rust files consist of the production blocks above plus the applicable cfg(test) block below. Their syntax is checked from stdin; type correctness and Clippy are intentionally unverified here. Additional required acceptance cases below are named Rust test requirements, as requested; their platform/fixture seams must be implemented and their assertions reviewed before wp1 readiness. No new dev dependency: use an RAII tempdir built from `std::env::temp_dir()` and UUID, so every filesystem test runs under a disposable user-owned directory and removes it on Drop. Additional packaged/native acceptance and independent reviews belong to 030.

Append to `cli_command_record.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self { let p = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("ocx-cli-{}", Uuid::new_v4())); private_dir(&p).unwrap(); Self(p) }
        fn store(&self) -> Store { Store::open(self.0.join("record"), vec![self.0.join(".zshrc")]).unwrap() }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn record_roundtrip_and_unknown_version_refusal() {
        let t = Temp::new(); let s = t.store(); let r = Record::fresh("installation".into());
        s.save(&r).unwrap(); assert_eq!(s.read().unwrap(), Some(r.clone()));
        let mut bad = r; bad.version = 2; assert_eq!(s.validate(&bad, false).unwrap_err(), "record-invalid");
    }
    #[test]
    fn corrupt_record_does_not_become_first_run() {
        let t = Temp::new(); let s = t.store();
        atomic(&s.root.join("cli.json"), None, b"{", 0o600).unwrap();
        assert_eq!(s.read().unwrap_err(), "record-invalid");
    }
    #[test]
    fn lock_serializes_and_is_released_on_close() {
        let t = Temp::new(); let s = t.store();
        assert!(Store::open(s.root.clone(), s.rc_allowed.clone()).is_err());
        drop(s); let _ = t.store();
    }
    #[test]
    fn pending_journal_recovers_each_prefix_and_is_idempotent() {
        for prefix in 0..=2 {
            let t = Temp::new(); let s = t.store(); let mut r = Record::fresh("installation".into());
            let mut next = r.clone(); next.generation += 1;
            let changes: Vec<_> = [s.root.join("bin/ocx"), s.root.join("path.sh")].into_iter().map(|p| Change {
                kind: "file".into(), path: p.to_string_lossy().into_owned(), before: None, after: Some(b"new".to_vec()), mode: 0o600, backup_path: None,
            }).collect();
            for c in changes.iter().take(prefix) { atomic(Path::new(&c.path), None, c.after.as_ref().unwrap(), 0o600).unwrap(); }
            r.pending = Some(Journal { operation: "install".into(), changes, next: Box::new(next.clone()) }); s.save(&r).unwrap();
            s.recover(&mut r).unwrap(); assert_eq!(r, next); s.recover(&mut r).unwrap();
        }
    }
    #[test]
    fn journal_conflict_preserves_user_edit_and_disabled_intent() {
        let t = Temp::new(); let s = t.store(); let p = t.0.join(".zshrc");
        atomic(&p, None, b"user edit", 0o600).unwrap();
        let mut r = Record::fresh("installation".into()); r.enabled = false;
        let mut next = r.clone(); next.generation += 1;
        r.pending = Some(Journal { operation: "remove".into(), changes: vec![Change {
            kind: "file".into(), path: p.to_string_lossy().into_owned(), before: Some(b"old".to_vec()), after: None, mode: 0o600, backup_path: None,
        }], next: Box::new(next) }); s.save(&r).unwrap();
        assert_eq!(s.recover(&mut r).unwrap_err(), "journal-conflict");
        assert_eq!(fs::read(&p).unwrap(), b"user edit"); assert!(!s.read().unwrap().unwrap().enabled);
    }
    #[test]
    fn journal_cannot_address_an_arbitrary_path() {
        let t = Temp::new(); let s = t.store(); let mut r = Record::fresh("installation".into());
        let mut next = r.clone(); next.generation += 1;
        r.pending = Some(Journal { operation: "install".into(), changes: vec![Change {
            kind: "file".into(), path: t.0.join("unowned").to_string_lossy().into_owned(), before: None, after: Some(vec![]), mode: 0o600, backup_path: None,
        }], next: Box::new(next) }); assert_eq!(s.validate(&r, false).unwrap_err(), "record-invalid");
    }
    #[test]
    fn atomic_write_detects_changed_original() {
        let t = Temp::new(); let p = t.0.join("file"); atomic(&p, None, b"user", 0o600).unwrap();
        assert_eq!(atomic(&p, Some(b"old"), b"replacement", 0o600).unwrap_err(), "concurrent-edit");
        assert_eq!(fs::read(p).unwrap(), b"user");
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_special_files_and_readonly_files_are_refused() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let t = Temp::new(); let p = t.0.join("file"); atomic(&p, None, b"bytes", 0o600).unwrap();
        symlink(&p, t.0.join("link")).unwrap(); assert!(read_bytes(&t.0.join("link")).is_err());
        assert!(check(&t.0, false).is_err());
        fs::set_permissions(&p, fs::Permissions::from_mode(0o400)).unwrap(); assert!(read_bytes(&p).is_err());
    }
}
```

Append to `cli_command_posix.rs`:

```rust
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn root() -> PathBuf { fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("ocx-posix-{}", uuid::Uuid::new_v4())) }
    #[test]
    fn rc_edit_is_idempotent_and_repositions_after_later_npm_prepend() {
        let t = root(); record::private_dir(&t).unwrap();
        let p = t.join(".zshrc"); let b = block("zsh", &t).unwrap();
        let first = edit_rc(b"export PATH=/npm:$PATH\n", &b, false).unwrap();
        record::atomic(&p, None, &first, 0o600).unwrap();
        assert_eq!(edit_rc(&first, &b, false).unwrap(), first);
        let later = [first.as_slice(), b"export PATH=/later:$PATH\n"].concat();
        let repaired = edit_rc(&later, &b, false).unwrap();
        assert!(repaired.ends_with(b.as_bytes()));
        assert_eq!(edit_rc(&repaired, &b, true).unwrap(), b"export PATH=/npm:$PATH\nexport PATH=/later:$PATH\n");
        fs::remove_dir_all(t).unwrap();
    }
    #[test]
    fn broken_duplicate_nested_or_modified_blocks_are_refused() {
        let b = block("bash", Path::new("/example/record")).unwrap();
        for bytes in [START.to_owned(), END.to_owned(), format!("{b}{b}"),
            format!("{START}\n{START}\n{END}\n{END}\n"), b.replace("if [ -r", "if [ -w")] {
            assert!(edit_rc(bytes.as_bytes(), &b, false).is_err());
            assert!(edit_rc(bytes.as_bytes(), &b, true).is_err());
        }
    }
    #[test]
    fn rc_newlines_and_outside_bytes_survive_removal() {
        let b = block("zsh", Path::new("/example/record")).unwrap();
        let original = b"# user's config\r\nexport PATH=\"/npm:$PATH\"\r\n";
        let installed = edit_rc(original, &b, false).unwrap();
        assert_eq!(edit_rc(&installed, &b, true).unwrap(), original);
        assert!(edit_rc(b"a\r\nb\n", &b, false).is_err());
        assert!(edit_rc(&[0xff], &b, false).is_err());
    }
    #[test]
    fn quoting_and_invalid_path_contract_is_exact() {
        assert_eq!(quote(Path::new("/example/a'b")).unwrap(), "'/example/a'\"'\"'b'");
        for s in ["relative", "/example/a:b", "/example/a\nb"] { assert!(quote(Path::new(s)).is_err()); }
    }
    #[test]
    fn development_and_temporary_launches_are_refused_before_installation() {
        assert_eq!(stable_bundle(Path::new("/example/app"), true, "1").unwrap_err(), "development-launch");
        for p in ["/Volumes/DMG/App.app/Contents/MacOS/app", "/private/var/folders/a/AppTranslocation/b/App.app/Contents/MacOS/app", "/tmp/.mount_example/usr/bin/app"] {
            assert_eq!(stable_bundle(Path::new(p), false, "1").unwrap_err(), "temporary-bundle");
        }
    }
}
```

Append to `cli_command_windows.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepend_preserves_raw_expansions_type_and_empty_entries() {
        let raw = r"%APPDATA%\npm;;C:\Tools;";
        for ty in ["REG_SZ", "REG_EXPAND_SZ"] {
            let (out, owned) = prepend(raw, r"C:\Program Files\OpenCodex", ty).unwrap();
            assert_eq!(out, format!(r"C:\Program Files\OpenCodex;{raw}"));
            assert_eq!(owned.value_type, ty); assert_eq!(owned.action, "inserted");
            assert_eq!(remove(&out, &owned).unwrap(), raw);
        }
    }
    #[test]
    fn moved_existing_entry_is_restored_and_same_entry_repair_keeps_ownership() {
        let raw = r"A;C:\Desktop;B";
        let (out, owned) = prepend(raw, r"c:/desktop/", "REG_SZ").unwrap();
        assert_eq!(owned.action, "moved-existing");
        let (twice, retained) = replace_owned_entry(&out, Some(&owned), r"C:\Desktop", "REG_SZ").unwrap();
        assert_eq!(twice, out); assert_eq!(retained, owned); assert_eq!(remove(&out, &owned).unwrap(), raw);
    }
    #[test]
    fn removal_preserves_concurrent_unrelated_entries_and_ambiguity() {
        let (out, owned) = prepend(r"A;B", r"C:\Desktop", "REG_EXPAND_SZ").unwrap();
        assert_eq!(remove(&format!("{out};NEW"), &owned).unwrap(), "A;B;NEW");
        let (out, moved) = prepend(r"A;C:\Desktop;B", r"C:\Desktop", "REG_SZ").unwrap();
        assert_eq!(remove(&out.replace("A;B", "A;NEW;B"), &moved).unwrap_err(), "path-restore-ambiguous");
    }
    #[test]
    fn replacing_owned_entry_removes_only_the_previous_insertion() {
        let (out, old) = prepend("A;B", r"C:\Old", "REG_SZ").unwrap();
        let (new, owned) = replace_owned_entry(&out, Some(&old), r"C:\New", "REG_SZ").unwrap();
        assert_eq!(new, r"C:\New;A;B"); assert_eq!(remove(&new, &owned).unwrap(), "A;B");
    }
    #[test]
    fn duplicate_invalid_and_oversize_entries_are_refused() {
        assert!(prepend(r"C:\Desktop;c:/desktop/", r"C:\Desktop", "REG_SZ").is_err());
        assert!(prepend("A", "bad;entry", "REG_SZ").is_err());
        assert!(prepend("A", r"C:\Desktop", "REG_BINARY").is_err());
        assert!(prepend(&"X".repeat(32_767), r"C:\Desktop", "REG_SZ").is_err());
    }
}
```

The following additional tests are implementation acceptance requirements rather than executed planning evidence. They require small fixture seams around target selection/stable-bundle observation and the orchestration action executor; the implementer must add the seams and tests in-module before marking wp1 ready. Do not claim their names alone prove the branches. Keep these seam additions within the four module budgets.

| Guard / branch activated | Required named evidence |
|---|---|
| Fresh absent record defaults on; existing disabled record Repair/Reconcile stays off; Remove persists off before any cleanup | `fresh_stable_bundle_installs_without_npm`, `disabled_record_survives_relaunch_and_repair`, `remove_persists_disabled_intent_before_first_cleanup_write`, `disabled_pending_install_rolls_back_completed_prefix` |
| Invalid version/UUID/digest/schema/platform/section/journal nesting/path; oversized input and safe-JS generation ceiling | `record_roundtrip_and_unknown_version_refusal`, `corrupt_record_does_not_become_first_run`, `journal_cannot_address_an_arbitrary_path`, `record_validation_rejects_every_malformed_field`, `oversize_serialized_journal_is_refused_before_save` |
| Lock contention, writer crash, same-process action overlap, IO error and blocking-worker join failure | `lock_serializes_and_is_released_on_close`, `crashed_lock_owner_allows_journal_recovery`, `actions_are_serialized`, `io_failure_keeps_app_running`, `worker_failure_is_visible` |
| Missing/foreign/readonly/symlink/special target or parent, bad UTF-8/newline, duplicate/nested/incomplete/edited markers | `symlinks_special_files_and_readonly_files_are_refused`, `foreign_owner_is_refused`, `broken_duplicate_nested_or_modified_blocks_are_refused`, `rc_newlines_and_outside_bytes_survive_removal`, `missing_external_rc_parent_is_partial`, `fresh_default_fish_parents_are_created_without_chmod_existing_config` |
| Changed source between snapshot and rename, failed backup creation/fsync/rename/unlink | `atomic_write_detects_changed_original`, `backup_failure_prevents_edit`, `rename_failure_keeps_journal`, `unlink_failure_keeps_disabled_record` |
| Journal target before/after/third state; crash before/after every artifact write and final save; backup already equal/different | `pending_journal_recovers_each_prefix_and_is_idempotent`, `journal_conflict_preserves_user_edit_and_disabled_intent`, `journal_after_write_before_final_save_recovers`, `backup_conflict_is_refused` |
| Stable macOS path accepted; debug/source, AppTranslocation, /Volumes, canonical symlink-to-temporary rejected; missing/nonexecutable sibling CLI | `stable_macos_bundle_is_accepted`, `development_and_temporary_launches_are_refused_before_installation`, `canonical_temporary_bundle_is_refused`, `missing_or_nonexecutable_bundle_cli_is_refused` |
| Stable Windows sibling ocx.exe; development target/temp or sibling absent; Linux exact /usr/bin/ocx, AppImage/APPDIR/extracted layout | `windows_bundle_requires_sibling_cli`, `linux_deb_requires_installed_usr_bin_cli`, `appimage_environment_and_extracted_layout_are_refused` |
| Absolute ZDOTDIR used, relative/absent fallback; fish XDG fallback; first existing Bash login candidate including unsafe candidate; no login candidate | `zdotdir_and_xdg_selection_match_desktop_environment`, `bash_active_login_file_is_selected_without_creation`, `login_file_absent_is_partial` |
| Generated file absent/owned-identical/owned-old-version/unowned/user-modified; rc block absent/owned EOF/owned followed by npm/unowned exact | `owned_files_repair_after_bundle_move`, `owned_file_conflict_is_not_overwritten`, `generated_permissions_changed_are_refused`, `rc_edit_is_idempotent_and_repositions_after_later_npm_prepend`, `unrecorded_exact_block_is_not_adopted` |
| Remove absent block/file; only whitespace in installer-created rc; other content in preexisting/created rc; modified rc keeps helper and ownership | `remove_deletes_only_owned_artifacts`, `remove_retains_nonempty_created_rc`, `modified_rc_keeps_helper_until_cleanup_is_safe` |
| Proof utilities/urandom available, missing od/awk/urandom, short/error/malformed output, empty exports and duplicate proof argv | TS `shim proof is accepted by the actual initializer and captures only nonempty exports`, `missing od falls back without inherited proof or context`, `short random read falls back without context`; add `missing_awk_or_urandom_falls_back`, `duplicate_internal_proofs_are_untrusted`; packaged `ocx claude` acceptance in 030 |
| PATH unset/empty/empty interior elements/existing Desktop duplicates | `path_helper_preserves_empty_entries_and_prepends_once` (run `/bin/sh` against generated helper and a supplied child env) |
| Windows insert/move/same repair/replacement; missing owned entry; adjacent anchors removed or ambiguous; duplicates/oversize/type errors | `prepend_preserves_raw_expansions_type_and_empty_entries`, `moved_existing_entry_is_restored_and_same_entry_repair_keeps_ownership`, `removal_preserves_concurrent_unrelated_entries_and_ambiguity`, `replacing_owned_entry_removes_only_the_previous_insertion`, `duplicate_invalid_and_oversize_entries_are_refused`, `missing_owned_path_is_idempotent` |
| Raw registry value missing/REG_SZ/REG_EXPAND_SZ/bad UTF-16/unsupported/type changed/concurrent raw edit, read/write denial | Windows cfg tests `registry_roundtrip_preserves_type_and_unexpanded_text`, `registry_type_change_blocks_recovery`, `registry_denial_keeps_disabled_intent`; no Ubuntu/native claim |
| Machine PATH existing CLI / clean / unresolved expansion / read denial; broadcast success/timeout | Injected `machine_path_conflict_is_partial`, `machine_path_unobserved_is_partial`, `broadcast_failure_is_partial`; real Windows evidence in 030 |
| Local page main valid spelling; wrong label/origin/scheme/path/query/fragment/unreadable URL; tray/window/navigation failure | `cli_page_is_exact_local_origin_and_path`, source `registers four path-free commands and guards every wrapper`; native `wrong_label_and_unreadable_url_are_refused`, `tray_navigation_failure_is_visible` |
| CLI page during Launch/Recover; user explicitly Back; UI absent bridge/unknown phase/error/timeout/busy/poll overlap | source `ready completion preserves CLI settings during launch and recovery`, `missing Tauri disables controls and states the entry point`, `UI never sends an arbitrary path and only toggles a boolean`; VM `unknown_status_and_timeout_are_visible`, `overlapping_clicks_send_one_write` |

These test additions are essential remaining implementation work, not a request to run a suite in this planning worker. Parent should require the names to exist and assertion activation to be reviewed, rather than treating this table as test evidence.

## MODIFY owning and public documentation

Append the following section immediately before `## Release packaging and updater` (`structure/desktop-shell.md:418`). This is a present-tense contract accompanying the implemented behavior, not an implementation diary. It adds 26 lines, leaving 28 of the 600-line budget at the fixed base. The manifest already maps the desktop source area; review fan-out includes existing runtime ownership prose, but this record creates no runtime authority and needs no duplicate statement there.

```diff
@@ before Release packaging and updater
+## Desktop-owned terminal command
+
+`desktop/src-tauri/src/cli_command.rs` schedules one blocking reconcile after launch-origin
+adoption, independently of proxy startup. A stable release install configures the terminal
+command by default; a disabled choice survives launch and removal. AppImage, temporary,
+translocated, debug and unpackaged launches do not install it.
+
+`desktop/src-tauri/src/cli_command_record.rs` owns the single private user-home
+`.opencodex-desktop/cli.json` record, OS-backed lock and pending journal. The record describes
+generated-file ownership only; it grants no runtime, service or shutdown authority. Invalid
+records block automatic mutation. Pending changes recover only from recorded before/after bytes.
+
+`desktop/src-tauri/src/cli_command_posix.rs` generates a fail-closed shim, shared PATH helper
+and final managed zsh/bash/fish blocks. It refuses unsafe files and changed/unowned blocks.
+The shim captures nonempty exported Anthropic slot names with an argv-bound random proof
+before dotenv; inability to generate the proof retains compiled-CLI stripping behavior.
+
+`desktop/src-tauri/src/cli_command_windows.rs` preserves raw HKCU Path text/type, changes only
+the owned entry and broadcasts Environment. Machine-Path conflicts are partial; already-open
+shells are unobserved. Windows direct execution retains current Anthropic stripping behavior.
+
+The bundled `desktop/ui/cli.html` page uses four path-free commands guarded by the main
+window's exact local page URL. The tray's Terminal command item opens it. Removal stores off
+intent before cleanup and preserves modified user files. Configuration is not a guarantee
+against aliases, absolute commands, shell caches, skipped startup files or later PATH changes.
+
 ## Release packaging and updater
```

English exact text, inserted before `## Updates` (`docs-site/src/content/docs/guides/desktop-app.md:169`):

```diff
@@ before Updates
+## Terminal command
+
+On a stable macOS app, Windows installation, or installed Linux deb, Desktop automatically
+configures its bundled `ocx` for new terminals at launch. Choose **Terminal command…** in
+the tray menu to turn this off, repair it, or remove it. The off choice survives restarts.
+AppImage and development launches do not configure the terminal command.
+
+macOS and Linux use a Desktop-owned shim and managed zsh, bash and fish startup blocks.
+Windows prepends the installation directory to the user `Path`; a command in the system
+`Path` can still win. Open a new terminal and check `type -a ocx` on POSIX, or
+`Get-Command ocx -All` and `where.exe ocx` on Windows. Existing shells, aliases and later
+PATH changes can still select another command. A missing bundle makes the POSIX shim fail
+with repair/removal guidance instead of silently running an npm copy.
+
+POSIX preserves shell-exported Anthropic settings when launch-proof utilities are available.
+If proof generation is unavailable, and for Windows direct execution, the bundled CLI keeps
+its existing removal of untrusted Anthropic environment settings. Installer errors or
+system-Path conflicts are shown as partial or blocked configuration, not verified selection.
+
 ## Updates
@@ Uninstall, before On macOS
+Before uninstalling a supported Desktop installation, choose **Terminal command… → Remove
+terminal command**. Desktop removes only its unchanged managed configuration. Modified
+blocks or files are preserved and reported; resolve them before deleting the app. Removing
+the app directly does not guarantee cleanup of shell files or the user `Path`.
+
 On macOS, drag `OpenCodex.app` from Applications to the Trash. On Windows, remove
```

Korean exact text, inserted before `## 업데이트` (`docs-site/src/content/docs/ko/guides/desktop-app.md:61`):

```diff
@@ before 업데이트
+## 터미널 명령
+
+안정된 위치의 macOS 앱, Windows 설치본, 설치된 Linux deb에서는 Desktop이 시작할 때 새 터미널이 번들 `ocx`를 사용하도록 자동 설정합니다. 트레이의 **Terminal command…**에서 끄기, 복구, 제거를 선택할 수 있습니다. 꺼 둔 선택은 재시작 후에도 유지됩니다. AppImage와 개발 실행에서는 터미널 명령을 설정하지 않습니다.
+
+macOS와 Linux에서는 Desktop 소유 shim과 zsh, bash, fish 시작 파일의 관리 블록을 사용합니다. Windows에서는 설치 디렉터리를 사용자 `Path` 앞에 추가하며, 시스템 `Path`의 다른 명령이 먼저 선택될 수 있습니다. 새 터미널에서 POSIX는 `type -a ocx`, Windows는 `Get-Command ocx -All`과 `where.exe ocx`로 확인하세요. 이미 열려 있던 셸, 별칭, 이후 PATH 변경은 다른 명령을 선택할 수 있습니다. 번들이 사라지면 POSIX shim은 npm 복사본으로 조용히 전환하지 않고 복구 또는 제거 안내와 함께 실패합니다.
+
+POSIX에서는 launch proof 생성 도구가 있으면 셸에서 export한 Anthropic 설정을 보존합니다. proof를 생성할 수 없거나 Windows에서 직접 실행하는 경우에는 신뢰되지 않은 Anthropic 환경 설정을 제거하는 기존 번들 CLI 동작을 유지합니다. 설치 오류나 시스템 Path 충돌은 선택 성공으로 표시하지 않고 부분 적용 또는 차단으로 표시합니다.
+
 ## 업데이트
@@ 제거, before macOS에서는
+지원되는 Desktop 설치본을 제거하기 전에 **Terminal command… → Remove terminal command**를 선택하세요. Desktop은 변경되지 않은 자신의 관리 설정만 제거합니다. 사용자가 수정한 블록이나 파일은 보존하고 알려 주므로, 앱을 삭제하기 전에 처리하세요. 앱만 직접 제거하면 셸 파일이나 사용자 `Path` 정리가 보장되지 않습니다.
+
 macOS에서는 Applications의 `OpenCodex.app`을 휴지통으로 옮깁니다. Windows에서는 **Installed apps**에서 OpenCodex를 제거합니다. Debian 기반 Linux에서는 다음 명령을 실행합니다.
```

A read-only `rg -n -i` pass over all eight guide files exited 0 and exposed existing removal-first instructions in ja/fr/tr/ru/zh-cn/zh-tw as well as en/ko. It found no new Desktop PATH guarantees in the translated guides. This is discovery evidence, not semantic sign-off. Other locale review must inspect **all eight** desktop guide copies, not GUI translation catalogs. Search installer, first-run, terminal-command, PATH and uninstall sections; compare claims to English for default-on/off persistence, AppImage exclusion, no absolute guarantee, Windows machine/user Path and cleanup-before-delete. Existing locale pages primarily omit PATH behavior; omission alone is not a contradictory guarantee, but their old uninstall-only instructions are incomplete after this change. 030 owns translated follow-ups if needed. Do not mark locale consistency complete until a human reads the matches and records the affected locales; string matching/build success alone cannot establish semantic agreement.

## Guard layers, bypasses and residual risks (PLAN-BYPASS-NAMED-01)

This plan is E7 agent-followed direction: no CXC hook implements it. The arrow names the concrete proposed product/OS/CI executing surface after implementation, without inventing CXC hook tiers for ordinary Rust code. Wording is downgraded in **every row** to a configuration/ownership guard or early warning rather than universal command-selection enforcement. Final unbypassable command-selection layer: **none**.

| Mechanism | Tier / execution location | Known bypass | Residual risk / honest claim |
|---|---|---|---|
| Stable-bundle gate | E7 plan directive → packaged-app Rust guard | Same-user modifying/copying a release executable; Windows sibling layout is not signed-installer attestation | Prevents routine debug/temporary installs; not binary authenticity. Linux exact layout excludes extracted bundles but is not a dpkg signature check. |
| Record validation + permissions + OS lock | E7 plan directive → record writer / kernel lock | Same-user noncooperating edits, profile ACL changes | Cooperating Desktop writers serialize; hashes detect changed content, not hostile same-user control. Windows private-profile ACL is inherited. |
| Journal before mutation + atomic file rename | E7 plan directive → artifact writer | Noncooperating editor in last check-to-rename interval; power loss / registry lacks atomic rename | Conflict blocks and leaves journal; no claim of multi-file atomicity. Backups and before bytes allow inspection/recovery. |
| Exact generated-file/block ownership | E7 plan directive → install/remove | User replaces metadata and files together; rc returns early or stale .zwc compiled file bypasses text | Refuse unowned/changed files; preserve outside bytes. EOF position proves text placement, not executed shell control flow. |
| Shell PATH block/helper | E7 plan directive → new-shell initialization | `zsh -f`, startup early return, aliases/functions, hashed commands, later `nvm use`, explicit npm path, hidden .zshenv ZDOTDIR | Supported new-shell configuration only; parent-shell actual selection is unobserved by Rust. |
| HKCU Path prepend + broadcast | E7 plan directive → Windows environment construction | Machine Path, cwd lookup, app execution aliases, old Terminal parent env, PATH rewrite | Conflicts are partial; restart terminal and inspect native selection. Broadcast does not refresh existing cmd/PowerShell. |
| Fail-closed POSIX shim | E7 plan directive → terminal shim invocation | Explicit unrelated executable, replaced same-user shim, another command before shim | Missing/nonexecutable bundle fails 127; exec failure remains an error, no npm search. |
| argv-bound random launch proof | E7 plan directive → pre-dotenv shim / initializer | Same-user process able to control argv/env; missing utilities; duplicate proof args | Preserves normal shell export provenance; not OS authentication. Fallback keeps existing stripping. Independent security review required. |
| Exact local-page command guard | E7 plan directive → each native wrapper before IO | Determined same-user process acting outside Tauri | Blocks ordinary remote webview/main-page IPC misuse; UI cannot select arbitrary targets. Not an OS-user boundary. |
| File-size / structure / test-layout gates | E7 execution directive → repository static CI | Unregistered NEW file outside index; Rust isn't ratchet-scanned; declarations with weak assertions | Stage only implementation files when authorized; inspect tests, keep explicit Rust budgets. Passing gates do not prove native behavior. |
| Independent security/code review | E7 parent-owned 030 review | Reviewer blind spots / missing native evidence | Requires explicit verdicts and known coverage limits; no review claimed by this plan. |

## File budgets and ratchets

`THRESHOLD=2000` at `scripts/file-size-ratchet.ts:4`; `.rs` and `.html` are absent from SCAN_EXTENSIONS at :7, `.js/.ts/.json/.md` are scanned. `devlog/` is excluded at :22, so this detailed plan is not a product-file ratchet exception. `tests/fixtures/file-size-baseline.json:18` starts the cap map; none of this phase's existing scanned targets has an individual ratchet cap. Do not add or raise caps. `structure/manifest.json:3` sets **600 lines**, independently of the generic 2000-line guard. Do not edit manifest budget or baseline to accommodate growth.

| File(s) | Base lines | Limit / proposed budget | Decision |
|---|---:|---:|---|
| `structure/desktop-shell.md` | 546 | 600 / +26 = 572 | 28 lines remain for concurrent L1 changes; remeasure after rebase and compress/split if needed. |
| `desktop/src-tauri/src/startup.rs` | 2609 | .rs not scanned / +4 | Thin scheduling + page guard only; do not grow orchestration here. |
| `desktop/src-tauri/src/lib.rs` | 388 | .rs not scanned / <=465 | Wrappers/registration/state only. |
| `desktop/src-tauri/src/window.rs` | 357 | .rs not scanned / <=415 | URL guard + tests. |
| `desktop/src-tauri/src/tray.rs` | 637 | .rs not scanned / <=645 | One item and dispatch arm. |
| NEW `cli_command.rs` | 0 | team budget <=220 | Includes orchestration regression seams/tests. |
| NEW `cli_command_record.rs` | 0 | team budget <=600 | Schema/lock/IO/recovery and failure tests. |
| NEW `cli_command_posix.rs` | 0 | team budget <=600 | Exact scripts + pure edits + filesystem tests. |
| NEW `cli_command_windows.rs` | 0 | team budget <=420 | Pure transforms + minimal FFI + portable/native tests. |
| NEW `cli.html` / `cli.js` | 0 | HTML manual <=90 / JS ratchet 2000, plan <=160 | Native local page only. |
| NEW source-contract TS test | 0 | 2000 / <=230 | Dedicated sibling test; don't enlarge desktop-update-surface.test.ts. |
| `scripts/test-layout/layout.json` / `tests/fixtures/test-layout-expected.json` | 1981 / 1179 | 2000 / +1 each = 1982 / 1180 | Both exact registrations required. |
| desktop guide en/ko | 207 / 85 | 2000 / +24 en, +10 ko | Check localized copies semantically. |

Rust budgets are planning caps, not existing mechanical enforcement. Future growth beyond one is a plan amendment, not justification to loosen the existing repository ratchet.

## Verifier receipts (PLAN-VERIFIER-REAL-01)

All shell commands used the delegated repository root as workdir. No product code was created and no test suite was run. Commands below are distinguished from implemented-feature evidence. Validation commands read the current checkout, so a 0 here proves baseline compatibility only. Run-once discovery help commands do **not** claim to read new Rust files.

| Exact command / observation | Exit | Does it read this change's targets? |
|---|---:|---|
| In-memory NEW Rust block extraction → `rustfmt --edition 2021 --emit stdout` on stdin, for each of four files plus its supplied cfg tests | 0 each | Reads the code printed in this NEW plan. Syntax parsing only, not symbol/type/Clippy/test validation; does not write product files. |
| In-memory `cli.js` block extraction → `node --check` on stdin | 0 | Reads the exact NEW JS code in this plan; syntax only, does not execute UI. |
| `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check` | 0 | Reads current Rust module graph; NEW Rust modules only after creation and mod registration. |
| `cargo clippy --help` | 0 | No; command interface discovery only. |
| `cargo test --help` | 0 | No; command interface discovery only. |
| `bun run typecheck` | 1 | Invoked current tsconfig (`tsconfig.json:15`, `include: ["src"]`), failed TS2688 missing `bun-types`. This command does not observe wp1 Rust/UI/test changes; it is a parent integration prerequisite, not this phase's verifier. |
| `bun run structure:check` | 0 | Reads current owning doc/manifest/index (`scripts/structure-ssot.ts:294`, runStructureChecks; `:352`, document reads); NEW paths require implementation staging because this gate uses the index. Does not inspect this devlog plan. |
| `bun run privacy:scan` | 0 | Reads tracked/source tree according to scanner, includes only indexed unit documents (`scripts/privacy-scan.ts:60`, gitLsFiles; `:410`, runScan). This NEW untracked plan was not observed; later staging/scanning must include it and implementation. No new-feature correctness proof. |
| `wc -l scripts/test-layout/layout.json tests/fixtures/test-layout-expected.json docs-site/src/content/docs/guides/desktop-app.md docs-site/src/content/docs/ko/guides/desktop-app.md` | 0 | Reads exact targeted JSON/doc line counts: 1981/1179/207/85. |
| `bun scripts/file-size-ratchet.ts` | 0 | Scans indexed current eligible files/baseline (`scripts/file-size-ratchet.ts:134`, scanRepo/git ls-files); .rs/.html and devlog excluded. NEW JS/TS must be staged before meaningful final proof. |

Implementation commands that depend on missing NEW files are labeled **NEW 파일 생성 후 실행** (“run after NEW file creation”). They were not run as suites in this planning worker. Do not attach invented exit codes or treat the command's help receipt as the following command's result.

| Command | Execution status / change-target coverage |
|---|---|
| `cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings` | NEW 파일 생성 후 실행; not run (would compile/write artifacts outside the one-document scope). Reads registered modules and cfg test targets. |
| `cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_command -- --test-threads=1` | NEW 파일 생성 후 실행; not run (minimal-test plan-only boundary). Reads all four modules' named tests; window URL test is separately needed. |
| `cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_page_is_exact_local_origin_and_path` | NEW 파일 생성 후 실행; not run; directly activates the local-origin predicate. |
| `bun test tests/clients/desktop-cli-command-surface.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` | NEW 파일 생성 후 실행; not run; reads Rust/UI source as data and both layout JSON files. No import-graph coverage assumption. |
| `bun test tests/clients/desktop-update-surface.test.ts tests/clients/desktop-startup-surface.test.ts` | NEW 파일 생성 후 실행; not run per no-extra-suites instruction; later regression checks preserve update and startup source contracts. |
| `bun run typecheck` after dependencies are available | NEW 파일 생성 후 실행; baseline failure above must be resolved by parent without claiming it passed. |
| `bun run structure:check` / `bun run privacy:scan` / `bun scripts/file-size-ratchet.ts` | Actual baseline receipts above; repeat after new code/docs to read changed targets. Passing unchanged checks need no additional confidence reruns. |
| `bun --cwd docs-site install --frozen-lockfile` then `bun --cwd docs-site run build` | NEW 파일 생성 후 실행; not run: install/build writes dependencies/output outside delegated file scope. Required by docs-site/AGENTS.md at implementation; no documentation build claim. |
| packaged fresh POSIX shell / native Windows Path validation | Not run; 030 owns temporary-profile evidence, true platform selection and packaged `ocx claude`. Do not mutate a developer's own rc/registry. |

The user specifically constrained this worker to a single document and minimal local tests. That bound overrides a skill's general desire to execute implementation verifiers. Baseline fmt/structure/privacy/ratchet and command help were inexpensive read-oriented discovery; compiling a nonexistent implementation or running suites would provide no new-feature evidence.

## Handoff risks and required parent decisions

1. **No-tray Linux entry:** The accepted A6 tray entry cannot be reached on a Linux session with no tray host. The page can be served independently of the proxy, but no new bootstrap/dashboard entry was authorized in this slice. Parent should approve a fixed `cli.html` link in `desktop/ui/index.html` or another local entry and add that precise diff before wp1 implementation is accepted. This is a reported UI scope expansion, not an implemented file change.
2. **Platform proof:** Ubuntu Rust tests cover Path strings, not raw registry IO/WM_SETTINGCHANGE or cmd/PowerShell selection. macOS/Linux packaged CLI provenance must be checked with `ocx claude`; Windows explicitly retains existing stripping. Missing external ZDOTDIR/XDG parents and unsafe rc files are partial outcomes requiring user repair.
3. **Concurrent L1/doc edits:** Owning doc headroom is 28 lines after this proposal; L1 also changes this doc and the guides. Preserve the runtime-authority separation and remeasure against the integrated head. Source anchors are pinned to 68c9d35457 even though origin/dev has moved.
4. **Schema coordination:** 020 must use these exact field names, nullability and pending semantics. A public record is ownership metadata only. A pending install disabled before recovery rolls back only its completed prefix as defined by `Store::recover`; no launcher should select a pending target.
5. **Verification boundary:** Typecheck failed because bun-types is unavailable. No dependency installation, test suite, native behavior or independent review is claimed. Security analysis beyond these public design controls stays in scratch, under repository AGENTS.md.

Final plan self-check: all four complete NEW Rust production blocks and supplied test blocks parsed through rustfmt stdin with exit 0; complete NEW cli.js parsed through node --check stdin with exit 0. Markdown fences were balanced and the document contained zero personal-machine path occurrences. These checks inspect proposed text only. No production edit, test suite, branch operation, or native environment mutation was performed.
