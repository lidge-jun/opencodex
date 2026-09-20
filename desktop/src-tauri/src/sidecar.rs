//! Starting, watching and draining the runtime this app owns.
//!
//! The spawn event stream used to be discarded into `_events`, which is why a sidecar that exited
//! immediately — a binary built for a CPU instruction set this machine does not have, a port
//! already taken, a corrupt install — presented as the same generic health failure as a slow start.
//! The child's exit code and its last output were both available and both thrown away. They are
//! consumed here instead, and they are what the startup diagnostic is made of.

use crate::{discovery::ProxyEndpoint, proxy::ProxyClient};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tauri::{async_runtime::Receiver, AppHandle, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::time::{sleep, Duration, Instant};

/// How much sidecar output the diagnostic keeps. Enough to carry a stack trace or a startup
/// refusal, bounded so a chatty runtime cannot grow the buffer for the life of the process.
const MAX_LINES: usize = 40;

/// How long a graceful stop may take before it is reported as incomplete. The runtime's own stop
/// restores client configuration and lets in-flight requests finish, so this is generous on
/// purpose; it bounds a hang, it does not pace a healthy stop.
pub const DRAIN_DEADLINE: Duration = Duration::from_secs(15);

/// How the sidecar process ended.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SidecarExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl SidecarExit {
    pub fn describe(&self) -> String {
        match (self.code, self.signal) {
            (Some(code), _) => format!("exit code {code}"),
            (None, Some(signal)) => format!("terminated by signal {signal}"),
            (None, None) => "exited without reporting a code".to_owned(),
        }
    }
}

/// One thing the spawned child told us.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SidecarEvent {
    Line(String),
    Exited(SidecarExit),
}

#[derive(Default)]
struct WatchInner {
    lines: VecDeque<String>,
    exit: Option<SidecarExit>,
}

impl WatchInner {
    fn record(&mut self, event: SidecarEvent) {
        match event {
            SidecarEvent::Line(line) => {
                let line = line.trim_end().to_owned();
                if line.is_empty() {
                    return;
                }
                if self.lines.len() == MAX_LINES {
                    self.lines.pop_front();
                }
                self.lines.push_back(line);
            }
            SidecarEvent::Exited(exit) => self.exit = Some(exit),
        }
    }
}

/// The consumed spawn event stream of the child this app started.
#[derive(Clone, Default)]
pub struct SidecarWatch {
    inner: Arc<Mutex<WatchInner>>,
}

impl SidecarWatch {
    pub fn record(&self, event: SidecarEvent) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.record(event);
        }
    }

    pub fn exit(&self) -> Option<SidecarExit> {
        self.inner.lock().ok().and_then(|inner| inner.exit)
    }

    pub fn lines(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|inner| inner.lines.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Forget the previous attempt so a retry's diagnostic describes the retry.
    pub fn reset(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.lines.clear();
            inner.exit = None;
        }
    }

    /// Drain the spawn event stream into this record for as long as the child lives.
    pub fn follow(&self, mut events: Receiver<CommandEvent>) {
        let watch = self.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                if let Some(event) = translate(event) {
                    watch.record(event);
                }
            }
        });
    }
}

fn translate(event: CommandEvent) -> Option<SidecarEvent> {
    match event {
        CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => Some(SidecarEvent::Line(
            String::from_utf8_lossy(&bytes).into_owned(),
        )),
        CommandEvent::Error(message) => Some(SidecarEvent::Line(format!("error: {message}"))),
        CommandEvent::Terminated(payload) => Some(SidecarEvent::Exited(SidecarExit {
            code: payload.code,
            signal: payload.signal,
        })),
        _ => None,
    }
}

/// Start the bundled runtime and begin consuming what it says.
///
/// The port is still passed explicitly. D5 hands that resolution to the bundled CLI so a user on a
/// custom `config.port` is not started on a different one; this is the call site that changes when
/// lane A's resolve verb lands, and nothing else here depends on where the number came from.
pub fn start(
    app: &AppHandle,
    endpoint: ProxyEndpoint,
    watch: &SidecarWatch,
) -> Result<CommandChild, String> {
    let gui_dist = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("gui")
        .join("dist");
    let command = app
        .shell()
        .sidecar("ocx")
        .map_err(|error| error.to_string())?
        .args(["start", "--port", &endpoint.port.to_string()])
        .env("OPENCODEX_GUI_DIST", gui_dist);
    let (events, child) = command.spawn().map_err(|error| error.to_string())?;
    watch.follow(events);
    Ok(child)
}

/// What a graceful stop did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DrainOutcome {
    /// This app did not start the runtime, so it does not stop it. Someone else's proxy outlives
    /// this app's quit, which is the whole point of only ever draining what we own.
    NotOwned,
    /// The endpoint stopped answering within the deadline.
    Stopped,
    /// The stop was accepted and the endpoint still answers.
    StillRunning,
    /// The stop request itself failed.
    Refused(String),
}

