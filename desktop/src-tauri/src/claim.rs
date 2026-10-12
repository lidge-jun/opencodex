//! Recording this installation as the runtime owner, through the bundled CLI.
//!
//! The claim is only valid against the exact answer the consent prompt was approved from,
//! so this is a subprocess with expectations on argv rather than an in-process write: the
//! ownership mutation lease, the subject revalidation and the managing-CLI re-observation
//! all live in the CLI's `recordServiceOwner`, and re-running them here would be a second
//! implementation of a rule that has to be identical.
//!
//! Like `runtime_stop`, the result is a document, not a guess: `ocx service claim --json`
//! puts one summary on stdout and this consumes `ok` and the exit code rather than
//! inferring them. A claim that did not end in exit 0 with `ok:true` is a claim that did
//! not happen — and a takeover that reached here already stopped the foreign runtime, so
//! the caller's failure is a stopped runtime with no owner recorded, which the next launch
//! resolves as an ordinary absence.

use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tokio::time::{timeout_at, Instant};

/// The wire version this shell understands.
pub const SCHEMA: &str = "ocx-service-claim/1";

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOwnership {
    pub owner: String,
    pub install_id: String,
    pub consent_generation: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimSummary {
    pub schema: String,
    pub ok: bool,
    /// Present on success.
    pub ownership: Option<ClaimOwnership>,
    /// Present on failure: the CLI's machine-readable error code.
    pub code: Option<String>,
    /// Present on failure.
    pub message: Option<String>,
}

/// What the shell concluded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimResult {
    /// The CLI recorded the claim and named the generation it landed at.
    Recorded(ClaimOwnership),
    /// It reported anything else, or the run could not be read at all.
    Failed(String),
}

impl ClaimResult {
    #[cfg(test)]
    pub fn is_recorded(&self) -> bool {
        matches!(self, Self::Recorded(_))
    }
}

/// The arguments a takeover builds from the resolve answer it was approved against.
///
/// `Recorded::Unknown` gets no argv: fabricating `--expect-none --expect-revision 0` would claim
/// against a subject nobody approved, so the answer is None and the caller refuses.
pub fn args(
    install_id: &str,
    recorded: &crate::ownership::Recorded,
    token: &str,
) -> Option<Vec<String>> {
    let mut argv = vec![
        "service".to_owned(),
        "claim".to_owned(),
        "--owner".to_owned(),
        "desktop".to_owned(),
        "--install-id".to_owned(),
        install_id.to_owned(),
    ];
    match recorded {
        crate::ownership::Recorded::None { revision } => {
            argv.push("--expect-none".to_owned());
            argv.push("--expect-revision".to_owned());
            argv.push(revision.to_string());
        }
        crate::ownership::Recorded::Owned {
            ownership,
            revision,
        } => {
            argv.extend([
                "--expect-owner".to_owned(),
                match ownership.owner {
                    crate::ownership::Owner::Cli => "cli".to_owned(),
                    crate::ownership::Owner::Desktop => "desktop".to_owned(),
                },
                "--expect-install-id".to_owned(),
                ownership.install_id.clone(),
                "--expect-generation".to_owned(),
                ownership.consent_generation.to_string(),
                "--expect-revision".to_owned(),
                revision.to_string(),
            ]);
        }
        // A takeover is only offered when the record was read; unknown never reaches here,
        // and refusing beats inventing an approval.
        crate::ownership::Recorded::Unknown { .. } => return None,
    }
    argv.extend([
        "--expect-compatibility-token".to_owned(),
        token.to_owned(),
        "--json".to_owned(),
    ]);
    Some(argv)
}

/// Read one claim summary.
///
/// Exit 0 with `ok:true` is the only success — the claim path uses exit 1 with a
/// machine-readable `code` for subject mismatches and changed compatibility, and both of
/// those are refusals to re-ask from, not partial writes.
pub fn read(exit_code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> ClaimResult {
    let text = String::from_utf8_lossy(stdout);
    let summary: ClaimSummary = match serde_json::from_str(text.trim()) {
        Ok(summary) => summary,
        Err(error) => {
            let detail = String::from_utf8_lossy(stderr);
            let detail = detail.trim();
            let code = exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "no exit code".to_owned());
            return ClaimResult::Failed(if detail.is_empty() {
                format!("the bundled CLI's claim output could not be read (exit {code}: {error})")
            } else {
                format!("the bundled CLI's claim output could not be read (exit {code}): {detail}")
            });
        }
    };
    if summary.schema != SCHEMA {
        return ClaimResult::Failed(format!(
            "the bundled CLI answered with schema {} and this app understands {SCHEMA}",
            summary.schema
        ));
    }
    if exit_code != Some(0) || !summary.ok {
        return ClaimResult::Failed(summary.message.unwrap_or_else(|| {
            format!(
                "the claim was refused ({})",
                summary.code.unwrap_or_else(|| "no code".to_owned())
            )
        }));
    }
    match summary.ownership {
        Some(ownership) => ClaimResult::Recorded(ownership),
        None => ClaimResult::Failed(
            "the claim reported success but carried no ownership record".to_owned(),
        ),
    }
}

