//! Starting and watching the runtime this app owns.
//!
//! The spawn event stream used to be discarded into `_events`, which is why a sidecar that exited
//! immediately — a binary built for a CPU instruction set this machine does not have, a port
//! already taken, a corrupt install — presented as the same generic health failure as a slow start.
//! The child's exit code and its last output were both available and both thrown away. They are
//! consumed here instead, and they are what the startup diagnostic is made of.
//!
//! Stopping it is not here. D4 gives that to the bundled `ocx stop`, which owns the receipt-backed
//! teardown this process cannot perform on itself; see `runtime_stop.rs`.
//!
//! The exit is also where supervision starts: once it is recorded, the hook `supervisor.rs`
//! registered hears which child ended and how, so a runtime that went away is noticed at once
//! instead of only when the next startup run reads the record.

use crate::endpoint::ProxyEndpoint;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tauri::{async_runtime::Receiver, AppHandle, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
/// How much sidecar output the diagnostic keeps. Enough to carry a stack trace or a startup
/// refusal, bounded so a chatty runtime cannot grow the buffer for the life of the process.
const MAX_LINES: usize = 40;

/// The marker that tells the runtime this app waits on it (`DESKTOP_SUPERVISED_ENV` in
/// `src/lib/system-restart-contract.ts`). Under it a restart exits with
/// [`crate::supervisor::REQUESTED_RESTART_EXIT_CODE`] instead of spawning a detached replacement
/// this app could neither see nor stop, and the supervisor starts the replacement.
pub const SUPERVISED_ENV: &str = "OCX_DESKTOP_SUPERVISED";

/// Told which child ended, and how, once its exit is recorded.
pub type ExitHook = Arc<dyn Fn(u32, SidecarExit) + Send + Sync>;

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
    hook: Arc<Mutex<Option<ExitHook>>>,
    /// The child this view follows. Only a view made by [`SidecarWatch::for_child`] has one, and
    /// only such a view reports an exit to the hook: the record is shared across attempts, the pid
    /// is what tells the supervisor which attempt ended.
    pid: Option<u32>,
}

impl SidecarWatch {
    pub fn record(&self, event: SidecarEvent) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.record(event);
        }
    }

    /// Register what hears about a child's exit. One hook for the life of the app.
    pub fn on_exit(&self, hook: impl Fn(u32, SidecarExit) + Send + Sync + 'static) {
        if let Ok(mut slot) = self.hook.lock() {
            *slot = Some(Arc::new(hook));
        }
    }

    /// The same record, following one spawned child.
    pub fn for_child(&self, pid: u32) -> Self {
        Self {
            inner: self.inner.clone(),
            hook: self.hook.clone(),
            pid: Some(pid),
        }
    }

    /// Record one event, and report an exit to the hook after it is recorded, so whatever the hook
    /// starts reads the exit it was told about.
    fn deliver(&self, event: SidecarEvent) {
        let exit = match &event {
            SidecarEvent::Exited(exit) => Some(*exit),
            SidecarEvent::Line(_) => None,
        };
        self.record(event);
        let (Some(exit), Some(pid)) = (exit, self.pid) else {
            return;
        };
        // Cloned out so the hook never runs under this lock.
        let hook = self.hook.lock().ok().and_then(|slot| slot.clone());
        if let Some(hook) = hook {
            hook(pid, exit);
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
                    watch.deliver(event);
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
        .env("OPENCODEX_GUI_DIST", gui_dist)
        .env(SUPERVISED_ENV, "1");
    let (events, child) = command.spawn().map_err(|error| error.to_string())?;
    let watch = watch.for_child(child.pid());
    watch.follow(events);
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::{SidecarEvent, SidecarExit, SidecarWatch, MAX_LINES};
    use std::sync::{Arc, Mutex};

    #[test]
    fn an_exit_reaches_the_hook_with_the_childs_pid_after_it_is_recorded() {
        let watch = SidecarWatch::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = watch.clone();
        let sink = seen.clone();
        watch.on_exit(move |pid, exit| {
            // Whatever the hook starts reads the exit it was told about.
            let recorded = record.exit().and_then(|exit| exit.code);
            sink.lock().unwrap().push((pid, exit.code, recorded));
        });
        // The shared record follows no child, so it names nobody to the hook.
        watch.deliver(SidecarEvent::Exited(SidecarExit {
            code: Some(1),
            signal: None,
        }));
        let child = watch.for_child(4242);
        child.deliver(SidecarEvent::Line("listening on 10100".into()));
        child.deliver(SidecarEvent::Exited(SidecarExit {
            code: Some(75),
            signal: None,
        }));
        assert_eq!(*seen.lock().unwrap(), vec![(4242, Some(75), Some(75))]);
        assert_eq!(watch.lines(), vec!["listening on 10100".to_owned()]);
    }

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
}
