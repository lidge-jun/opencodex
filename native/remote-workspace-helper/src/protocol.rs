use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::path::Path;
#[cfg(target_os = "windows")]
use std::path::PathBuf;

pub const PROTOCOL_VERSION: u8 = 1;
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_PATH_BYTES: usize = 4096;
const MAX_COMMAND_ARGUMENTS: usize = 64;
const MAX_COMMAND_ARGUMENT_BYTES: usize = 4096;
const MAX_COMMAND_BYTES: usize = 16 * 1024;
const MAX_TOOLCHAIN_ROOTS: usize = 16;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HelperRequest {
    pub version: u8,
    pub operation: String,
    #[serde(default)]
    pub root: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub toolchain_roots: Vec<String>,
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default)]
    pub max_output_bytes: usize,
    #[serde(default)]
    pub network_access: bool,
}

impl HelperRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.operation == "probe" {
            if !self.root.is_empty()
                || !self.cwd.is_empty()
                || !self.command.is_empty()
                || !self.toolchain_roots.is_empty()
                || self.timeout_ms != 0
                || self.max_output_bytes != 0
                || self.network_access
            {
                return Err("probe request must not carry command authority".to_owned());
            }
            return Ok(());
        }
        if self.operation != "run" {
            return Ok(());
        }
        validate_path(&self.root, "workspace root")?;
        validate_path(&self.cwd, "command cwd")?;
        if !Path::new(&self.root).is_absolute() || !Path::new(&self.cwd).is_absolute() {
            return Err("workspace root and cwd must be absolute".to_owned());
        }
        if self.command.is_empty() || self.command.len() > MAX_COMMAND_ARGUMENTS {
            return Err("invalid command vector".to_owned());
        }
        let mut command_bytes = 0usize;
        for value in &self.command {
            if value.is_empty() || value.len() > MAX_COMMAND_ARGUMENT_BYTES || value.contains('\0')
            {
                return Err("invalid command vector".to_owned());
            }
            command_bytes = command_bytes
                .checked_add(value.len())
                .ok_or_else(|| "command vector is too large".to_owned())?;
        }
        if command_bytes > MAX_COMMAND_BYTES {
            return Err("command vector is too large".to_owned());
        }
        if self.toolchain_roots.len() > MAX_TOOLCHAIN_ROOTS {
            return Err("too many toolchain roots".to_owned());
        }
        for path in &self.toolchain_roots {
            validate_path(path, "toolchain root")?;
            if !Path::new(path).is_absolute() {
                return Err("toolchain roots must be absolute".to_owned());
            }
        }
        if !(1..=60_000).contains(&self.timeout_ms) {
            return Err("command timeout is outside its limit".to_owned());
        }
        if !(1024..=MAX_OUTPUT_BYTES).contains(&self.max_output_bytes) {
            return Err("command output limit is outside its limit".to_owned());
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    pub fn canonical_paths(&self) -> Result<CanonicalPaths, String> {
        let root = canonical_directory(&self.root, "workspace root")?;
        let cwd = canonical_directory(&self.cwd, "command cwd")?;
        if !cwd.starts_with(&root) {
            return Err("command cwd escaped its workspace root".to_owned());
        }
        let mut toolchain_roots = Vec::with_capacity(self.toolchain_roots.len());
        for value in &self.toolchain_roots {
            let canonical = canonical_directory(value, "toolchain root")?;
            if !toolchain_roots.contains(&canonical) {
                toolchain_roots.push(canonical);
            }
        }
        Ok(CanonicalPaths {
            root,
            cwd,
            toolchain_roots,
        })
    }
}

fn validate_path(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_PATH_BYTES || value.contains('\0') {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn canonical_directory(value: &str, label: &str) -> Result<PathBuf, String> {
    let original = Path::new(value);
    let metadata =
        std::fs::symlink_metadata(original).map_err(|_| format!("{label} is unavailable"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label} must remain a real directory"));
    }
    original
        .canonicalize()
        .map_err(|_| format!("{label} is unavailable"))
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
pub struct CanonicalPaths {
    pub root: PathBuf,
    pub cwd: PathBuf,
    pub toolchain_roots: Vec<PathBuf>,
}

#[derive(Debug)]
pub struct CommandOutcome {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperResponse {
    version: u8,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    probe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stdout_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stderr_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl HelperResponse {
    pub fn error(error: String) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            ok: false,
            probe: None,
            exit_code: None,
            stdout_base64: None,
            stderr_base64: None,
            error: Some(limit_error(error)),
        }
    }

    pub fn probe_success() -> Self {
        Self {
            version: PROTOCOL_VERSION,
            ok: true,
            probe: Some(true),
            exit_code: None,
            stdout_base64: None,
            stderr_base64: None,
            error: None,
        }
    }

    pub fn command_success(outcome: CommandOutcome) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            ok: true,
            probe: None,
            exit_code: Some(outcome.exit_code),
            stdout_base64: Some(STANDARD.encode(outcome.stdout)),
            stderr_base64: Some(STANDARD.encode(outcome.stderr)),
            error: None,
        }
    }
}

fn limit_error(mut value: String) -> String {
    const MAX_ERROR_CHARS: usize = 512;
    if value.chars().count() <= MAX_ERROR_CHARS {
        return value;
    }
    value = value.chars().take(MAX_ERROR_CHARS).collect();
    value.push('…');
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_authority_smuggled_into_probe() {
        let request: HelperRequest =
            serde_json::from_str(r#"{"version":1,"operation":"probe","command":["whoami"]}"#)
                .expect("valid JSON fixture");
        assert!(request.validate().is_err());
    }

    #[test]
    fn rejects_unknown_wire_fields() {
        assert!(
            serde_json::from_str::<HelperRequest>(
                r#"{"version":1,"operation":"probe","surprise":true}"#,
            )
            .is_err()
        );
    }

    #[test]
    fn bounds_command_shape_before_platform_code() {
        let request: HelperRequest = serde_json::from_str(
            r#"{"version":1,"operation":"run","root":"/tmp/a","cwd":"/tmp/a","command":["x"],"timeoutMs":0,"maxOutputBytes":262144}"#,
        )
        .expect("valid JSON fixture");
        assert!(request.validate().is_err());
    }
}
