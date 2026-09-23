//! What the bundled CLI says about this machine's runtime.
//!
//! D5: the shell stops resolving the configuration home, the port and liveness itself. It used to,
//! in a file called `discovery.rs` that read `runtime-port.json`, fell back to 10100 and started on
//! that port — so a user with a configured `config.port` was started somewhere else. The tuned probe
//! budgets it should have been using exist because a shell-side reimplementation answered "nobody is
//! listening" twice and started duplicate proxies. This asks instead.
//!
//! Liveness has three answers and the third one is the point. `live` means attach. `absent-proven`
//! means every recorded and configured endpoint was definitively dead, and only that authorises
//! starting a runtime. Anything else is unknown, and the CLI exits 1 rather than putting absence on
//! the wire. Everything that can go wrong on this side — a missing binary, a timeout, output that
//! will not parse, a schema this shell does not know — folds into the same unknown, because the one
//! reading that must never happen is "the resolve failed, so nobody must be listening".

use crate::endpoint::ProxyEndpoint;
use crate::ownership::Recorded;
use serde::Deserialize;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tokio::time::{timeout_at, Instant};

/// The wire version this shell understands. A document announcing anything else is unknown.
pub const SCHEMA: &str = "ocx-resolve/1";

/// The CLI's liveness verdict. Only two reach the wire; the third exits 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Live,
    AbsentProven,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Liveness {
    pub status: Status,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    /// The bind address that answered. Absent on a proven absence, because nothing answered.
    pub hostname: Option<String>,
    pub version: Option<String>,
    pub role: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    /// The port a client should use: the live listener's, or the configured one.
    pub effective: u16,
    /// What a start would prefer.
    pub configured: u16,
}

/// Whether the CLI says a desktop takeover can be offered.
///
/// The token is the binding a later `ocx service claim` repeats back: it covers the exact
/// subject and managing-CLI observations the consent was approved against, so a claim made
/// after either moved is refused rather than recorded.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Takeover {
    #[serde(rename_all = "camelCase")]
    Supported {
        protocol_version: u64,
        minimum_cli_version: String,
        token: String,
    },
    Blocked {
        reason: String,
        detail: String,
    },
}

impl Default for Takeover {
    /// An older bundled CLI carries no takeover answer at all; silence is not approval.
    fn default() -> Self {
        Self::Blocked {
            reason: "unreported".to_owned(),
            detail: "the bundled CLI did not report takeover compatibility".to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub schema: String,
    pub cli_version: String,
    pub config_home: String,
    pub port: Port,
    pub liveness: Liveness,
    /// The recorded runtime owner, already in the CLI's three answers. Absent on older
    /// documents, which read as unknown rather than as nobody owning the runtime.
    #[serde(default)]
    pub ownership: Recorded,
    #[serde(default)]
    pub takeover: Takeover,
}

impl Resolved {
    pub fn endpoint(&self) -> ProxyEndpoint {
        ProxyEndpoint {
            host: "127.0.0.1",
            port: self.port.effective,
        }
    }

    pub fn home(&self) -> PathBuf {
        PathBuf::from(&self.config_home)
    }
}

/// What the shell got back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// The CLI produced a verdict this shell trusts.
    Answered(Box<Resolved>),
    /// It did not, for whatever reason. Never read as absence.
    Unknown(String),
}

impl Resolution {
    pub fn resolved(&self) -> Option<&Resolved> {
        match self {
            Self::Answered(resolved) => Some(resolved.as_ref()),
            Self::Unknown(_) => None,
        }
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Unknown(reason) => Some(reason),
            Self::Answered(_) => None,
        }
    }
}

/// Whether the shell may start a runtime of its own.
///
/// Proven absence and nothing else. `live` means attach to what is there, and unknown means refuse:
/// a resolution that could not be trusted must never read as "nobody is listening", which is the
/// reading that puts a second proxy next to the one already running.
pub fn may_start(resolution: &Resolution) -> bool {
    matches!(
        resolution
            .resolved()
            .map(|resolved| resolved.liveness.status),
        Some(Status::AbsentProven)
    )
}

/// What the shell may do with a listener the CLI found alive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LiveVerdict {
    /// Nothing is listening; this verdict does not apply.
    NotLive,
    /// It is a proxy, on an address this shell can reach. Attach as a guest.
    Attach,
    /// Something is listening and this shell cannot use it. Never a reason to start a second one.
    Unusable(String),
}

/// Whether the address the CLI reported is one this shell can reach on loopback.
///
/// The shell speaks to loopback and nothing else — that is what makes sending the management token
/// to it safe. A proxy bound to either loopback spelling, or to every interface, is reachable at
/// 127.0.0.1. One bound to the IPv6 loopback or to a specific external address is not, and
/// addressing 127.0.0.1 anyway would turn a running proxy into a health wait that times out.
pub fn loopback_reachable(hostname: Option<&str>) -> bool {
    matches!(
        hostname,
        None | Some("127.0.0.1") | Some("localhost") | Some("0.0.0.0")
    )
}