/// Run the bundled `ocx service claim`, under the caller's deadline.
pub async fn run(app: &AppHandle, argv: Vec<String>, deadline: Instant) -> ClaimResult {
    let command = match app.shell().sidecar("ocx") {
        Ok(command) => command.args(argv),
        Err(error) => {
            return ClaimResult::Failed(format!("the bundled CLI could not be started ({error})"))
        }
    };
    match timeout_at(deadline, command.output()).await {
        Ok(Ok(output)) => read(output.status.code(), &output.stdout, &output.stderr),
        Ok(Err(error)) => {
            ClaimResult::Failed(format!("the bundled CLI could not be run ({error})"))
        }
        Err(_) => ClaimResult::Failed(
            "the bundled CLI did not finish the claim before the deadline".to_owned(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{args, read, ClaimResult};
    use crate::ownership::{Owner, Recorded};

    fn document(ok: bool, extra: &str) -> String {
        format!(r#"{{"schema":"ocx-service-claim/1","ok":{ok}{extra}}}"#)
    }

    #[test]
    fn the_arguments_carry_the_exact_approved_subject() {
        let none = args("install-a", &Recorded::None { revision: 0 }, "tok");
        assert_eq!(
            none.expect("argv for a read record"),
            vec![
                "service",
                "claim",
                "--owner",
                "desktop",
                "--install-id",
                "install-a",
                "--expect-none",
                "--expect-revision",
                "0",
                "--expect-compatibility-token",
                "tok",
                "--json",
            ]
        );
        let owned = Recorded::Owned {
            ownership: crate::ownership::Claim {
                owner: Owner::Cli,
                install_id: "npm-1".to_owned(),
                consent_generation: 2,
            },
            revision: 9,
        };
        let argv = args("install-a", &owned, "tok").expect("a claim against a read record");
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--expect-owner", "cli"]));
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--expect-install-id", "npm-1"]));
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--expect-generation", "2"]));
        assert!(argv
            .windows(2)
            .any(|pair| pair == ["--expect-revision", "9"]));
    }

    #[test]
    fn an_unread_record_gets_no_claim_rather_than_a_fabricated_one() {
        // Nobody approved a subject the resolve could not read, so there is nothing to claim
        // against -- and "expect none, revision 0" would be that approval invented.
        assert!(args(
            "install-a",
            &Recorded::Unknown {
                reason: "why".to_owned()
            },
            "tok"
        )
        .is_none());
    }

    #[test]
    fn a_recorded_claim_is_the_only_success() {
        let ok = document(
            true,
            r#","ownership":{"owner":"desktop","installId":"install-a","consentGeneration":1},"revision":3"#,
        );
        let result = read(Some(0), ok.as_bytes(), b"");
        match result {
            ClaimResult::Recorded(ownership) => {
                assert_eq!(ownership.install_id, "install-a");
                assert_eq!(ownership.consent_generation, 1);
            }
            ClaimResult::Failed(reason) => panic!("{reason}"),
        }
        // Success has to arrive with exit 0 and the record it wrote.
        assert!(!read(Some(1), ok.as_bytes(), b"").is_recorded());
        assert!(!read(Some(0), document(true, "").as_bytes(), b"").is_recorded());
    }

    #[test]
    fn a_refusal_carries_the_clis_own_message() {
        let refused = document(
            false,
            r#","code":"service-ownership-subject-mismatch","message":"ownership changed""#,
        );
        let result = read(Some(1), refused.as_bytes(), b"");
        match result {
            ClaimResult::Failed(reason) => assert!(reason.contains("ownership changed")),
            ClaimResult::Recorded(_) => panic!("a refused claim is not recorded"),
        }
    }

    #[test]
    fn output_that_cannot_be_read_is_a_failure_not_a_claim() {
        assert!(!read(Some(0), b"", b"boom").is_recorded());
        assert!(!read(Some(0), b"not json", b"").is_recorded());
        assert!(!read(None, b"", b"").is_recorded());
        let future = document(true, r#","ownership":{"owner":"desktop","installId":"i","consentGeneration":1},"revision":1"#)
            .replace("ocx-service-claim/1", "ocx-service-claim/2");
        let result = read(Some(0), future.as_bytes(), b"");
        assert!(!result.is_recorded());
        match result {
            ClaimResult::Failed(reason) => assert!(reason.contains("ocx-service-claim/2")),
            _ => unreachable!(),
        }
    }
}
