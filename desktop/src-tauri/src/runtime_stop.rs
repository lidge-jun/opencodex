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
//! either. Only an exact exit-0 stop or validated history-only completion may lead to takeover;
//! approval and manager refusals stay terminal even when the endpoint becomes quiet.

use serde::Deserialize;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tokio::time::{timeout_at, Instant};

/// The wire version this shell understands.
pub const SCHEMA: &str = "ocx-stop/1";
const HISTORY_INCOMPLETE_EXIT_CODE: i32 = 79;

/// How long the exit or restart drain's stop may take.
///
/// The CLI's stop drains in-flight requests, restores client configuration and verifies the Windows
/// respawn window, so this is generous on purpose: it bounds a hang, it does not pace a healthy
/// stop. Overrunning it is a failure, not a stop, because the caller's next step is to end the app
/// or replace the files the runtime is serving out of.
///
/// Windows gets longer. There the CLI stops the service manager, ends the wrappers that could
/// relaunch the proxy, and then holds the port free for one relaunch period; with a registered
/// service the worst case of that sequence does not fit in 30 seconds, and a stop the CLI cannot
/// finish in the time it is given is refused before it changes anything.
pub const DEADLINE: Duration = drain_deadline_for(cfg!(target_os = "windows"));

/// The drain deadline for a platform, split out so both answers stay testable on either.
pub const fn drain_deadline_for(windows: bool) -> Duration {
    if windows {
        Duration::from_secs(75)
    } else {
        Duration::from_secs(30)
    }
}

/// The environment variable that hands the stop's deadline to the CLI, in decimal milliseconds
/// measured from the child's start.
///
/// An environment variable rather than the CLI's `--deadline-ms` flag, because an older bundled CLI
/// rejects a flag it does not know and ignores a variable it does not read, so a mixed pair of
/// versions keeps today's behavior.
pub const DEADLINE_ENV: &str = "OCX_STOP_DEADLINE_MS";

/// Startup time the consented takeover keeps back from the CLI: after the stop, the silence probe
/// and `ocx service claim` still run under the same startup deadline.
pub const TAKEOVER_MARGIN: Duration = Duration::from_secs(5);

/// Drain time kept back from the CLI for spawning it and reading its answer.
pub const DRAIN_MARGIN: Duration = Duration::from_secs(3);

/// The value for [`DEADLINE_ENV`]: what is left of the caller's deadline after its margin, in whole
/// milliseconds. `None` when nothing positive is left, so the variable is not set at all rather
/// than set to a deadline that has already passed.
pub fn deadline_env_value(remaining: Duration, margin: Duration) -> Option<String> {
    let millis = remaining.checked_sub(margin)?.as_millis();
    (millis > 0).then(|| millis.to_string())
}

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
    ApprovalChanged,
    ManagerStillActive,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::NotRunning => "not-running",
            Self::HistoryIncomplete => "history-incomplete",
            Self::HistoryDeferred => "history-deferred",
            Self::Failed => "failed",
            Self::ApprovalChanged => "approval-changed",
            Self::ManagerStillActive => "manager-still-active",
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
    /// Why the Windows service stop did not succeed, when the CLI knows: `access-denied`,
    /// `evidence-unreadable`, `unbound-wrapper` or `unverified-budget`. Additive within
    /// `ocx-stop/1`, so an older CLI leaves it out; a reason this shell does not know is kept and
    /// shown as it is, and no reason changes how the outcome is read.
    #[serde(default)]
    pub service_stop_reason: Option<String>,
    /// The CLI's own processes are gone but another program holds the runtime's port. Additive
    /// within `ocx-stop/1`; absent or `null` means false, so a stray `null` never fails the parse.
    #[serde(default)]
    pub port_held_by_foreign: Option<bool>,
}

impl StopSummary {
    /// What the additive fields add to the CLI's message, in words a person can act on.
    pub fn notes(&self) -> Option<String> {
        let mut notes = Vec::new();
        match self.service_stop_reason.as_deref() {
            None => {}
            Some("access-denied") => notes.push(
                "Windows denied stopping the service; run `ocx stop` from an elevated terminal"
                    .to_owned(),
            ),
            Some("unverified-budget") => notes.push(
                "the stop did not have enough time to finish safely, so nothing was changed; \
                 retry with `ocx stop` from a terminal"
                    .to_owned(),
            ),
            Some("unbound-wrapper") => notes.push(
                "a service wrapper started outside the service is still running and can restart \
                 the runtime; end it, then stop again"
                    .to_owned(),
            ),
            Some("evidence-unreadable") => notes.push(
                "the state of the service's processes could not be read, so the stop could not be \
                 confirmed"
                    .to_owned(),
            ),
            Some(other) => notes.push(format!("service stop reason: {other}")),
        }
        if self.port_held_by_foreign == Some(true) {
            notes.push("another program is holding the runtime's port".to_owned());
        }
        (!notes.is_empty()).then(|| notes.join("; "))
    }

