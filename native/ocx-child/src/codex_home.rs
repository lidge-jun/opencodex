//! Serialization and ownership of the shared `CODEX_HOME`.
//!
//! The lifecycle lock and journal live under `OPENCODEX_HOME/child`, but `config.toml`, the
//! model catalog and `models_cache.json` live in `CODEX_HOME`, which two ocx-child installs
//! with different `OPENCODEX_HOME`s can share. Every command that writes those files first
//! takes a fixed lock file inside the canonical `CODEX_HOME` and checks a durable ownership
//! record there. The lock file is never deleted or replaced, so every process locks the same
//! inode. Ownership is never taken over by PID or timeout: a foreign, unreadable or corrupt
//! record refuses without mutation.
//!
//! Lock order everywhere: local lifecycle lock, then this lock, then the daemon start gate.
//! The guarantee covers ocx-child against ocx-child; a full OpenCodex install is detected
//! separately by `journal::assert_no_full_ocx_conflict`.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::journal::{remove_optional_file, validate_existing_journal_paths};
use crate::platform::{
    DirectoryIdentity, FileLock, LockAcquireError, constant_time_eq, directory_identity,
    random_hex, reject_symlink, write_private_atomic, write_regular_atomic,
};
use crate::state::ChildPaths;

pub const CODEX_HOME_LOCK_FILE: &str = ".ocx-child.lock";
pub const CODEX_HOME_OWNER_FILE: &str = ".ocx-child-owner.json";
pub const CODEX_HOME_OWNER_SCHEMA: &str = "ocx.child.codex-home-owner/1";
const MAX_OWNER_RECORD_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OwnershipPhase {
    Attaching,
    Attached,
    Detaching,
    CleanupComplete,
}

/// Durable ownership record stored in `CODEX_HOME`. Holds no credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexHomeOwnerRecord {
    pub schema: String,
    pub owner_id: String,
    pub opencodex_home: String,
    pub opencodex_home_identity: DirectoryIdentity,
    pub codex_home: String,
    pub codex_home_identity: DirectoryIdentity,
    pub phase: OwnershipPhase,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexHomeError {
    /// Another process holds the lock (non-blocking acquisition only).
    Busy,
    /// `CODEX_HOME` does not exist and the caller did not ask to create it.
    Missing,
    /// The home is owned by a different OpenCodex home, or the record cannot be trusted.
    Refused(String),
    Io(String),
}

impl CodexHomeError {
    pub fn message(&self) -> String {
        match self {
            Self::Busy => "Codex home is locked by another ocx-child lifecycle command".to_owned(),
            Self::Missing => "Codex home does not exist".to_owned(),
            Self::Refused(msg) | Self::Io(msg) => msg.clone(),
        }
    }
}

/// Failure of one guarded restoration step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestoreStepError {
    /// A home no longer matches its captured identity; restoration must stop and keep every
    /// recovery record.
    HomeChanged(String),
    /// The write or removal itself failed.
    Failed(String),
}

impl RestoreStepError {
    pub fn into_message(self) -> String {
        match self {
            Self::HomeChanged(msg) | Self::Failed(msg) => msg,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimPolicy {
    /// Claim an unowned home, or continue owning ours. Refuses while our detach is incomplete.
    Attach,
    /// Continue an attachment: ours in an attach phase, or adopt an unowned home whose journal
    /// already belongs to this OpenCodex home.
    Continue,
    /// Restore and release: never claims an unowned home, refuses only a foreign owner.
    Detach,
}

enum OwnerStatus {
    Absent,
    Ours(CodexHomeOwnerRecord),
    Foreign(String),
}

/// Proof that this process holds the `CODEX_HOME` lock and that the home is unowned or owned
/// by this OpenCodex home. Journal application and restoration take it as a parameter.
pub struct CodexHomeGuard {
    _lock: FileLock,
    paths: ChildPaths,
    opencodex_identity: DirectoryIdentity,
    codex_identity: DirectoryIdentity,
    owner: Option<CodexHomeOwnerRecord>,
    newly_claimed: bool,
    phase_before_claim: Option<OwnershipPhase>,
}

fn canonical_utf8(path: &Path, what: &str) -> Result<(PathBuf, String), CodexHomeError> {
    let canonical = fs::canonicalize(path).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            CodexHomeError::Missing
        } else {
            CodexHomeError::Io(format!("cannot resolve {what}: {e}"))
        }
    })?;
    let text = canonical
        .to_str()
        .ok_or_else(|| CodexHomeError::Io(format!("{what} is not UTF-8")))?
        .to_owned();
    Ok((canonical, text))
}

