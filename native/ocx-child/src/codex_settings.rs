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

fn is_ecmascript_whitespace(ch: char) -> bool {
    matches!(
        ch as u32,
        0x0009 | 0x000A | 0x000B | 0x000C | 0x000D | 0x0020 | 0x00A0 | 0x1680 | 0x2000
            ..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

pub fn sanitize_safe_label(value: &str, max_utf16_units: usize) -> Option<String> {
    let trimmed = value.trim_matches(is_ecmascript_whitespace);
    let utf16_len = trimmed.encode_utf16().count();
    if trimmed.is_empty() || utf16_len > max_utf16_units {
        return None;
    }
    for ch in trimmed.chars() {
        let cp = ch as u32;
        if cp < 0x20
            || cp == 0x7f
            || (0x202a..=0x202e).contains(&cp)
            || (0x2066..=0x2069).contains(&cp)
        {
            return None;
        }
    }
    Some(trimmed.to_owned())
}

pub fn is_valid_reasoning_effort_token(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn exact_keys(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> bool {
    obj.len() == keys.len() && keys.iter().all(|k| obj.contains_key(*k))
}

/// Strict parser matching `parseHomeCodexSettingsDocument` in `src/link/codex-settings.ts`.
pub fn parse_home_codex_settings_document(bytes: &[u8]) -> Option<HomeCodexSettingsDocument> {
    let root: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let root_obj = root.as_object()?;
    if !exact_keys(root_obj, &["version", "home", "settings"]) {
        return None;
    }
    let version = root_obj.get("version")?.as_u64()?;
    if version != u64::from(HOME_CODEX_SETTINGS_VERSION) {
        return None;
    }
    let home_obj = root_obj.get("home")?.as_object()?;
    if !exact_keys(home_obj, &["name", "version"]) {
        return None;
    }
    let name = sanitize_safe_label(home_obj.get("name")?.as_str()?, 255)?;
    let home_version = sanitize_safe_label(home_obj.get("version")?.as_str()?, 64)?;
    let s_obj = root_obj.get("settings")?.as_object()?;
    if !exact_keys(
        s_obj,
        &[
            "fastMode",
            "multiAgentMode",
            "webSearchSidecarEnabled",
            "subagentDefaults",
        ],
    ) {
        return None;
    }
    let fast_mode = match s_obj.get("fastMode")? {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(b) => Some(*b),
        _ => return None,
    };
    let multi_agent_mode = match s_obj.get("multiAgentMode")? {
        serde_json::Value::Null => None,
        serde_json::Value::String(m) if matches!(m.as_str(), "v1" | "default" | "v2") => {
            Some(m.clone())
        }
        _ => return None,
    };
    let web_search_sidecar_enabled = s_obj.get("webSearchSidecarEnabled")?.as_bool()?;
    let subagent_defaults = match s_obj.get("subagentDefaults")? {
        serde_json::Value::Null => None,
        serde_json::Value::Object(d_obj) => {
            if !exact_keys(d_obj, &["model", "reasoningEffort"]) {
                return None;
            }
            let model = sanitize_safe_label(d_obj.get("model")?.as_str()?, 256)?;
            let reasoning_effort = match d_obj.get("reasoningEffort")? {
                serde_json::Value::Null => None,
                serde_json::Value::String(eff) if is_valid_reasoning_effort_token(eff) => {
                    Some(eff.clone())
                }
                _ => return None,
            };
            Some(SubagentDefaults {
                model,
                reasoning_effort,
            })
        }
        _ => return None,
    };
    Some(HomeCodexSettingsDocument {
        version: HOME_CODEX_SETTINGS_VERSION,
        home: HomeIdentity {
            name,
            version: home_version,
        },
        settings: HomeCodexSettings {
            fast_mode,
            multi_agent_mode,
            web_search_sidecar_enabled,
            subagent_defaults,
        },
    })
}

impl HomeCodexSettings {
    pub fn validate(&self) -> bool {
        if let Some(mode) = &self.multi_agent_mode
            && !matches!(mode.as_str(), "v1" | "default" | "v2")
        {
            return false;
        }
        if let Some(sub) = &self.subagent_defaults {
            if sanitize_safe_label(&sub.model, 256).is_none() {
                return false;
            }
            if let Some(eff) = &sub.reasoning_effort
                && !is_valid_reasoning_effort_token(eff)
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
            && sanitize_safe_label(&self.home.name, 255).is_some()
            && sanitize_safe_label(&self.home.version, 64).is_some()
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
