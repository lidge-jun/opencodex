//! Keeping the runtime alive: what the app does when the runtime it runs goes away unasked.
//!
//! The startup sequence used to be the only thing that ever started a runtime, and it ran at
//! launch and on the failure page's retry. A runtime that exited afterwards — a crash, a terminal
//! `ocx stop`, or a restart the runtime performed itself by handing the port to a detached
//! grandchild this app could not see — was recorded in memory and nothing more. The port kept
//! refusing connections until somebody quit and reopened the app.
//!
//! Two signals start a recovery here, and both only reach the same startup sequence in
//! [`Mode::Recover`], so every gate it has still holds: only a proven absence starts a runtime, a
//! runtime that answers is attached as a guest, and nothing is ever killed or signalled.
//!
//! - The exit of the child this app started ([`on_exit`]). Exit code
//!   [`REQUESTED_RESTART_EXIT_CODE`] is the runtime asking for exactly this: under the marker
//!   `sidecar.rs` sets, a restart (a join into a Child, a memory restart, a disconnect) exits with
//!   it instead of spawning past the app, and the replacement starts almost at once. Any other exit
//!   waits a capped backoff first, so a replacement or a service wrapper that already owns the
//!   port binds before the app looks.
//! - The watchdog ([`watchdog_tick`]), every few seconds while a run is Ready: a different process
//!   answering the endpoint, or several refused connections in a row. It covers a runtime this app
//!   is only a guest on and an exit event that never arrived. Timeouts and unauthorized or
//!   unreadable answers never count; they say something is there.
//!
//! A recovery that finds the port held by a listener this app cannot use (one bound off loopback)
//! is not retried: another attempt would find the same listener, and each one costs a resolve.
//! The supervisor parks instead, and the same watchdog tick asks the endpoint only whether
//! something changed there ([`Parked`]).
//!
//! The tray's Stop, Quit and an update's drain clear the app's wish for a runtime before the
//! runtime's exit can arrive (`exit.rs`), so none of them is ever undone. Every decision is
//! appended to `runtime-supervisor.log` in the app's log directory, bounded, because the exit
//! code otherwise dies with the app.

