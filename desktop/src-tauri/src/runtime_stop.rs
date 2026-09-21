//! Stopping a runtime through the bundled CLI.
//!
//! D4: the shell drives the real `ocx stop` as a child process, so the receipt-backed teardown, the
//! drain, the Windows respawn verification and the client-configuration restore all run exactly as
//! they do from a terminal. An in-process management call cannot own that teardown — launchd and
//! systemd can terminate the request handler during self-unload, and the Windows respawn window can
//! only be verified after the process exits — so the shell reads the run's result instead of
//! performing it.
//!
//! The result is a document, not a guess. `ocx stop --json` puts one summary on stdout and its
//! human output on stderr, and this consumes the outcome and the exit code rather than inferring
//! either. A stop that did not end in exit 0 with the runtime down is a stop that did not happen.

use serde::Deserialize;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tokio::time::{timeout_at, Instant};

/// The wire version this shell understands.
pub const SCHEMA: &str = "ocx-stop/1";

/// How long the stop may take.
///
/// The CLI's stop drains in-flight requests, restores client configuration and verifies the Windows
/// respawn window, so this is generous on purpose: it bounds a hang, it does not pace a healthy
/// stop. Overrunning it is a failure, not a stop, because the caller's next step is to end the app
/// or replace the files the runtime is serving out of.
pub const DEADLINE: Duration = Duration::from_secs(30);

/// The outcomes the CLI can report. An outcome this shell does not know fails to parse, which is
/// the same answer as a stop that did not happen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Stopped,
    NotRunning,
    HistoryIncomplete,
    HistoryDeferred,
    Failed,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::NotRunning => "not-running",
            Self::HistoryIncomplete => "history-incomplete",
            Self::HistoryDeferred => "history-deferred",
            Self::Failed => "failed",
        }
    }
}

/// How the proxy half of the stop ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Proxy {
    Stopped,
    StoppedOrphan,
    NotRunning,
    StopFailed,
    OwnershipRefused,
    UnresolvablePid,
    Respawned,
    Unknown,
}

impl Proxy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::StoppedOrphan => "stopped-orphan",
            Self::NotRunning => "not-running",
            Self::StopFailed => "stop-failed",
            Self::OwnershipRefused => "ownership-refused",
            Self::UnresolvablePid => "unresolvable-pid",
            Self::Respawned => "respawned",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopSummary {
    pub schema: String,
    /// Strict exit-code view: true only for exit 0.
    pub ok: bool,
    pub outcome: Outcome,
    pub exit_code: i32,
    /// True when this stop left no proxy of this home running by its own paths.
    pub runtime_down: bool,
    pub proxy: Proxy,
    pub message: String,
}

/// What the shell concluded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StopResult {
    /// The CLI reported a clean stop and a runtime that is down.
    Stopped(StopSummary),
    /// It reported anything else, or the run could not be read at all.
    Failed(String),
}

impl StopResult {
    pub fn is_stopped(&self) -> bool {
        matches!(self, Self::Stopped(_))
    }

    pub fn describe(&self) -> String {
        match self {
            Self::Stopped(summary) => summary.message.clone(),
            Self::Failed(reason) => reason.clone(),
        }
    }
}

/// Read one stop summary.
///
/// Five facts have to hold together, and no four of them are enough.
///
/// The process has to have exited 0, and the document has to say so too: `ok` is the strict
/// exit-code view and `exitCode` is the number behind it, so 1, 79 and 80 are refusals however the
/// rest of the document reads. Reading only the document would take a run's word for its own exit
/// status; reading only the status would accept a summary that disagrees with it. And `runtimeDown`
/// is the CLI's own statement that no proxy of this home is left running — a service that failed
/// while the proxy happened to stop satisfies that and not the others, and it is exactly the case
/// that may respawn the runtime a moment later.
///
/// The fifth is that the document agrees with itself. The CLI's own summarizer cannot emit a
/// `failed` outcome beside a `stopped` proxy, but a reader that assumes that is trusting a
/// document to be self-consistent rather than checking. Only the two shapes that mean a runtime is
/// down are accepted, and an outcome or a proxy state this shell does not know fails to parse —
/// which is the same answer as a stop that did not happen.
pub fn read(exit_code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> StopResult {
    let text = String::from_utf8_lossy(stdout);
    let summary: StopSummary = match serde_json::from_str(text.trim()) {
        Ok(summary) => summary,
        Err(error) => {
            let detail = String::from_utf8_lossy(stderr);
            let detail = detail.trim();
            let code = exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "no exit code".to_owned());
            return StopResult::Failed(if detail.is_empty() {
                format!("the bundled CLI's stop output could not be read (exit {code}: {error})")
            } else {
                format!("the bundled CLI's stop output could not be read (exit {code}): {detail}")
            });
        }
    };
    if summary.schema != SCHEMA {
        return StopResult::Failed(format!(
            "the bundled CLI answered with schema {} and this app understands {SCHEMA}",
            summary.schema
        ));
    }
    let agrees = matches!(
        (summary.outcome, summary.proxy),
        (Outcome::Stopped, Proxy::Stopped)
            | (Outcome::Stopped, Proxy::StoppedOrphan)
            | (Outcome::NotRunning, Proxy::NotRunning)
    );
    if exit_code != Some(0)
        || !summary.ok
        || summary.exit_code != 0
        || !summary.runtime_down
        || !agrees
    {
        return StopResult::Failed(format!(
            "{} (outcome {}, proxy {}, exit {}, process exit {})",
            summary.message,
            summary.outcome.as_str(),
            summary.proxy.as_str(),
            summary.exit_code,
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "none".to_owned())
        ));
    }
    StopResult::Stopped(summary)
}