fn create_codex_home(path: &Path) -> Result<(), CodexHomeError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|e| CodexHomeError::Io(format!("cannot create Codex home: {e}")))
}

impl CodexHomeGuard {
    /// Lock `CODEX_HOME` and classify its owner, then apply `policy`.
    pub fn acquire(
        paths: &ChildPaths,
        blocking: bool,
        create_codex_home_if_missing: bool,
        policy: ClaimPolicy,
    ) -> Result<Self, CodexHomeError> {
        if create_codex_home_if_missing {
            create_codex_home(&paths.codex_home)?;
        }
        let (ocx, _) = canonical_utf8(&paths.opencodex_home, "OpenCodex home").map_err(|e| {
            if e == CodexHomeError::Missing {
                CodexHomeError::Io("OpenCodex home does not exist".to_owned())
            } else {
                e
            }
        })?;
        let (codex, _) = canonical_utf8(&paths.codex_home, "Codex home")?;
        let opencodex_identity = directory_identity(&ocx).map_err(CodexHomeError::Io)?;
        let codex_identity = directory_identity(&codex).map_err(CodexHomeError::Io)?;
        let canonical = ChildPaths::new(ocx, codex);
        let lock = FileLock::acquire_in_existing_dir(&canonical.codex_lock_path(), blocking)
            .map_err(|e| match e {
                LockAcquireError::Busy => CodexHomeError::Busy,
                LockAcquireError::Io => {
                    CodexHomeError::Io("cannot open the Codex home lock file".to_owned())
                }
            })?;
        let mut guard = Self {
            _lock: lock,
            paths: canonical,
            opencodex_identity,
            codex_identity,
            owner: None,
            newly_claimed: false,
            phase_before_claim: None,
        };
        // The directory could have been replaced between resolution and locking.
        guard.verify_homes().map_err(CodexHomeError::Refused)?;
        guard.apply_policy(policy)?;
        Ok(guard)
    }

    /// Canonical paths of the locked homes; use these for every guarded file operation.
    pub fn paths(&self) -> &ChildPaths {
        &self.paths
    }

    pub fn is_owner(&self) -> bool {
        self.owner.is_some()
    }

    /// True when this guard created the ownership record (first attach).
    pub fn newly_claimed(&self) -> bool {
        self.newly_claimed
    }

    pub fn phase(&self) -> Option<OwnershipPhase> {
        self.owner.as_ref().map(|r| r.phase)
    }

    /// Confirm both homes are still the directories identified when the lock was taken.
    pub fn verify_homes(&self) -> Result<(), String> {
        let ocx = directory_identity(&self.paths.opencodex_home)
            .map_err(|e| format!("OpenCodex home changed during the operation: {e}"))?;
        let codex = directory_identity(&self.paths.codex_home)
            .map_err(|e| format!("Codex home changed during the operation: {e}"))?;
        if ocx != self.opencodex_identity || codex != self.codex_identity {
            return Err(
                "a home directory was replaced during the operation; recovery records were kept"
                    .to_owned(),
            );
        }
        Ok(())
    }