use crate::{
    exit::{ExitCoordinator, ExitPhase},
    sidecar::SidecarExit,
    startup::{self, Mode, Startup},
    AppState,
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tokio::time::{sleep, Duration, Instant};

/// The exit code a runtime ends with to hand its restart to this app
/// (`DESKTOP_RESTART_EXIT_CODE` in `src/lib/system-restart-contract.ts`; EX_TEMPFAIL).
pub const REQUESTED_RESTART_EXIT_CODE: i32 = 75;
/// A requested restart has already released the port, so its replacement starts almost at once.
pub const REQUESTED_RESTART_DELAY: Duration = Duration::from_millis(500);
/// The wait before bringing back a runtime that ended unasked, by how many recoveries ran recently.
/// The first step leaves a replacement or a service wrapper that owns the port time to bind first.
pub const BACKOFF: [Duration; 5] = [
    Duration::from_secs(3),
    Duration::from_secs(6),
    Duration::from_secs(12),
    Duration::from_secs(24),
    Duration::from_secs(30),
];
/// How long a runtime has to stay healthy before the backoff starts over.
pub const HEALTHY_RESET: Duration = Duration::from_secs(120);
/// How often the watchdog asks the endpoint who it is, and only while a run is Ready.
pub const WATCHDOG_INTERVAL: Duration = Duration::from_secs(5);
/// Refused connections in a row before the watchdog treats the runtime this app started as gone.
pub const UNREACHABLE_LIMIT: u32 = 3;
/// The same for a runtime this app is only a guest on. Its own manager (a service, a terminal, an
/// update in progress) gets about a minute to bring it back before the app starts one of its own.
pub const GUEST_UNREACHABLE_LIMIT: u32 = 12;
// A runtime somebody else manages gets its manager's grace; one this app started does not.
const _: () = assert!(UNREACHABLE_LIMIT < GUEST_UNREACHABLE_LIMIT);
/// The supervisor log's cap: at this size it is emptied before the next line.
pub const LOG_CAP_BYTES: u64 = 256 * 1024;
pub const LOG_FILE: &str = "runtime-supervisor.log";

/// What an exit is judged on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Input {
    pub phase: ExitPhase,
    pub wanted: bool,
    pub reason_set: bool,
    pub startup_running: bool,
    /// The exit belongs to a child this app no longer tracks.
    pub stale_pid: bool,
    pub requested_restart: bool,
    /// Recoveries scheduled since the runtime was last healthy for [`HEALTHY_RESET`].
    pub attempts: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Leave it: the reason says why.
    Ignore(&'static str),
    /// A startup run is in flight. It reports how it ended, and a failure is followed up then.
    Defer,
    /// Bring a runtime back after this long.
    RespawnAfter(Duration),
}

/// Decide what an exit means. Only an exit of the tracked child, with nothing in flight, nobody
/// having asked for the runtime to stop and the app not ending, brings a runtime back.
pub fn decide(input: Input) -> Verdict {
    if input.stale_pid {
        return Verdict::Ignore("the exit belongs to a runtime this app no longer tracks");
    }
    if input.phase != ExitPhase::Idle {
        return Verdict::Ignore("the app is starting, stopping, draining or updating its runtime");
    }
    if input.reason_set {
        return Verdict::Ignore("the app is quitting or restarting");
    }
    if !input.wanted {
        return Verdict::Ignore("the runtime was stopped from the tray, by Quit or for an update");
    }
    if input.startup_running {
        return Verdict::Defer;
    }
    Verdict::RespawnAfter(respawn_delay(input.requested_restart, input.attempts))
}

/// A requested restart right after a healthy stretch goes almost at once; everything else, and a
/// requested restart that keeps recurring, waits the capped backoff.
pub fn respawn_delay(requested_restart: bool, attempts: u32) -> Duration {
    if requested_restart && attempts == 0 {
        return REQUESTED_RESTART_DELAY;
    }
    let step = usize::try_from(attempts).unwrap_or(usize::MAX);
    BACKOFF[step.min(BACKOFF.len() - 1)]
}

/// The backoff starts over once the runtime has been healthy for [`HEALTHY_RESET`].
pub fn attempts_after(attempts: u32, healthy_for: Duration) -> u32 {
    if healthy_for >= HEALTHY_RESET {
        0
    } else {
        attempts
    }
}

/// What one watchdog question established.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    /// The endpoint identified itself with this pid.
    Identified(u32),
    /// Nothing is listening: the connection was refused.
    Unreachable,
    /// A timeout, an unauthorized or unreadable answer, or something that is not this proxy.
    /// Something may be there, so it proves nothing.
    Inconclusive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Watch {
    /// The bound runtime answered.
    Healthy,
    /// Not proven gone; the refused connections in a row so far.
    Counting(u32),
    /// Bring the runtime back now.
    Recover(&'static str),
}

/// Judge one watchdog answer against the runtime the app is bound to; `owned` says whether this
/// app started it.
pub fn classify(probe: Probe, bound_pid: u32, streak: u32, owned: bool) -> Watch {
    let limit = if owned {
        UNREACHABLE_LIMIT
    } else {
        GUEST_UNREACHABLE_LIMIT
    };
    match probe {
        Probe::Identified(pid) if pid == bound_pid => Watch::Healthy,
        Probe::Identified(_) => Watch::Recover("a different process answers the endpoint"),
        Probe::Unreachable => {
            let streak = streak.saturating_add(1);
            if streak >= limit {
                Watch::Recover("the endpoint refused every connection the watchdog made")
            } else {
                Watch::Counting(streak)
            }
        }
        Probe::Inconclusive => Watch::Counting(0),
    }
}

/// A listener this app cannot use held the port when a run looked; its pid, when the resolve named
/// one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Held {
    pub pid: Option<u32>,
}

/// How a startup run ended, as far as supervision is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunOutcome {
    Ready,
    /// Anything another attempt may change: a resolve that failed, a start that did not answer.
    Failed,
    /// The port is held by a listener this app cannot use. Another attempt finds the same one.
    Held(Held),
}