/// Read a live verdict.
///
/// Liveness answers "is something there", and core's predicate accepts a connected client's
/// listener on purpose so duplicate-start avoidance can see it. This shell needs the management
/// plane, so it has to discriminate on the role the CLI carried: a client listener serves machine
/// routes, not `/api/*`, and attaching to it would report Ready against an endpoint the dashboard
/// and the tray cannot use.
pub fn live_verdict(resolution: &Resolution) -> LiveVerdict {
    let Some(resolved) = resolution.resolved() else {
        return LiveVerdict::NotLive;
    };
    if resolved.liveness.status != Status::Live {
        return LiveVerdict::NotLive;
    }
    if resolved.liveness.role.as_deref() == Some("client") {
        return LiveVerdict::Unusable(
            "a connected client is listening on this port, not a proxy this app can manage".into(),
        );
    }
    if !loopback_reachable(resolved.liveness.hostname.as_deref()) {
        return LiveVerdict::Unusable(format!(
            "the runtime is bound to {} and this app only speaks to loopback",
            resolved
                .liveness
                .hostname
                .as_deref()
                .unwrap_or("an unknown address")
        ));
    }
    LiveVerdict::Attach
}

/// Read one resolve document, refusing anything that is not exactly one.
///
/// The CLI puts the document on stdout and its human output on stderr, so stdout is parsed whole.
/// A non-zero exit is the CLI's own refusal — including the exit 1 it uses for unknown liveness and
/// for a config it will not guess at — and is carried through rather than reinterpreted here.
pub fn read(exit_code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> Resolution {
    if exit_code != Some(0) {
        let detail = String::from_utf8_lossy(stderr);
        let detail = detail.trim();
        let code = exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "no exit code".to_owned());
        return Resolution::Unknown(if detail.is_empty() {
            format!("the bundled CLI could not resolve the runtime (exit {code})")
        } else {
            format!("the bundled CLI could not resolve the runtime (exit {code}): {detail}")
        });
    }
    let text = String::from_utf8_lossy(stdout);
    let resolved: Resolved = match serde_json::from_str(text.trim()) {
        Ok(resolved) => resolved,
        Err(error) => {
            return Resolution::Unknown(format!(
                "the bundled CLI's resolve output could not be read ({error})"
            ))
        }
    };
    if resolved.schema != SCHEMA {
        return Resolution::Unknown(format!(
            "the bundled CLI answered with schema {} and this app understands {SCHEMA}",
            resolved.schema
        ));
    }
    Resolution::Answered(Box::new(resolved))
}