    /// Run one restoration write, rename or removal, re-verifying both home identities
    /// immediately before and immediately after it. Paths must come from `paths()`.
    ///
    /// This narrows, but cannot close, the window between the check and the system call: a
    /// process running as the same user can still swap a directory in between. Such a process
    /// gains nothing from that, since it can already write these files directly.
    pub fn restore_step<T>(
        &self,
        op: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, RestoreStepError> {
        crate::test_hooks::barrier("restore-before-write");
        self.verify_homes().map_err(RestoreStepError::HomeChanged)?;
        let out = op().map_err(RestoreStepError::Failed);
        crate::test_hooks::barrier("restore-after-write");
        self.verify_homes().map_err(RestoreStepError::HomeChanged)?;
        out
    }

    fn read_owner(&self) -> Result<OwnerStatus, CodexHomeError> {
        let record_path = self.paths.codex_owner_path();
        let corrupt = |detail: String| {
            CodexHomeError::Refused(format!(
                "Codex home ownership record {} is unreadable ({detail}); refusing to modify this \
                 Codex home. Remove it only after confirming no ocx-child uses this Codex home.",
                record_path.display()
            ))
        };
        reject_symlink(&record_path).map_err(&corrupt)?;
        let file = match fs::File::open(&record_path) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(OwnerStatus::Absent),
            Err(e) => return Err(corrupt(e.to_string())),
        };
        let mut bytes = Vec::new();
        file.take(MAX_OWNER_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| corrupt(e.to_string()))?;
        if bytes.len() as u64 > MAX_OWNER_RECORD_BYTES {
            return Err(corrupt("record exceeds size limit".to_owned()));
        }
        let record: CodexHomeOwnerRecord =
            serde_json::from_slice(&bytes).map_err(|e| corrupt(e.to_string()))?;
        if record.schema != CODEX_HOME_OWNER_SCHEMA {
            return Err(corrupt(format!("unsupported schema {}", record.schema)));
        }
        let ours = record.opencodex_home == path_text(&self.paths.opencodex_home)
            && record.opencodex_home_identity == self.opencodex_identity
            && record.codex_home == path_text(&self.paths.codex_home)
            && record.codex_home_identity == self.codex_identity
            && self
                .local_owner_id()
                .map_err(CodexHomeError::Io)?
                .is_some_and(|id| constant_time_eq(id.as_bytes(), record.owner_id.as_bytes()));
        if ours {
            return Ok(OwnerStatus::Ours(record));
        }
        Ok(OwnerStatus::Foreign(format!(
            "Codex home {} is owned by another ocx-child (OPENCODEX_HOME={}); run \
             `ocx-child detach` with that OPENCODEX_HOME first. If that home no longer exists, \
             remove {} after confirming no ocx-child uses this Codex home.",
            self.paths.codex_home.display(),
            record.opencodex_home,
            record_path.display()
        )))
    }