/// What follows a run that did not reach Ready.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowUp {
    /// A launch somebody is looking at: their retry decides, as it always has.
    Wait,
    /// Another attempt after the backoff, if supervision still allows one.
    Retry,
    /// Watch the endpoint for a change instead of retrying ([`Parked`]).
    Park,
}

/// A failed recovery, or a failed run that swallowed an exit of this app's child, is followed up;
/// any other failed launch waits for the person. A port held by a listener this app cannot use is
/// never retried, because the retry would find the same listener again every time.
pub fn follow_up(mode: Mode, owed: bool, held: bool) -> FollowUp {
    if mode != Mode::Recover && !owed {
        FollowUp::Wait
    } else if held {
        FollowUp::Park
    } else {
        FollowUp::Retry
    }
}

/// A parked supervisor's view of the endpoint after a run found the port held by a listener this
/// app cannot use. Only a change there is worth another recovery: a different process answering,
/// or the listener that answered going silent. A listener that refused loopback from the start is
/// bound where loopback cannot see it, so its refusals are the steady state, not a change.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Parked {
    holder: Option<u32>,
    /// The holder has answered on loopback at least once.
    answered: bool,
    streak: u32,
}

impl Parked {
    pub fn new(holder: Option<u32>) -> Self {
        Self {
            holder,
            ..Self::default()
        }
    }

    /// Judge one watchdog answer. `Some(reason)` is a change worth another recovery.
    pub fn observe(&mut self, probe: Probe) -> Option<&'static str> {
        match probe {
            Probe::Identified(pid) => {
                self.streak = 0;
                if self.holder.is_some_and(|holder| holder != pid) {
                    return Some("a different process answers the endpoint");
                }
                self.holder = Some(pid);
                self.answered = true;
                None
            }
            Probe::Unreachable if self.answered => {
                self.streak = self.streak.saturating_add(1);
                // Not ours: its own manager gets the guest's grace to bring it back first.
                (self.streak >= GUEST_UNREACHABLE_LIMIT)
                    .then_some("the listener that held the port stopped answering")
            }
            Probe::Unreachable => None,
            Probe::Inconclusive => {
                self.streak = 0;
                None
            }
        }
    }
}

#[derive(Default)]
struct State {
    attempts: u32,
    /// A recovery is scheduled and has not started yet. One at a time.
    pending: bool,
    /// An exit arrived while a run was in flight; a failure of that run is followed up.
    owed: bool,
    streak: u32,
    healthy_since: Option<Instant>,
    /// The last run found the port held by a listener this app cannot use.
    parked: Option<Parked>,
}

/// The supervisor's managed state.
pub struct Supervisor {
    state: Mutex<State>,
    log: Option<PathBuf>,
}

impl Supervisor {
    fn new(log: Option<PathBuf>) -> Self {
        Self {
            state: Mutex::new(State::default()),
            log,
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn note(&self, message: &str) {
        let Some(path) = &self.log else {
            return;
        };
        if let Err(error) = append_bounded(path, &log_line(SystemTime::now(), message)) {
            crate::logging::log_once(
                "the runtime supervisor log could not be written",
                &error.to_string(),
            );
        }
    }
}

/// Register the exit hook and start the watchdog. Called once from setup; it starts no runtime.
pub fn watch_runtime(app: &AppHandle) {
    let log = app.path().app_log_dir().ok().map(|dir| dir.join(LOG_FILE));
    app.manage(Supervisor::new(log));
    if let Some(state) = app.try_state::<AppState>() {
        let handle = app.clone();
        state
            .watch
            .on_exit(move |pid, exit| on_exit(&handle, pid, exit));
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            sleep(WATCHDOG_INTERVAL).await;
            watchdog_tick(&handle).await;
        }
    });
}