/// Ask the bundled CLI, under the caller's deadline.
pub async fn run(app: &AppHandle, deadline: Instant) -> Resolution {
    let command = match app.shell().sidecar("ocx") {
        Ok(command) => command.args(["resolve", "--json"]),
        Err(error) => {
            return Resolution::Unknown(format!("the bundled CLI could not be started ({error})"))
        }
    };
    match timeout_at(deadline, command.output()).await {
        Ok(Ok(output)) => read(output.status.code(), &output.stdout, &output.stderr),
        Ok(Err(error)) => {
            Resolution::Unknown(format!("the bundled CLI could not be run ({error})"))
        }
        Err(_) => Resolution::Unknown(
            "the bundled CLI did not answer before the startup deadline".to_owned(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        live_verdict, loopback_reachable, may_start, read, LiveVerdict, Resolution, Status,
        Takeover, SCHEMA,
    };
    use crate::ownership::{Owner, Recorded};

    const LIVE: &str = r#"{"schema":"ocx-resolve/1","cliVersion":"2.61.0","configHome":"/h",
        "port":{"effective":10100,"configured":10100,"source":"runtime-record"},
        "liveness":{"status":"live","pid":42,"port":10100,"source":"runtime-record","version":"2.61.0"}}"#;
    const ABSENT: &str = r#"{"schema":"ocx-resolve/1","cliVersion":"2.61.0","configHome":"/h",
        "port":{"effective":10100,"configured":10100,"source":"config"},
        "liveness":{"status":"absent-proven","pid":null,"port":null,"source":null}}"#;

    #[test]
    fn a_live_verdict_is_read_whole() {
        let resolution = read(Some(0), LIVE.as_bytes(), b"");
        let resolved = resolution.resolved().expect("a document");
        assert_eq!(resolved.schema, SCHEMA);
        assert_eq!(resolved.liveness.status, Status::Live);
        assert_eq!(resolved.liveness.pid, Some(42));
        assert_eq!(resolved.endpoint().port, 10100);
        assert_eq!(resolved.home().display().to_string(), "/h");
        assert_eq!(live_verdict(&resolution), LiveVerdict::Attach);
        assert!(!may_start(&resolution));
    }

    #[test]
    fn only_a_proven_absence_authorises_a_start() {
        let resolution = read(Some(0), ABSENT.as_bytes(), b"");
        assert_eq!(
            resolution.resolved().map(|r| r.liveness.status),
            Some(Status::AbsentProven)
        );
        assert!(may_start(&resolution));
        assert_eq!(live_verdict(&resolution), LiveVerdict::NotLive);
    }

    #[test]
    fn a_connected_client_is_live_but_not_a_runtime_to_attach_to() {
        let client = LIVE.replace(
            r#""version":"2.61.0""#,
            r#""version":"2.61.0","role":"client""#,
        );
        let resolution = read(Some(0), client.as_bytes(), b"");
        assert!(matches!(
            live_verdict(&resolution),
            LiveVerdict::Unusable(_)
        ));
        // Live and unusable is still live: it is never a reason to start a second one.
        assert!(!may_start(&resolution));
    }

    #[test]
    fn only_a_loopback_bind_is_addressed_as_loopback() {
        for reachable in [None, Some("127.0.0.1"), Some("localhost"), Some("0.0.0.0")] {
            assert!(loopback_reachable(reachable), "{reachable:?}");
        }
        for elsewhere in [Some("::1"), Some("192.168.1.10"), Some("example.internal")] {
            assert!(!loopback_reachable(elsewhere), "{elsewhere:?}");
        }
        let bound = LIVE.replace(r#""pid":42"#, r#""pid":42,"hostname":"::1""#);
        let resolution = read(Some(0), bound.as_bytes(), b"");
        assert!(matches!(
            live_verdict(&resolution),
            LiveVerdict::Unusable(_)
        ));
        assert!(!may_start(&resolution));
    }

    #[test]
    fn the_clis_own_refusal_is_unknown_and_never_authorises_a_start() {
        // Exit 1 is what the CLI uses for unknown liveness and for a config it will not guess at.
        let resolution = read(Some(1), b"", b"resolve: liveness is unknown");
        assert!(matches!(resolution, Resolution::Unknown(_)));
        assert!(resolution.reason().unwrap().contains("liveness is unknown"));
        assert!(!may_start(&resolution));
        assert_eq!(live_verdict(&resolution), LiveVerdict::NotLive);
    }

    #[test]
    fn everything_that_can_go_wrong_here_folds_into_unknown() {
        for (code, out) in [
            (Some(64), &b""[..]),
            (None, &b""[..]),
            (Some(0), &b"not json"[..]),
            (Some(0), &b"{}"[..]),
        ] {
            let resolution = read(code, out, b"");
            assert!(matches!(resolution, Resolution::Unknown(_)), "{code:?}");
            assert!(!may_start(&resolution));
        }
    }

    #[test]
    fn ownership_and_takeover_answers_are_read_whole() {
        let document = format!(
            "{}{}}}",
            LIVE.strip_suffix('}').unwrap(),
            r#","ownership":{"kind":"owned","ownership":{"owner":"cli","installId":"npm-1","consentGeneration":2},"revision":9},"takeover":{"kind":"supported","protocolVersion":1,"minimumCliVersion":"2.61.0","token":"abc"}"#
        );
        let resolution = read(Some(0), document.as_bytes(), b"");
        let resolved = match resolution.resolved() {
            Some(resolved) => resolved.clone(),
            None => panic!("{}", resolution.reason().unwrap()),
        };
        assert_eq!(
            resolved.ownership,
            Recorded::Owned {
                ownership: crate::ownership::Claim {
                    owner: Owner::Cli,
                    install_id: "npm-1".to_owned(),
                    consent_generation: 2,
                },
                revision: 9,
            }
        );
        assert!(matches!(
            resolved.takeover,
            Takeover::Supported { ref token, .. } if token == "abc"
        ));
    }

    #[test]
    fn a_missing_ownership_or_takeover_answer_is_not_consent() {
        // Older bundled CLIs carry neither field; silence must read unknown/blocked, never
        // "nobody owns it" or "takeover supported".
        let resolved = read(Some(0), LIVE.as_bytes(), b"")
            .resolved()
            .expect("a document")
            .clone();
        assert!(matches!(resolved.ownership, Recorded::Unknown { .. }));
        assert!(matches!(resolved.takeover, Takeover::Blocked { .. }));
        assert_eq!(resolved.takeover, Takeover::default());
    }

    #[test]
    fn a_blocked_takeover_carries_its_reason() {
        let document = format!(
            "{}{}}}",
            LIVE.strip_suffix('}').unwrap(),
            r#","ownership":{"kind":"none","revision":0},"takeover":{"kind":"blocked","reason":"managing-cli-unsupported","detail":"path uses 2.59.0","minimumCliVersion":"2.61.0"}"#
        );
        let resolved = read(Some(0), document.as_bytes(), b"")
            .resolved()
            .expect("a document")
            .clone();
        assert_eq!(resolved.ownership, Recorded::None { revision: 0 });
        assert_eq!(
            resolved.takeover,
            Takeover::Blocked {
                reason: "managing-cli-unsupported".to_owned(),
                detail: "path uses 2.59.0".to_owned(),
            }
        );
    }

    #[test]
    fn a_schema_this_app_does_not_know_is_unknown() {
        let future = LIVE.replace("ocx-resolve/1", "ocx-resolve/2");
        let resolution = read(Some(0), future.as_bytes(), b"");
        assert!(matches!(resolution, Resolution::Unknown(_)));
        assert!(resolution.reason().unwrap().contains("ocx-resolve/2"));
        assert!(!may_start(&resolution));
    }
}