    fn local_owner_id(&self) -> Result<Option<String>, String> {
        reject_symlink(&self.paths.owner_id_file)?;
        match fs::read(&self.paths.owner_id_file) {
            Ok(bytes) => {
                let text = String::from_utf8(bytes).unwrap_or_default();
                let id = text.trim();
                Ok(
                    (id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
                        .then(|| id.to_owned()),
                )
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("cannot read local owner id: {e}")),
        }
    }

    fn apply_policy(&mut self, policy: ClaimPolicy) -> Result<(), CodexHomeError> {
        match self.read_owner()? {
            OwnerStatus::Foreign(msg) => Err(CodexHomeError::Refused(msg)),
            OwnerStatus::Ours(record) => {
                let phase = record.phase;
                self.owner = Some(record);
                match (policy, phase) {
                    (ClaimPolicy::Detach, _) => Ok(()),
                    (ClaimPolicy::Attach, OwnershipPhase::Detaching)
                    | (ClaimPolicy::Continue, OwnershipPhase::Detaching)
                    | (ClaimPolicy::Continue, OwnershipPhase::CleanupComplete) => {
                        Err(CodexHomeError::Refused(
                            "a previous ocx-child detach of this Codex home is incomplete; \
                             run `ocx-child detach` again"
                                .to_owned(),
                        ))
                    }
                    (ClaimPolicy::Attach, _) => {
                        self.phase_before_claim = Some(phase);
                        self.set_phase(OwnershipPhase::Attaching)
                            .map_err(CodexHomeError::Io)
                    }
                    (ClaimPolicy::Continue, _) => Ok(()),
                }
            }
            OwnerStatus::Absent => match policy {
                ClaimPolicy::Detach => Ok(()),
                ClaimPolicy::Attach => {
                    // A journal of ours that targets another Codex home must not gain a
                    // second ownership record; journal validation reports the conflict.
                    validate_existing_journal_paths(&self.paths)
                        .map_err(CodexHomeError::Refused)?;
                    self.claim(OwnershipPhase::Attaching)
                }
                ClaimPolicy::Continue => match validate_existing_journal_paths(&self.paths) {
                    Ok(true) => self.claim(OwnershipPhase::Attached),
                    Ok(false) => Ok(()),
                    Err(e) => Err(CodexHomeError::Refused(e)),
                },
            },
        }
    }

    fn claim(&mut self, phase: OwnershipPhase) -> Result<(), CodexHomeError> {
        let owner_id = match self.local_owner_id().map_err(CodexHomeError::Io)? {
            Some(id) => id,
            None => {
                let id = random_hex(16).map_err(CodexHomeError::Io)?;
                write_private_atomic(&self.paths.owner_id_file, id.as_bytes())
                    .map_err(CodexHomeError::Io)?;
                id
            }
        };
        let record = CodexHomeOwnerRecord {
            schema: CODEX_HOME_OWNER_SCHEMA.to_owned(),
            owner_id,
            opencodex_home: path_text(&self.paths.opencodex_home),
            opencodex_home_identity: self.opencodex_identity.clone(),
            codex_home: path_text(&self.paths.codex_home),
            codex_home_identity: self.codex_identity.clone(),
            phase,
        };
        self.write_record(&record).map_err(CodexHomeError::Io)?;
        self.owner = Some(record);
        self.newly_claimed = true;
        Ok(())
    }

    fn write_record(&self, record: &CodexHomeOwnerRecord) -> Result<(), String> {
        self.verify_homes()?;
        let mut bytes = serde_json::to_vec_pretty(record)
            .map_err(|e| format!("cannot serialize ownership record: {e}"))?;
        bytes.push(b'\n');
        write_regular_atomic(&self.paths.codex_owner_path(), &bytes)
    }

    /// Durably record a new phase. A no-op when this guard does not own the home.
    pub fn set_phase(&mut self, phase: OwnershipPhase) -> Result<(), String> {
        let Some(mut record) = self.owner.clone() else {
            return Ok(());
        };
        if record.phase == phase {
            return Ok(());
        }
        record.phase = phase;
        self.write_record(&record)?;
        self.owner = Some(record);
        Ok(())
    }

    /// Undo this guard's claim after an attach failed without leaving changes behind: release
    /// a record this guard created, or put back the phase an existing record had.
    pub fn revert_claim(&mut self) -> Result<(), String> {
        if self.newly_claimed {
            return self.release();
        }
        match self.phase_before_claim.take() {
            Some(phase) => self.set_phase(phase),
            None => Ok(()),
        }
    }

    /// Release ownership after cleanup: durably mark cleanup complete, then remove the record,
    /// then the local owner id. A crash at any step leaves a record `detach` can resume from.
    pub fn release(&mut self) -> Result<(), String> {
        if self.owner.is_none() {
            return Ok(());
        }
        self.set_phase(OwnershipPhase::CleanupComplete)?;
        self.verify_homes()?;
        remove_optional_file(&self.paths.codex_owner_path())?;
        self.owner = None;
        self.newly_claimed = false;
        remove_optional_file(&self.paths.owner_id_file)
    }
}

fn path_text(path: &Path) -> String {
    path.to_str().unwrap_or_default().to_owned()
}