/// A person asked for a runtime again: supervision resumes and the backoff starts over.
pub fn resume(app: &AppHandle) {
    if let Some(coordinator) = app.try_state::<ExitCoordinator>() {
        coordinator.resume();
    }
    if let Some(supervisor) = app.try_state::<Supervisor>() {
        let mut state = supervisor.state();
        state.attempts = 0;
        state.parked = None;
    }
}

fn input(app: &AppHandle, stale_pid: bool, requested_restart: bool, attempts: u32) -> Input {
    let supervision = app
        .try_state::<ExitCoordinator>()
        .map(|coordinator| coordinator.supervision());
    Input {
        phase: supervision.map_or(ExitPhase::Draining, |s| s.phase),
        wanted: supervision.is_some_and(|s| s.wanted),
        reason_set: supervision.map_or(true, |s| s.reason_set),
        startup_running: app
            .try_state::<Startup>()
            .is_some_and(|startup| startup.is_running()),
        stale_pid,
        requested_restart,
        attempts,
    }
}

/// The child this app started has exited.
fn on_exit(app: &AppHandle, pid: u32, exit: SidecarExit) {
    let Some(supervisor) = app.try_state::<Supervisor>() else {
        return;
    };
    let stale = app
        .try_state::<AppState>()
        .map_or(true, |state| state.child_pid() != Some(pid));
    let requested = exit.code == Some(REQUESTED_RESTART_EXIT_CODE);
    let attempts = supervisor.state().attempts;
    let verdict = decide(input(app, stale, requested, attempts));
    supervisor.note(&format!(
        "runtime pid {pid} ended ({}); {}",
        exit.describe(),
        describe(verdict, attempts)
    ));
    match verdict {
        Verdict::Ignore(_) => {}
        Verdict::Defer => supervisor.state().owed = true,
        Verdict::RespawnAfter(delay) => {
            // The child is gone: let go of its handle without signalling anything, so nothing
            // later reads it as a runtime this app still owns.
            if let Some(state) = app.try_state::<AppState>() {
                state.release();
            }
            crate::tray::set_owned(app, false);
            schedule(app, delay);
        }
    }
}

fn describe(verdict: Verdict, attempts: u32) -> String {
    match verdict {
        Verdict::Ignore(reason) => format!("left alone: {reason}"),
        Verdict::Defer => "a startup run is in flight; its outcome decides".to_owned(),
        Verdict::RespawnAfter(delay) => format!(
            "bringing a runtime back in {} ms (recovery {})",
            delay.as_millis(),
            attempts.saturating_add(1)
        ),
    }
}

/// Start one recovery after `delay`, unless one is already scheduled.
fn schedule(app: &AppHandle, delay: Duration) {
    let Some(supervisor) = app.try_state::<Supervisor>() else {
        return;
    };
    {
        let mut state = supervisor.state();
        if state.pending {
            return;
        }
        state.pending = true;
        state.attempts = state.attempts.saturating_add(1);
        state.streak = 0;
        state.healthy_since = None;
        state.parked = None;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        sleep(delay).await;
        let Some(supervisor) = app.try_state::<Supervisor>() else {
            return;
        };
        let attempts = {
            let mut state = supervisor.state();
            state.pending = false;
            state.attempts
        };
        // The world may have moved during the wait: a Stop, a Quit or an update since then wins.
        match decide(input(&app, false, false, attempts)) {
            Verdict::RespawnAfter(_) => {
                if !startup::begin_with(&app, Mode::Recover) {
                    supervisor.state().owed = true;
                }
            }
            Verdict::Defer => supervisor.state().owed = true,
            Verdict::Ignore(reason) => supervisor.note(&format!("recovery skipped: {reason}")),
        }
    });
}