    /// The CLI's message with [`Self::notes`] appended.
    pub fn described(&self) -> String {
        match self.notes() {
            Some(notes) => format!("{}; {notes}", self.message),
            None => self.message.clone(),
        }
    }
}

/// What the shell concluded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StopResult {
    /// The CLI reported a clean stop and a runtime that is down.
    Stopped(Box<StopSummary>),
    ApprovalChanged(String),
    ManagerStillActive(String),
    HistoryIncomplete(String),
    /// It reported anything else, or the run could not be read at all.
    Failed(String),
}

impl StopResult {
    pub fn is_stopped(&self) -> bool {
        matches!(self, Self::Stopped(_))
    }

    pub fn is_approval_changed(&self) -> bool {
        matches!(self, Self::ApprovalChanged(_))
    }

    pub fn may_check_silence(&self) -> bool {
        matches!(self, Self::Stopped(summary) if summary.outcome == Outcome::Stopped)
            || matches!(self, Self::HistoryIncomplete(_))
    }

    pub fn describe(&self) -> String {
        match self {
            Self::Stopped(summary) => summary.described(),
            Self::ApprovalChanged(reason) => reason.clone(),
            Self::ManagerStillActive(reason) => reason.clone(),
            Self::HistoryIncomplete(reason) => reason.clone(),
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
    if summary.outcome == Outcome::ApprovalChanged {
        return StopResult::ApprovalChanged(summary.described());
    }
    if summary.outcome == Outcome::ManagerStillActive {
        return StopResult::ManagerStillActive(summary.described());
    }
    if summary.outcome == Outcome::HistoryIncomplete
        && exit_code == Some(HISTORY_INCOMPLETE_EXIT_CODE)
        && summary.exit_code == HISTORY_INCOMPLETE_EXIT_CODE
        && !summary.ok
        && summary.runtime_down
        && matches!(summary.proxy, Proxy::Stopped | Proxy::StoppedOrphan)
    {
        return StopResult::HistoryIncomplete(format!(
            "{} (outcome {})",
            summary.described(),
            summary.outcome.as_str()
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
            summary.described(),
            summary.outcome.as_str(),
            summary.proxy.as_str(),
            summary.exit_code,
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "none".to_owned())
        ));
    }
    StopResult::Stopped(Box::new(summary))
}

/// Run the ordinary bundled stop used when this app exits its own runtime.
pub async fn run(app: &AppHandle, deadline: Instant) -> StopResult {
    run_with_args(
        app,
        deadline,
        DRAIN_MARGIN,
        vec!["stop".to_owned(), "--json".to_owned()],
    )
    .await
}

/// Run the bundled stop bound to the approved runtime, under the caller's deadline.
pub async fn run_approved(
    app: &AppHandle,
    deadline: Instant,
    approved: &crate::resolve::Resolved,
) -> StopResult {
    let (Some(pid), Some(port), crate::resolve::Takeover::Supported { token, .. }) = (
        approved.liveness.pid,
        approved.liveness.port,
        &approved.takeover,
    ) else {
        return StopResult::Failed("the approved runtime could not be identified".to_owned());
    };
    if pid == 0 || port == 0 {
        return StopResult::Failed("the approved runtime could not be identified".to_owned());
    }
    let argv = vec![
        "stop".to_owned(),
        "--json".to_owned(),
        "--expect-pid".to_owned(),
        pid.to_string(),
        "--expect-port".to_owned(),
        port.to_string(),
        "--expect-hostname".to_owned(),
        approved.liveness.hostname.clone().unwrap_or_default(),
        "--expect-config-home".to_owned(),
        approved.config_home.clone(),
        "--expect-cli-version".to_owned(),
        approved.cli_version.clone(),
        "--expect-compatibility-token".to_owned(),
        token.clone(),
    ];
    run_with_args(app, deadline, TAKEOVER_MARGIN, argv).await
}

async fn run_with_args(
    app: &AppHandle,
    deadline: Instant,
    margin: Duration,
    argv: Vec<String>,
) -> StopResult {
    let mut command = match app.shell().sidecar("ocx") {
        Ok(command) => command.args(argv),
        Err(error) => {
            return StopResult::Failed(format!("the bundled CLI could not be started ({error})"))
        }
    };
    // Measured immediately before the spawn, so the CLI's clock and this one start together.
    // Always set, so a value inherited from this process's own environment never reaches the
    // child: an empty value means "no deadline" to the CLI, the same as an absent one.
    let value = deadline_env_value(deadline.saturating_duration_since(Instant::now()), margin);
    command = command.env(DEADLINE_ENV, value.unwrap_or_default());
    match timeout_at(
        deadline,
        crate::process_spawn::with_spawn_async(command.output()),
    )
    .await
    {
        Ok(Ok(output)) => read(output.status.code(), &output.stdout, &output.stderr),
        Ok(Err(error)) => StopResult::Failed(format!("the bundled CLI could not be run ({error})")),
        Err(_) => {
            StopResult::Failed("the bundled CLI did not finish stopping before the deadline".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        deadline_env_value, drain_deadline_for, read, Outcome, Proxy, StopResult, DEADLINE,
        DRAIN_MARGIN, SCHEMA, TAKEOVER_MARGIN,
    };
    use std::time::Duration;

    fn document(ok: bool, outcome: &str, exit: i32, down: bool, proxy: &str) -> String {
        format!(
            r#"{{"schema":"ocx-stop/1","ok":{ok},"outcome":"{outcome}","exitCode":{exit},
               "runtimeDown":{down},"service":"absent","proxy":"{proxy}",
               "sharedTeardown":"restored","message":"a message"}}"#
        )
    }

    /// The same document with additive fields spliced in after `message`.
    fn with_fields(document: &str, fields: &str) -> String {
        document.replace(
            r#""message":"a message""#,
            &format!(r#""message":"a message",{fields}"#),
        )
    }

    #[test]
    fn an_older_document_without_the_additive_fields_reads_as_it_does_today() {
        let clean = document(true, "stopped", 0, true, "stopped");
        match read(Some(0), clean.as_bytes(), b"") {
            StopResult::Stopped(summary) => {
                assert_eq!(summary.service_stop_reason, None);
                assert_eq!(summary.port_held_by_foreign, None);
                assert_eq!(summary.notes(), None);
            }
            other => panic!("unexpected result: {other:?}"),
        }
        let refused = document(false, "manager-still-active", 1, false, "unknown");
        assert_eq!(
            read(Some(1), refused.as_bytes(), b""),
            StopResult::ManagerStillActive("a message".to_owned())
        );
    }

    #[test]
    fn each_known_service_stop_reason_is_read_and_described() {
        for (reason, expected) in [
            ("access-denied", "elevated terminal"),
            ("unverified-budget", "from a terminal"),
            ("unbound-wrapper", "started outside the service"),
            ("evidence-unreadable", "could not be read"),
        ] {
            let refused = with_fields(
                &document(false, "manager-still-active", 1, false, "unknown"),
                &format!(r#""serviceStopReason":"{reason}""#),
            );
            let result = read(Some(1), refused.as_bytes(), b"");
            assert!(
                matches!(&result, StopResult::ManagerStillActive(_)),
                "{reason}: {result:?}"
            );
            let text = result.describe();
            assert!(text.starts_with("a message"), "{reason}: {text}");
            assert!(text.contains(expected), "{reason}: {text}");

            // The snapshotless path reports the same reason beside `failed`, and it stays a failure.
            let failed = with_fields(
                &document(false, "failed", 1, false, "unknown"),
                &format!(r#""serviceStopReason":"{reason}""#),
            );
            let result = read(Some(1), failed.as_bytes(), b"");
            assert!(matches!(&result, StopResult::Failed(_)), "{reason}");
            assert!(result.describe().contains(expected), "{reason}");
        }
    }

    #[test]
    fn an_unknown_service_stop_reason_is_tolerated_and_changes_no_verdict() {
        let clean = with_fields(
            &document(true, "stopped", 0, true, "stopped"),
            r#""serviceStopReason":"something-newer""#,
        );
        let result = read(Some(0), clean.as_bytes(), b"");
        assert!(result.is_stopped(), "{result:?}");
        assert!(result.describe().contains("something-newer"));
        let refused = with_fields(
            &document(false, "manager-still-active", 1, false, "unknown"),
            r#""serviceStopReason":"something-newer""#,
        );
        assert!(matches!(
            read(Some(1), refused.as_bytes(), b""),
            StopResult::ManagerStillActive(_)
        ));
    }

    #[test]
    fn a_port_held_by_another_program_is_read_and_described() {
        let failed = with_fields(
            &document(false, "failed", 1, true, "stopped"),
            r#""portHeldByForeign":true"#,
        );
        let result = read(Some(1), failed.as_bytes(), b"");
        assert!(matches!(&result, StopResult::Failed(_)));
        assert!(result.describe().contains("another program"), "{result:?}");

        // Reported beside a clean stop it is a warning, and the stop is still a stop.
        let clean = with_fields(
            &document(true, "stopped", 0, true, "stopped"),
            r#""portHeldByForeign":true,"serviceStopReason":"access-denied""#,
        );
        let result = read(Some(0), clean.as_bytes(), b"");
        assert!(result.is_stopped());
        let text = result.describe();
        assert!(text.contains("another program"), "{text}");
        assert!(text.contains("elevated terminal"), "{text}");

        let explicit_false = with_fields(
            &document(true, "stopped", 0, true, "stopped"),
            r#""portHeldByForeign":false"#,
        );
        assert_eq!(
            read(Some(0), explicit_false.as_bytes(), b"").describe(),
            "a message"
        );

        let explicit_null = with_fields(
            &document(true, "stopped", 0, true, "stopped"),
            r#""portHeldByForeign":null"#,
        );
        let result = read(Some(0), explicit_null.as_bytes(), b"");
        assert!(result.is_stopped());
        assert_eq!(result.describe(), "a message");
    }

    #[test]
    fn the_deadline_hand_off_keeps_each_margin_and_is_omitted_when_not_positive() {
        assert_eq!(TAKEOVER_MARGIN, Duration::from_secs(5));
        assert_eq!(DRAIN_MARGIN, Duration::from_secs(3));
        // Consented takeover: the remaining startup deadline minus five seconds.
        assert_eq!(
            deadline_env_value(Duration::from_millis(83_250), TAKEOVER_MARGIN).as_deref(),
            Some("78250")
        );
        // Exit drain: the drain deadline minus three seconds.
        assert_eq!(
            deadline_env_value(Duration::from_secs(75), DRAIN_MARGIN).as_deref(),
            Some("72000")
        );
        assert_eq!(
            deadline_env_value(Duration::from_secs(30), DRAIN_MARGIN).as_deref(),
            Some("27000")
        );
        // Nothing left after the margin, or less than a whole millisecond, is no deadline at all.
        assert_eq!(
            deadline_env_value(Duration::from_secs(5), TAKEOVER_MARGIN),
            None
        );
        assert_eq!(
            deadline_env_value(Duration::from_secs(2), TAKEOVER_MARGIN),
            None
        );
        assert_eq!(deadline_env_value(Duration::ZERO, DRAIN_MARGIN), None);
        assert_eq!(
            deadline_env_value(Duration::from_micros(3_000_900), DRAIN_MARGIN),
            None
        );
        assert_eq!(
            deadline_env_value(Duration::from_micros(3_001_900), DRAIN_MARGIN).as_deref(),
            Some("1")
        );
    }

    #[test]
    fn only_windows_gets_the_longer_exit_drain() {
        assert_eq!(drain_deadline_for(true), Duration::from_secs(75));
        assert_eq!(drain_deadline_for(false), Duration::from_secs(30));
        assert_eq!(DEADLINE, drain_deadline_for(cfg!(target_os = "windows")));
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
            StopResult::ApprovalChanged(reason)
            | StopResult::ManagerStillActive(reason)
            | StopResult::HistoryIncomplete(reason)
            | StopResult::Failed(reason) => panic!("{reason}"),
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

    #[test]
    fn guarded_refusals_parse_as_terminal_results() {
        for (outcome, expected) in [
            ("approval-changed", Outcome::ApprovalChanged),
            ("manager-still-active", Outcome::ManagerStillActive),
        ] {
            let output = document(false, outcome, 1, false, "unknown");
            let result = read(Some(1), output.as_bytes(), b"");
            assert!(!result.may_check_silence());
            match result {
                StopResult::ApprovalChanged(_) if expected == Outcome::ApprovalChanged => {}
                StopResult::ManagerStillActive(_) if expected == Outcome::ManagerStillActive => {}
                other => panic!("unexpected result: {other:?}"),
            }
            assert_eq!(expected.as_str(), outcome);
        }
    }

    #[test]
    fn only_proven_history_incomplete_may_continue_to_silence() {
        let complete = document(false, "history-incomplete", 79, true, "stopped");
        let result = read(Some(79), complete.as_bytes(), b"");
        assert!(matches!(&result, StopResult::HistoryIncomplete(_)));
        assert!(!result.is_stopped());
        assert!(result.may_check_silence());

        let wrong_exit = read(Some(80), complete.as_bytes(), b"");
        assert!(matches!(wrong_exit, StopResult::Failed(_)));
        let unproven = document(false, "history-incomplete", 79, false, "stopped");
        assert!(matches!(
            read(Some(79), unproven.as_bytes(), b""),
            StopResult::Failed(_)
        ));
        let deferred = document(false, "history-deferred", 80, true, "stopped");
        assert!(!read(Some(80), deferred.as_bytes(), b"").may_check_silence());
        let not_running = document(true, "not-running", 0, true, "not-running");
        assert!(!read(Some(0), not_running.as_bytes(), b"").may_check_silence());
        assert!(!read(Some(1), b"{", b"").may_check_silence());
    }
}