/// Run the bundled `ocx stop --json`, under the caller's deadline.
pub async fn run(app: &AppHandle, deadline: Instant) -> StopResult {
    let command = match app.shell().sidecar("ocx") {
        Ok(command) => command.args(["stop", "--json"]),
        Err(error) => {
            return StopResult::Failed(format!("the bundled CLI could not be started ({error})"))
        }
    };
    match timeout_at(deadline, command.output()).await {
        Ok(Ok(output)) => read(output.status.code(), &output.stdout, &output.stderr),
        Ok(Err(error)) => StopResult::Failed(format!("the bundled CLI could not be run ({error})")),
        Err(_) => {
            StopResult::Failed("the bundled CLI did not finish stopping before the deadline".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{read, Outcome, Proxy, StopResult, SCHEMA};

    fn document(ok: bool, outcome: &str, exit: i32, down: bool, proxy: &str) -> String {
        format!(
            r#"{{"schema":"ocx-stop/1","ok":{ok},"outcome":"{outcome}","exitCode":{exit},
               "runtimeDown":{down},"service":"absent","proxy":"{proxy}",
               "sharedTeardown":"restored","message":"a message"}}"#
        )
    }

    #[test]
    fn a_clean_stop_with_the_runtime_down_is_the_only_success() {
        let ok = document(true, "stopped", 0, true, "stopped");
        let result = read(Some(0), ok.as_bytes(), b"");
        assert!(result.is_stopped());
        match result {
            StopResult::Stopped(summary) => {
                assert_eq!(summary.schema, SCHEMA);
                assert_eq!(summary.outcome, Outcome::Stopped);
                assert_eq!(summary.proxy, Proxy::Stopped);
                assert!(summary.runtime_down);
            }
            StopResult::Failed(reason) => panic!("{reason}"),
        }
        // Nothing was running is equally a runtime that is down.
        assert!(read(
            Some(0),
            document(true, "not-running", 0, true, "not-running").as_bytes(),
            b""
        )
        .is_stopped());
    }

    #[test]
    fn a_non_zero_exit_is_never_folded_into_success() {
        // 79 and 80 report a proxy that went down with an obligation still owed. The runtime may
        // be down, but the run did not succeed, and an update must not install over it.
        for (outcome, exit) in [
            ("history-incomplete", 79),
            ("history-deferred", 80),
            ("failed", 1),
        ] {
            let document = document(false, outcome, exit, true, "stopped");
            let result = read(Some(exit), document.as_bytes(), b"");
            assert!(!result.is_stopped(), "{outcome}");
            assert!(result.describe().contains(outcome));
        }
    }

    #[test]
    fn the_process_status_and_the_document_have_to_agree() {
        let clean = document(true, "stopped", 0, true, "stopped");
        // A run that exited non-zero is a refusal even when its summary reads clean: taking the
        // document's word for its own exit status is taking one claim as evidence of itself.
        assert!(!read(Some(1), clean.as_bytes(), b"").is_stopped());
        assert!(!read(None, clean.as_bytes(), b"").is_stopped());
        // And a summary that contradicts its own exit code is not a stop either.
        let contradictory = document(true, "stopped", 1, true, "stopped");
        assert!(!read(Some(0), contradictory.as_bytes(), b"").is_stopped());
    }

    #[test]
    fn a_document_that_contradicts_itself_is_not_a_stop() {
        // The CLI's summarizer cannot emit this, and the reader does not assume that.
        let mixed = document(true, "failed", 0, true, "respawned");
        assert!(!read(Some(0), mixed.as_bytes(), b"").is_stopped());
        let orphan = document(true, "stopped", 0, true, "stopped-orphan");
        assert!(read(Some(0), orphan.as_bytes(), b"").is_stopped());
        // An outcome or a proxy state this shell does not know is not read at all.
        let future = document(true, "stopped", 0, true, "stopped")
            .replace("\"proxy\":\"stopped\"", "\"proxy\":\"parked\"");
        assert!(!read(Some(0), future.as_bytes(), b"").is_stopped());
    }

    #[test]
    fn a_runtime_still_up_is_a_failure_however_the_exit_reads() {
        for proxy in [
            "respawned",
            "stop-failed",
            "ownership-refused",
            "unresolvable-pid",
        ] {
            let document = document(true, "stopped", 0, false, proxy);
            assert!(
                !read(Some(0), document.as_bytes(), b"").is_stopped(),
                "{proxy}"
            );
        }
    }

    #[test]
    fn output_that_cannot_be_read_is_a_failure_not_a_stop() {
        assert!(!read(Some(0), b"", b"boom").is_stopped());
        assert!(!read(Some(0), b"not json", b"").is_stopped());
        assert!(!read(None, b"", b"").is_stopped());
        let future =
            document(true, "stopped", 0, true, "stopped").replace("ocx-stop/1", "ocx-stop/2");
        let result = read(Some(0), future.as_bytes(), b"");
        assert!(!result.is_stopped());
        assert!(result.describe().contains("ocx-stop/2"));
    }
}