/// A startup run ended. A Ready run starts the healthy clock. A failed run is followed up as
/// [`follow_up`] says: another attempt after the backoff, a parked watch when a listener this app
/// cannot use holds the port, or nothing until the person retries. `detail` is the run's own last
/// word, for the log.
pub fn run_finished(app: &AppHandle, mode: Mode, outcome: RunOutcome, detail: Option<&str>) {
    let Some(supervisor) = app.try_state::<Supervisor>() else {
        return;
    };
    let ready = outcome == RunOutcome::Ready;
    let (owed, attempts) = {
        let mut state = supervisor.state();
        let owed = std::mem::take(&mut state.owed);
        state.parked = None;
        if ready {
            state.streak = 0;
            state.healthy_since = Some(Instant::now());
        }
        (owed, state.attempts)
    };
    if ready {
        if mode == Mode::Recover {
            supervisor.note("recovery run ready");
        }
        return;
    }
    let held = match outcome {
        RunOutcome::Held(held) => Some(held),
        RunOutcome::Ready | RunOutcome::Failed => None,
    };
    let reason = detail.unwrap_or("no reason reported");
    match follow_up(mode, owed, held.is_some()) {
        FollowUp::Wait => {}
        FollowUp::Park => {
            let holder = held.and_then(|held| held.pid);
            supervisor.state().parked = Some(Parked::new(holder));
            supervisor.note(&format!(
                "startup run failed ({reason}); the port is held by a listener this app cannot use, so no attempt is scheduled until the endpoint changes"
            ));
        }
        FollowUp::Retry => {
            let verdict = decide(input(app, false, false, attempts));
            supervisor.note(&format!(
                "startup run failed ({reason}); {}",
                describe(verdict, attempts)
            ));
            if let Verdict::RespawnAfter(delay) = verdict {
                schedule(app, delay);
            }
        }
    }
}

/// The watchdog's one question: who answers the endpoint, if anything.
async fn probe(proxy: &crate::proxy::ProxyClient) -> Probe {
    match proxy.identify().await {
        Ok(identity) => Probe::Identified(identity.pid),
        Err(error) if error.is_unreachable() => Probe::Unreachable,
        Err(_) => Probe::Inconclusive,
    }
}

/// One parked watchdog step: a recovery only once the endpoint has changed.
async fn parked_tick(app: &AppHandle, supervisor: &Supervisor) {
    let Some(proxy) = app.try_state::<AppState>().and_then(|state| state.proxy()) else {
        return;
    };
    let answer = probe(&proxy).await;
    let changed = {
        let mut state = supervisor.state();
        let Some(parked) = state.parked.as_mut() else {
            return;
        };
        parked.observe(answer)
    };
    let Some(reason) = changed else {
        return;
    };
    // Re-read after the await: a Stop, a Quit or a run that began meanwhile wins.
    let allowed = app
        .try_state::<ExitCoordinator>()
        .is_some_and(|coordinator| coordinator.supervision_allowed());
    let idle = app
        .try_state::<Startup>()
        .is_some_and(|startup| !startup.is_running());
    if !allowed || !idle {
        return;
    }
    supervisor.note(&format!(
        "watchdog: {reason} on the port that was held; bringing a runtime back"
    ));
    schedule(app, Duration::ZERO);
}

