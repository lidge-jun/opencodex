use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::codex_settings::HomeCodexSettingsDocument;
use crate::platform::{
    SecretBytes, SecretString, reject_symlink, volatile_zero_bytes, write_private_atomic,
};
use crate::relay_auth::token_fingerprint_hex;

pub const CHILD_STATE_SCHEMA: &str = "ocx.child.state/1";

#[derive(Debug, Clone)]
pub struct ChildPaths {
    pub opencodex_home: PathBuf,
    pub codex_home: PathBuf,
    pub child_dir: PathBuf,
    pub lock_file: PathBuf,
    pub state_file: PathBuf,
    pub key_file: PathBuf,
    pub journal_file: PathBuf,
    pub rollback_file: PathBuf,
    pub catalog_backup_file: PathBuf,
    /// Random owner id this OpenCodex home uses in a `CODEX_HOME` ownership record.
    pub owner_id_file: PathBuf,
}

impl ChildPaths {
    pub fn new(opencodex_home: PathBuf, codex_home: PathBuf) -> Self {
        let child_dir = opencodex_home.join("child");
        Self {
            lock_file: opencodex_home.join("child.lock"),
            state_file: child_dir.join("state.json"),
            key_file: child_dir.join("link-key"),
            journal_file: child_dir.join("codex-journal.json"),
            rollback_file: child_dir.join("attach-rollback.json"),
            catalog_backup_file: child_dir.join("last-catalog.json"),
            owner_id_file: child_dir.join("codex-home-owner-id"),
            opencodex_home,
            codex_home,
            child_dir,
        }
    }

    pub fn codex_config_path(&self) -> PathBuf {
        self.codex_home.join("config.toml")
    }

    pub fn codex_catalog_path(&self) -> PathBuf {
        self.codex_home.join("opencodex-catalog.json")
    }

    pub fn codex_models_cache_path(&self) -> PathBuf {
        self.codex_home.join("models_cache.json")
    }

    /// Fixed lock serializing every ocx-child that writes this `CODEX_HOME`; never removed.
    pub fn codex_lock_path(&self) -> PathBuf {
        self.codex_home
            .join(crate::codex_home::CODEX_HOME_LOCK_FILE)
    }

    pub fn codex_owner_path(&self) -> PathBuf {
        self.codex_home
            .join(crate::codex_home::CODEX_HOME_OWNER_FILE)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedSettingsRecord {
    pub link_id: String,
    pub fetched_at: String,
    pub applied_at: String,
    pub applied_at_ms: u64,
    pub digest: String,
    pub document: HomeCodexSettingsDocument,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildStateV1 {
    pub schema: String,
    pub link_id: String,
    pub api_key_id: String,
    pub token_fingerprint: String,
    pub tunnel_port: u16,
    pub listen_port: u16,
    pub connected_at: String,
    pub catalog_fingerprint: String,
    pub catalog_synced_at: String,
    pub daemon_pid: Option<u32>,
    pub daemon_started_at_ms: Option<u64>,
    pub shutdown_secret: SecretString,
    pub parity_sequence: u64,
    pub pending_operation: Option<String>,
    pub applied_settings: Option<AppliedSettingsRecord>,
    /// Random nonce of the most recent daemon start. A lifecycle-started daemon serves only
    /// if this still names its generation and its parent sent the matching commit line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_generation: Option<String>,
}

pub fn is_valid_daemon_generation(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug)]
pub enum StateReadOutcome {
    Absent,
    Valid(Box<ChildStateV1>),
    Invalid(String),
}

pub fn read_child_state(path: &Path) -> StateReadOutcome {
    if let Err(e) = reject_symlink(path) {
        return StateReadOutcome::Invalid(e);
    }
    let bytes = match fs::read(path) {
        Ok(b) => SecretBytes::new(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return StateReadOutcome::Absent,
        Err(e) => return StateReadOutcome::Invalid(format!("unreadable state.json: {e}")),
    };
    match serde_json::from_slice::<ChildStateV1>(bytes.as_slice()) {
        Ok(st) if st.schema != CHILD_STATE_SCHEMA => {
            StateReadOutcome::Invalid(format!("unsupported schema: {}", st.schema))
        }
        Ok(st)
            if st.shutdown_secret.len() == 48
                && st
                    .shutdown_secret
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
        {
            StateReadOutcome::Valid(Box::new(st))
        }
        Ok(_) => StateReadOutcome::Invalid("invalid child shutdown secret".to_owned()),
        Err(e) => StateReadOutcome::Invalid(format!("malformed state.json: {e}")),
    }
}

pub fn write_child_state(path: &Path, state: &ChildStateV1) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(state)
        .map_err(|e| format!("failed to serialize state.json: {e}"))?;
    bytes.push(b'\n');
    let result = write_private_atomic(path, &bytes);
    volatile_zero_bytes(&mut bytes);
    result
}

pub fn is_valid_link_token_format(raw_token: &str) -> bool {
    raw_token.len() == 49
        && raw_token.starts_with("ocx_data_")
        && raw_token[9..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn write_link_key(path: &Path, raw_token: &str) -> Result<String, String> {
    if !is_valid_link_token_format(raw_token) {
        return Err("invalid link credential format".to_owned());
    }
    let fp = token_fingerprint_hex(raw_token);
    write_private_atomic(path, raw_token.as_bytes())?;
    Ok(fp)
}

pub fn read_verified_link_key(
    path: &Path,
    expected_fingerprint: &str,
) -> Result<SecretBytes, String> {
    reject_symlink(path)?;
    let raw = fs::read(path).map_err(|e| format!("link key unavailable: {e}"))?;
    let secret = SecretBytes::new(raw);
    let text = std::str::from_utf8(secret.as_slice())
        .map_err(|_| "link key invalid utf8".to_owned())?
        .trim();
    if !is_valid_link_token_format(text) {
        return Err("link key malformed".to_owned());
    }
    let actual_fp = token_fingerprint_hex(text);
    if actual_fp != expected_fingerprint {
        return Err("link key fingerprint mismatch".to_owned());
    }
    Ok(SecretBytes::new(text.as_bytes().to_vec()))
}