impl DrainOutcome {
    pub fn failure(&self) -> Option<String> {
        match self {
            Self::NotOwned | Self::Stopped => None,
            Self::StillRunning => {
                Some("the runtime still answers after the graceful stop deadline".to_owned())
            }
            Self::Refused(error) => Some(error.clone()),
        }
    }
}

/// Stop the runtime this app owns and wait until it is actually gone.
///
/// Only an app-owned runtime reaches here, which is why the management stop is the right
/// instrument: its documented refusals are about launchd, systemd and the Windows respawn window,
/// none of which apply to a child this process spawned. Taking over somebody else's *managed*
/// runtime is a different act and needs the bundled `ocx stop` — that is D4, and it is lane A's
/// contract, not this path.
pub async fn drain(proxy: &ProxyClient, owned: bool, watch: &SidecarWatch) -> DrainOutcome {
    if !owned {
        return DrainOutcome::NotOwned;
    }
    let deadline = Instant::now() + DRAIN_DEADLINE;
    let refusal = match proxy.stop_within(deadline).await {
        Some(Ok(_)) => None,
        Some(Err(error)) => {
            // A runtime that has already gone is a drained runtime, not a failed stop.
            if gone(proxy, watch, deadline).await {
                return DrainOutcome::Stopped;
            }
            Some(format!("{error:?}"))
        }
        None => Some("the stop request did not answer before the deadline".to_owned()),
    };
    while Instant::now() < deadline {
        if gone(proxy, watch, deadline).await {
            return DrainOutcome::Stopped;
        }
        sleep(Duration::from_millis(200)).await;
    }
    match refusal {
        Some(error) => DrainOutcome::Refused(error),
        None => DrainOutcome::StillRunning,
    }
}

/// Whether the runtime is actually gone, rather than merely not answering the way we hoped.
///
/// Two facts count, and no others. The child reporting its own termination through the spawn event
/// stream is conclusive. Failing that, the endpoint *refusing a connection* says the listener has
/// released the port. A timeout, an unauthorized reply or a body that will not parse are none of
/// those: they mean something answered, or might still be there. Reading any error as proof is how
/// a stop that never happened gets reported as a completed drain.
async fn gone(proxy: &ProxyClient, watch: &SidecarWatch, deadline: Instant) -> bool {
    if watch.exit().is_some() {
        return true;
    }
    matches!(
        proxy.alive_within(deadline).await,
        Some(Err(error)) if error.is_unreachable()
    )
}

#[cfg(test)]
mod tests {
    use super::{DrainOutcome, SidecarEvent, SidecarExit, SidecarWatch, MAX_LINES};

    #[test]
    fn the_exit_code_survives_the_event_stream() {
        let watch = SidecarWatch::default();
        watch.record(SidecarEvent::Line("listening on 10100".into()));
        watch.record(SidecarEvent::Exited(SidecarExit {
            code: Some(1),
            signal: None,
        }));
        assert_eq!(watch.exit().and_then(|exit| exit.code), Some(1));
        assert_eq!(watch.lines(), vec!["listening on 10100".to_owned()]);
    }

    #[test]
    fn output_is_bounded_and_keeps_the_end() {
        let watch = SidecarWatch::default();
        for index in 0..(MAX_LINES + 5) {
            watch.record(SidecarEvent::Line(format!("line {index}")));
        }
        let lines = watch.lines();
        assert_eq!(lines.len(), MAX_LINES);
        assert_eq!(lines.first().unwrap(), "line 5");
        assert_eq!(lines.last().unwrap(), &format!("line {}", MAX_LINES + 4));
    }

    #[test]
    fn blank_output_is_not_recorded_and_a_reset_forgets_the_attempt() {
        let watch = SidecarWatch::default();
        watch.record(SidecarEvent::Line("   \n".into()));
        assert!(watch.lines().is_empty());
        watch.record(SidecarEvent::Line("boom".into()));
        watch.record(SidecarEvent::Exited(SidecarExit {
            code: None,
            signal: Some(9),
        }));
        watch.reset();
        assert!(watch.lines().is_empty());
        assert!(watch.exit().is_none());
    }

    #[test]
    fn an_exit_reads_as_a_code_a_signal_or_neither() {
        assert_eq!(
            SidecarExit {
                code: Some(2),
                signal: None
            }
            .describe(),
            "exit code 2"
        );
        assert_eq!(
            SidecarExit {
                code: None,
                signal: Some(9)
            }
            .describe(),
            "terminated by signal 9"
        );
        assert_eq!(
            SidecarExit::default().describe(),
            "exited without reporting a code"
        );
    }

    #[test]
    fn only_an_incomplete_drain_reports_a_failure() {
        assert!(DrainOutcome::NotOwned.failure().is_none());
        assert!(DrainOutcome::Stopped.failure().is_none());
        assert!(DrainOutcome::StillRunning.failure().is_some());
        assert_eq!(
            DrainOutcome::Refused("Unreachable".into()).failure(),
            Some("Unreachable".to_owned())
        );
    }
}