/// One watchdog step. It asks only while supervision is allowed and a run is Ready or the
/// supervisor is parked, and it asks the unauthenticated health endpoint, so nothing secret is sent.
async fn watchdog_tick(app: &AppHandle) {
    let Some(supervisor) = app.try_state::<Supervisor>() else {
        return;
    };
    let allowed = app
        .try_state::<ExitCoordinator>()
        .is_some_and(|coordinator| coordinator.supervision_allowed());
    let (idle, ready) = app
        .try_state::<Startup>()
        .map_or((false, false), |startup| {
            (!startup.is_running(), startup.is_ready())
        });
    let parked = {
        let mut state = supervisor.state();
        let parked = state.parked.is_some();
        if !allowed || !idle || state.pending || !(ready || parked) {
            state.streak = 0;
            return;
        }
        parked && !ready
    };
    if parked {
        parked_tick(app, &supervisor).await;
        return;
    }
    let Some((proxy, owned)) = app
        .try_state::<AppState>()
        .and_then(|state| state.proxy().map(|proxy| (proxy, state.owns_runtime())))
    else {
        return;
    };
    let Some(binding) = proxy.binding() else {
        return;
    };
    let answer = probe(&proxy).await;
    let verdict = {
        let mut state = supervisor.state();
        let verdict = classify(answer, binding.identity.pid, state.streak, owned);
        match verdict {
            Watch::Healthy => {
                state.streak = 0;
                let since = *state.healthy_since.get_or_insert_with(Instant::now);
                state.attempts = attempts_after(state.attempts, since.elapsed());
            }
            Watch::Counting(streak) => state.streak = streak,
            Watch::Recover(_) => state.streak = 0,
        }
        verdict
    };
    let Watch::Recover(reason) = verdict else {
        return;
    };
    // Re-read after the await: a Stop, a Quit or a run that began meanwhile wins.
    if !app
        .try_state::<ExitCoordinator>()
        .is_some_and(|coordinator| coordinator.supervision_allowed())
    {
        return;
    }
    supervisor.note(&format!(
        "watchdog: {reason} (bound pid {}); bringing a runtime back",
        binding.identity.pid
    ));
    crate::tray::set_owned(app, false);
    schedule(app, Duration::ZERO);
}

