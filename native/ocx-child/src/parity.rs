use serde::{Deserialize, Serialize};

use crate::relay_auth::{is_valid_hex64, is_valid_link_id};

pub const LINK_CHILD_PARITY_MAX_BYTES: usize = 1024;
const MIN_EPOCH_MS: u64 = 1_000_000_000_000;
const MAX_EPOCH_MS: u64 = 9_999_999_999_999;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkChildParityReport {
    pub link_id: String,
    pub last_apply_at: Option<u64>,
    pub runtime_started_at: u64,
    pub applied_codex_settings_digest: Option<String>,
    pub sequence: u64,
}

impl LinkChildParityReport {
    pub fn validate(&self) -> bool {
        if !is_valid_link_id(&self.link_id) {
            return false;
        }
        if !(MIN_EPOCH_MS..=MAX_EPOCH_MS).contains(&self.runtime_started_at) {
            return false;
        }
        if let Some(ts) = self.last_apply_at
            && !(MIN_EPOCH_MS..=MAX_EPOCH_MS).contains(&ts)
        {
            return false;
        }
        if let Some(digest) = &self.applied_codex_settings_digest
            && !is_valid_hex64(digest)
        {
            return false;
        }
        if self.last_apply_at.is_none() != self.applied_codex_settings_digest.is_none() {
            return false;
        }
        self.sequence <= 9_007_199_254_740_991 // Number.MAX_SAFE_INTEGER
    }

    pub fn to_bounded_json(&self) -> Result<Vec<u8>, String> {
        if !self.validate() {
            return Err("invalid child parity report".to_owned());
        }
        let bytes = serde_json::to_vec(self)
            .map_err(|e| format!("failed serializing child parity report: {e}"))?;
        if bytes.len() > LINK_CHILD_PARITY_MAX_BYTES {
            return Err("child parity report exceeds 1024 bytes".to_owned());
        }
        Ok(bytes)
    }
}

/// Strict exact-key parser matching `parseLinkChildParityReport` in `src/link/child-parity.ts`.
pub fn parse_link_child_parity_report(raw_json: &str) -> Option<LinkChildParityReport> {
    if raw_json.len() > LINK_CHILD_PARITY_MAX_BYTES {
        return None;
    }
    let val: serde_json::Value = serde_json::from_str(raw_json).ok()?;
    let obj = val.as_object()?;
    if obj.len() != 5 {
        return None;
    }
    for req_key in [
        "linkId",
        "lastApplyAt",
        "runtimeStartedAt",
        "appliedCodexSettingsDigest",
        "sequence",
    ] {
        if !obj.contains_key(req_key) {
            return None;
        }
    }
    let parsed: LinkChildParityReport = serde_json::from_value(val).ok()?;
    parsed.validate().then_some(parsed)
}
