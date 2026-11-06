use serde::{Deserialize, Serialize};

use crate::platform::sha256_hex;

pub const HOME_CODEX_SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubagentDefaults {
    pub model: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HomeCodexSettings {
    pub fast_mode: Option<bool>,
    pub multi_agent_mode: Option<String>,
    pub web_search_sidecar_enabled: bool,
    pub subagent_defaults: Option<SubagentDefaults>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HomeIdentity {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HomeCodexSettingsDocument {
    pub version: u32,
    pub home: HomeIdentity,
    pub settings: HomeCodexSettings,
}

impl HomeCodexSettings {
    pub fn validate(&self) -> bool {
        if let Some(mode) = &self.multi_agent_mode
            && !matches!(mode.as_str(), "v1" | "default" | "v2")
        {
            return false;
        }
        if let Some(sub) = &self.subagent_defaults {
            if sub.model.trim().is_empty() || sub.model.len() > 256 {
                return false;
            }
            if let Some(eff) = &sub.reasoning_effort
                && (eff.trim().is_empty() || eff.len() > 64)
            {
                return false;
            }
        }
        true
    }
}

impl HomeCodexSettingsDocument {
    pub fn validate(&self) -> bool {
        self.version == HOME_CODEX_SETTINGS_VERSION
            && !self.home.name.trim().is_empty()
            && self.home.name.len() <= 255
            && !self.home.version.trim().is_empty()
            && self.home.version.len() <= 64
            && self.settings.validate()
    }
}

#[derive(Serialize)]
struct DigestEnvelope<'a> {
    version: u32,
    settings: DigestSettings<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestSettings<'a> {
    fast_mode: Option<bool>,
    multi_agent_mode: &'a Option<String>,
    web_search_sidecar_enabled: bool,
    subagent_defaults: Option<DigestSubagent<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DigestSubagent<'a> {
    model: &'a str,
    reasoning_effort: &'a Option<String>,
}

/// Produces the exact OCX-6 compact JSON string hashed by `codexSettingsDigest` in `src/link/codex-settings.ts`.
pub fn codex_settings_digest_payload(settings: &HomeCodexSettings) -> String {
    let env = DigestEnvelope {
        version: HOME_CODEX_SETTINGS_VERSION,
        settings: DigestSettings {
            fast_mode: settings.fast_mode,
            multi_agent_mode: &settings.multi_agent_mode,
            web_search_sidecar_enabled: settings.web_search_sidecar_enabled,
            subagent_defaults: settings.subagent_defaults.as_ref().map(|d| DigestSubagent {
                model: &d.model,
                reasoning_effort: &d.reasoning_effort,
            }),
        },
    };
    serde_json::to_string(&env).expect("DigestEnvelope serialization is infallible")
}

pub fn codex_settings_digest(settings: &HomeCodexSettings) -> String {
    sha256_hex(codex_settings_digest_payload(settings).as_bytes())
}