/// `2026-09-26T14:33:10Z message\n`, in UTC without a date library.
pub fn log_line(at: SystemTime, message: &str) -> String {
    let seconds = at
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let days = i64::try_from(seconds / 86_400).unwrap_or(0);
    let rest = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z {message}\n",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = u32::try_from(doy - (153 * mp + 2) / 5 + 1).unwrap_or(1);
    let month = u32::try_from(if mp < 10 { mp + 3 } else { mp - 9 }).unwrap_or(1);
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Append one line, emptying the file first once it has reached [`LOG_CAP_BYTES`]. A symlink in
/// its place is refused rather than followed.
pub fn append_bounded(path: &Path, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let existing = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(std::io::Error::other("the log path is a symlink"));
        }
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error),
    };
    let mut options = OpenOptions::new();
    if existing >= LOG_CAP_BYTES {
        options.write(true).truncate(true);
    } else {
        options.append(true).create(true);
    }
    let mut file = options.open(path)?;
    if existing >= LOG_CAP_BYTES {
        file.write_all(
            log_line(
                SystemTime::now(),
                &format!("log emptied at the {} KiB cap", LOG_CAP_BYTES / 1024),
            )
            .as_bytes(),
        )?;
    }
    file.write_all(line.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::{
        append_bounded, attempts_after, classify, decide, follow_up, log_line, respawn_delay,
        FollowUp, Input, Parked, Probe, Verdict, Watch, BACKOFF, GUEST_UNREACHABLE_LIMIT,
        HEALTHY_RESET, LOG_CAP_BYTES, REQUESTED_RESTART_DELAY, REQUESTED_RESTART_EXIT_CODE,
        UNREACHABLE_LIMIT,
    };
    use crate::exit::ExitPhase;
    use crate::startup::Mode;
    use std::time::{Duration, UNIX_EPOCH};

    const PHASES: [ExitPhase; 7] = [
        ExitPhase::Idle,
        ExitPhase::Spawning,
        ExitPhase::Stopping,
        ExitPhase::Draining,
        ExitPhase::Drained,
        ExitPhase::DrainFailed,
        ExitPhase::OwnershipUnknown,
    ];

    fn open() -> Input {
        Input {
            phase: ExitPhase::Idle,
            wanted: true,
            reason_set: false,
            startup_running: false,
            stale_pid: false,
            requested_restart: false,
            attempts: 0,
        }
    }

    #[test]
    fn only_an_idle_wanted_unclaimed_settled_exit_of_the_tracked_child_brings_a_runtime_back() {
        for phase in PHASES {
            for wanted in [false, true] {
                for reason_set in [false, true] {
                    for startup_running in [false, true] {
                        for stale_pid in [false, true] {
                            let input = Input {
                                phase,
                                wanted,
                                reason_set,
                                startup_running,
                                stale_pid,
                                ..open()
                            };
                            let gates_open =
                                phase == ExitPhase::Idle && wanted && !reason_set && !stale_pid;
                            let expected = match (gates_open, startup_running) {
                                (true, false) => "respawn",
                                (true, true) => "defer",
                                (false, _) => "ignore",
                            };
                            let verdict = match decide(input) {
                                Verdict::RespawnAfter(_) => "respawn",
                                Verdict::Defer => "defer",
                                Verdict::Ignore(_) => "ignore",
                            };
                            assert_eq!(verdict, expected, "{input:?}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_requested_restart_goes_at_once_and_an_unasked_exit_backs_off() {
        assert_eq!(REQUESTED_RESTART_EXIT_CODE, 75);
        assert_eq!(respawn_delay(true, 0), REQUESTED_RESTART_DELAY);
        assert!(REQUESTED_RESTART_DELAY < Duration::from_secs(1));
        // The first unasked step leaves a replacement or a service wrapper time to bind first.
        assert_eq!(respawn_delay(false, 0), Duration::from_secs(3));
        // A requested restart that keeps recurring is not exempt from the backoff.
        assert_eq!(respawn_delay(true, 1), BACKOFF[1]);
        let mut previous = Duration::ZERO;
        for attempts in 0..20 {
            let delay = respawn_delay(false, attempts);
            assert!(delay >= previous, "the backoff never shrinks");
            assert!(delay <= Duration::from_secs(30), "the backoff is capped");
            previous = delay;
        }
        assert_eq!(respawn_delay(false, u32::MAX), Duration::from_secs(30));
        assert_eq!(
            decide(Input {
                requested_restart: true,
                ..open()
            }),
            Verdict::RespawnAfter(REQUESTED_RESTART_DELAY)
        );
    }

    #[test]
    fn the_backoff_starts_over_only_after_a_healthy_stretch() {
        assert_eq!(attempts_after(4, HEALTHY_RESET - Duration::from_secs(1)), 4);
        assert_eq!(attempts_after(4, HEALTHY_RESET), 0);
    }

    #[test]
    fn only_refused_connections_count_and_a_different_pid_recovers_at_once() {
        for (owned, limit) in [(true, UNREACHABLE_LIMIT), (false, GUEST_UNREACHABLE_LIMIT)] {
            assert_eq!(
                classify(Probe::Identified(42), 42, 2, owned),
                Watch::Healthy
            );
            assert!(matches!(
                classify(Probe::Identified(43), 42, 0, owned),
                Watch::Recover(_)
            ));
            let mut streak = 0;
            for _ in 1..limit {
                match classify(Probe::Unreachable, 42, streak, owned) {
                    Watch::Counting(next) => streak = next,
                    other => panic!("recovered too early: {other:?}"),
                }
            }
            // A timeout or an unreadable answer says something may be there: it breaks the run.
            assert_eq!(
                classify(Probe::Inconclusive, 42, streak, owned),
                Watch::Counting(0)
            );
            assert!(matches!(
                classify(Probe::Unreachable, 42, streak, owned),
                Watch::Recover(_)
            ));
        }
    }

    #[test]
    fn a_failed_recovery_on_a_held_port_parks_instead_of_scheduling_another() {
        // A recovery that found a listener this app cannot use would find it again every time,
        // and each attempt costs a resolve: it is never rescheduled.
        assert_eq!(follow_up(Mode::Recover, false, true), FollowUp::Park);
        assert_eq!(follow_up(Mode::Launch, true, true), FollowUp::Park);
        // Anything else another attempt may change keeps its backoff.
        assert_eq!(follow_up(Mode::Recover, false, false), FollowUp::Retry);
        assert_eq!(follow_up(Mode::Recover, true, false), FollowUp::Retry);
        assert_eq!(follow_up(Mode::Launch, true, false), FollowUp::Retry);
        // A launch somebody is looking at still waits for their retry.
        assert_eq!(follow_up(Mode::Launch, false, false), FollowUp::Wait);
        assert_eq!(follow_up(Mode::Launch, false, true), FollowUp::Wait);
    }

    #[test]
    fn a_parked_supervisor_recovers_only_on_a_change_at_the_endpoint() {
        // Bound off loopback: refused from the start, and forever. That is the steady state.
        let mut hidden = Parked::new(Some(42));
        for _ in 0..(GUEST_UNREACHABLE_LIMIT * 4) {
            assert_eq!(hidden.observe(Probe::Unreachable), None);
        }
        assert_eq!(hidden.observe(Probe::Inconclusive), None);
        // Something this app can use now answers on loopback.
        assert!(hidden.observe(Probe::Identified(43)).is_some());

        // A holder loopback can see: the same pid is no change, a different one is.
        let mut seen = Parked::new(Some(42));
        assert_eq!(seen.observe(Probe::Identified(42)), None);
        assert!(seen.observe(Probe::Identified(7)).is_some());

        // It going silent is a change too, after the grace its own manager gets.
        let mut silent = Parked::new(None);
        assert_eq!(silent.observe(Probe::Identified(42)), None);
        for _ in 1..GUEST_UNREACHABLE_LIMIT {
            assert_eq!(silent.observe(Probe::Unreachable), None);
        }
        // A timeout breaks the run of refusals: something may be there.
        assert_eq!(silent.observe(Probe::Inconclusive), None);
        for _ in 1..GUEST_UNREACHABLE_LIMIT {
            assert_eq!(silent.observe(Probe::Unreachable), None);
        }
        assert!(silent.observe(Probe::Unreachable).is_some());
    }

    #[test]
    fn a_log_line_is_utc_iso_and_carries_the_message() {
        assert_eq!(
            log_line(UNIX_EPOCH, "start"),
            "1970-01-01T00:00:00Z start\n"
        );
        assert_eq!(
            log_line(UNIX_EPOCH + Duration::from_secs(951_782_400), "leap"),
            "2000-02-29T00:00:00Z leap\n"
        );
        assert_eq!(
            log_line(UNIX_EPOCH + Duration::from_secs(1_700_000_000), "x"),
            "2023-11-14T22:13:20Z x\n"
        );
    }

    #[test]
    fn the_log_is_bounded_and_a_symlink_is_not_followed() {
        let dir = std::env::temp_dir().join(format!(
            "ocx-supervisor-log-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let path = dir.join("nested").join("runtime-supervisor.log");
        append_bounded(&path, "first\n").unwrap();
        append_bounded(&path, "second\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\nsecond\n");
        let cap = usize::try_from(LOG_CAP_BYTES).unwrap();
        std::fs::write(&path, vec![b'x'; cap]).unwrap();
        append_bounded(&path, "after\n").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.len() < 1024, "the full log was emptied first");
        assert!(text.contains("log emptied at the 256 KiB cap"));
        assert!(text.ends_with("after\n"));
        #[cfg(unix)]
        {
            let target = dir.join("elsewhere");
            let link = dir.join("link.log");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(append_bounded(&link, "nope\n").is_err());
            assert!(!target.exists());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
