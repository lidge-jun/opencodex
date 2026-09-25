use std::path::PathBuf;

use serde::Deserialize;

/// The runtime record the server publishes in `runtime-port.json`.
///
/// The attestation secret is what lets this client tell the instance it was bound to apart from a
/// foreign process that later takes the port over: only the real runtime can answer an attestation
/// challenge with a proof keyed by it.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRuntime {
    pub pid: u32,
    pub port: u16,
    pub attestation_secret: String,
}

#[derive(Clone, Debug)]
pub struct Auth {
    home: PathBuf,
}

impl Auth {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    /// The runtime record, or `None` when it is missing, malformed, or carries no usable
    /// attestation secret — all of which mean the peer cannot prove the identity this client was
    /// bound to.
    pub fn runtime_identity(&self) -> Option<RecordedRuntime> {
        let value = std::fs::read(self.home.join("runtime-port.json")).ok()?;
        let identity: RecordedRuntime = serde_json::from_slice(&value).ok()?;
        let secret_ok = identity.attestation_secret.len() == 43
            && identity
                .attestation_secret
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if identity.pid == 0 || !secret_ok {
            return None;
        }
        Some(identity)
    }

    pub fn user_agent() -> &'static str {
        concat!("OpenCodexDesktop/", env!("CARGO_PKG_VERSION"))
    }
}
