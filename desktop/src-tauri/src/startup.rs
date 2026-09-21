//! The startup sequence, as named states inside a window the user can already see.
//!
//! Everything below used to run inside `setup()` before any window existed, and the window was
//! then created hidden. That ordering is why a failed start had no surface: the spawn event stream
//! was discarded, so the child's exit code was gone, and a run of probes that time out rather than
//! refuse takes over a minute with nothing on screen to explain it. D7 inverts it. The window is
//! created and shown first, and the sequence runs inside it as named states under one overall
//! deadline, with a retry, the child's exit code and a diagnostic the user can copy.
//!
//! Registration comes first, before the runtime is touched at all. The order looks backwards until
//! you follow the failing case: a login launch starts hidden, and if the tray were installed only
//! after a successful start then a start that failed would leave a running process with no window
//! and no icon — invisible. The app establishes its own surface, then deals with the runtime.
//!
//! A launch that came from login autostart starts hidden, and that is the only difference — except
//! where there is no usable tray to hide into, which is R1 and lives in [`shows_window`].

use crate::{
    auth::Auth,
    discovery::{self, ProxyEndpoint},
    first_run::{self, StartAtLogin},
    proxy::ProxyClient,
    sidecar::{self, SidecarWatch},
    tray_availability::{self, TrayAvailability},
    AppState,
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard, PoisonError,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::{sleep, Duration, Instant};

/// The event the bootstrap page listens on.
pub const PHASE_EVENT: &str = "startup-phase";

/// One deadline for the whole sequence.
///
/// Per-step budgets were what produced the unbounded case: a two-second attach loop whose probes
/// each cost a four-second client timeout, followed by twenty more waits, adds up to something no
/// single number in the code admitted to. One ceiling over the whole run is a promise that can be
/// read — and every probe under it is bounded by the remaining time rather than by its own
/// timeout, because otherwise the last probe overruns the ceiling by the whole client timeout.
pub const DEADLINE: Duration = Duration::from_secs(30);

/// How long an already-running runtime gets to answer before this app starts its own.
///
/// The core liveness path carries a comment explaining why this number is not smaller: a single
/// unanswered 750ms probe was once enough to start a duplicate proxy on Windows.
const ATTACH_BUDGET: Duration = Duration::from_secs(2);

const POLL: Duration = Duration::from_millis(250);

/// Where the launch came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchOrigin {
    /// A person opened the app.
    User,
    /// The login item started it.
    Autostart,
}

/// The argument the autostart registration passes back to us. Nothing else supplies it, so its
/// presence is the launch origin.
pub const AUTOSTART_FLAG: &str = "--autostart";

impl LaunchOrigin {
    pub fn from_args(mut args: impl Iterator<Item = String>) -> Self {
        if args.any(|argument| argument == AUTOSTART_FLAG) {
            Self::Autostart
        } else {
            Self::User
        }
    }

    pub fn detect() -> Self {
        Self::from_args(std::env::args())
    }
}

/// Whether this launch shows its window.
///
/// D7 shows it always and exempts a login launch, which starts hidden. D6 shows it wherever there
/// is no usable tray. A no-tray login launch satisfies both rules and they disagree, so R1 settles
/// it: tray availability wins. Starting hidden is a property of having somewhere to be hidden in,
/// not of how the process was started.
pub fn shows_window(origin: LaunchOrigin, tray: TrayAvailability) -> bool {
    !tray.is_available() || origin == LaunchOrigin::User
}

/// A named state of the startup sequence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Registering,
    Resolving,
    Probing,
    Attaching,
    Starting,
    Waiting,
    Ready,
    Failed,
}

/// Every phase, in the order they run. The bootstrap page derives its checklist from this rather
/// than restating it, so a phase cannot exist in one place and be missing from the other.
pub const PHASES: [Phase; 8] = [
    Phase::Registering,
    Phase::Resolving,
    Phase::Probing,
    Phase::Attaching,
    Phase::Starting,
    Phase::Waiting,
    Phase::Ready,
    Phase::Failed,
];

impl Phase {
    /// The stable identifier the bootstrap page keys on.
    pub fn id(self) -> &'static str {
        match self {
            Self::Registering => "registering",
            Self::Resolving => "resolving",
            Self::Probing => "probing",
            Self::Attaching => "attaching",
            Self::Starting => "starting",
            Self::Waiting => "waiting",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Registering => "Registering the tray and the login item",
            Self::Resolving => "Resolving the configuration home and port",
            Self::Probing => "Looking for a runtime that is already listening",
            Self::Attaching => "Attaching to the runtime that answered",
            Self::Starting => "Starting the bundled runtime",
            Self::Waiting => "Waiting for the runtime to report healthy",
            Self::Ready => "Ready",
            Self::Failed => "OpenCodex could not start its runtime",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Ready | Self::Failed)
    }
}

/// One phase, as the bootstrap page sees it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub terminal: bool,
}

/// The phase list the page renders. Derived from [`PHASES`] so the two cannot drift.
pub fn phase_list() -> Vec<PhaseInfo> {
    PHASES
        .iter()
        .map(|phase| PhaseInfo {
            id: phase.id(),
            label: phase.label(),
            terminal: phase.is_terminal(),
        })
        .collect()
}

/// What the bootstrap page is told.
///
/// It carries the phases already finished, not just the current one. An event emitted before the
/// page's listener exists is gone, and the early phases finish in milliseconds, so a page that
/// reconstructed history from events alone would show a run in progress with nothing behind it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: &'static str,
    pub label: &'static str,
    pub detail: Option<String>,
    pub completed: Vec<&'static str>,
    pub failed_phase: Option<&'static str>,
    pub elapsed_ms: u64,
    pub dashboard: Option<String>,
    pub diagnostic: Option<String>,
    pub can_retry: bool,
}

impl Progress {
    fn new(phase: Phase, elapsed_ms: u64) -> Self {
        Self {
            phase: phase.id(),
            label: phase.label(),
            detail: None,
            completed: Vec::new(),
            failed_phase: None,
            elapsed_ms,
            dashboard: None,
            diagnostic: None,
            can_retry: phase == Phase::Failed,
        }
    }
}

/// What the sequence resolved, once it has.
#[derive(Clone)]
struct Resolved {
    endpoint: ProxyEndpoint,
    home: PathBuf,
}

struct Live {
    latest: Progress,
    reported: Vec<&'static str>,
}

/// The sequence's managed state: the latest thing it said, what it has already finished, and
/// whether it is running, so a retry cannot start a second run alongside the first.
pub struct Startup {
    live: Mutex<Live>,
    running: AtomicBool,
    /// The outcome of the one-time registration, once it has happened.
    registered: Mutex<Option<StartAtLogin>>,
}

impl Startup {
    pub fn new() -> Self {
        Self {
            live: Mutex::new(Live {
                latest: Progress::new(Phase::Registering, 0),
                reported: Vec::new(),
            }),
            running: AtomicBool::new(false),
            registered: Mutex::new(None),
        }
    }

    fn live(&self) -> MutexGuard<'_, Live> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn registration(&self) -> Option<StartAtLogin> {
        *self
            .registered
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn remember_registration(&self, login: StartAtLogin) {
        *self
            .registered
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(login);
    }

    /// The whole state of the run so far, which is what the page asks for when it loads.
    pub fn latest(&self) -> Progress {
        self.live().latest.clone()
    }

    fn restart(&self) {
        let mut live = self.live();
        live.reported.clear();
        live.latest = Progress::new(Phase::Registering, 0);
    }

    fn publish(&self, progress: &mut Progress, failed_in: Option<Phase>) {
        let mut live = self.live();
        if !live.reported.contains(&progress.phase)
            && progress.phase != Phase::Ready.id()
            && progress.phase != Phase::Failed.id()
        {
            live.reported.push(progress.phase);
        }
        progress.completed = live
            .reported
            .iter()
            .copied()
            .filter(|id| *id != progress.phase)
            .collect();
        progress.failed_phase = failed_in.map(Phase::id);
        live.latest = progress.clone();
    }
}

impl Default for Startup {
    fn default() -> Self {
        Self::new()
    }
}

/// Run the sequence, unless it is already running. This is also the retry.
pub fn begin(app: &AppHandle) {
    let Some(startup) = app.try_state::<Startup>() else {
        return;
    };
    if startup
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    startup.restart();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run(&app).await;
        if let Some(startup) = app.try_state::<Startup>() {
            startup.running.store(false, Ordering::Release);
        }
    });
}

async fn run(app: &AppHandle) {
    let started = Instant::now();
    let deadline = started + DEADLINE;
    let Some(watch) = app.try_state::<AppState>().map(|state| state.watch.clone()) else {
        return;
    };
    report(app, started, Phase::Registering, None);
    let login = register(app, deadline).await;
    report(
        app,
        started,
        Phase::Registering,
        Some(login.describe().to_owned()),
    );

    report(app, started, Phase::Resolving, None);
    // D5 hands this resolution to the bundled CLI, so a user on a custom config.port is not started
    // on a different one. This is the call site that changes when lane A's resolve verb lands; it
    // is already inside the sequence so the failure has a state, a diagnostic and a retry.
    let (endpoint, home) = discovery::current();
    let resolved = Resolved {
        endpoint,
        home: home.clone(),
    };
    let proxy = match ProxyClient::new(endpoint, Auth::new(home)) {
        Ok(proxy) => proxy,
        Err(error) => {
            fail(
                app,
                started,
                Some(&resolved),
                login,
                &watch,
                Phase::Resolving,
                error.to_string(),
            );
            return;
        }
    };
    if let Some(state) = app.try_state::<AppState>() {
        state.attach(proxy.clone());
    }
    report(
        app,
        started,
        Phase::Resolving,
        Some(format!(
            "{} with a configuration home of {}",
            resolved.endpoint.url(""),
            resolved.home.display()
        )),
    );

    report(app, started, Phase::Probing, None);
    if healthy_by(&proxy, (started + ATTACH_BUDGET).min(deadline)).await {
        report(
            app,
            started,
            Phase::Attaching,
            Some("a runtime was already listening, so this app is a guest on it".to_owned()),
        );
        finish(app, started, endpoint);
        return;
    }

    // A retry must not leave a second proxy behind. A child that has not reported an exit is still
    // out there, whatever the last run concluded, so the retry waits on that one rather than
    // starting another and racing it for the port.
    let owns_live_child = app
        .try_state::<AppState>()
        .is_some_and(|state| state.owns_runtime())
        && watch.exit().is_none();
    if owns_live_child {
        report(
            app,
            started,
            Phase::Starting,
            Some("the runtime this app started has not exited; waiting on it again".to_owned()),
        );
    } else {
        report(app, started, Phase::Starting, None);
        watch.reset();
        match spawn_runtime(app, endpoint, &watch) {
            Some(Ok(())) => {}
            Some(Err(error)) => {
                fail(
                    app,
                    started,
                    Some(&resolved),
                    login,
                    &watch,
                    Phase::Starting,
                    error,
                );
                return;
            }
            // An exit is already in flight, so starting a runtime now would orphan it.
            None => return,
        }
    }

    report(app, started, Phase::Waiting, None);
    while Instant::now() < deadline {
        if matches!(proxy.alive_within(deadline).await, Some(Ok(_))) {
            finish(app, started, endpoint);
            return;
        }
        // A child that has already exited will never answer, so the deadline is not worth waiting
        // out. This is the case the discarded event stream used to hide behind a generic timeout.
        if let Some(exit) = watch.exit() {
            fail(
                app,
                started,
                Some(&resolved),
                login,
                &watch,
                Phase::Waiting,
                format!("the runtime {}", exit.describe()),
            );
            return;
        }
        sleep(POLL).await;
    }
    fail(
        app,
        started,
        Some(&resolved),
        login,
        &watch,
        Phase::Waiting,
        format!(
            "the runtime did not report healthy within {} seconds",
            DEADLINE.as_secs()
        ),
    );
}

/// Establish the app's own surface: the tray verdict, the tray, and the login item.
///
/// It happens once per process. A retry re-runs the runtime half of the sequence, and running this
/// half again would build a second tray icon with its own refresh loop and its own menu handlers —
/// the failure would look like the app duplicating itself every time the user pressed Retry.
async fn register(app: &AppHandle, deadline: Instant) -> StartAtLogin {
    if let Some(done) = app
        .try_state::<Startup>()
        .and_then(|startup| startup.registration())
    {
        return done;
    }

    // The probe blocks on a session-bus round trip, so it does not belong on an async worker — and
    // it is bounded by the sequence's own deadline, because a bus that never answers would
    // otherwise leave the page in this state with a retry that could do nothing about it.
    let tray = match tokio::time::timeout_at(
        deadline,
        tauri::async_runtime::spawn_blocking(tray_availability::detect),
    )
    .await
    {
        Ok(Ok(tray)) => tray,
        _ => TrayAvailability::assumed(),
    };

    // Before the tray, so its Start at Login checkbox reads the state this leaves behind rather
    // than the state from before first run.
    let login = first_run::apply_start_at_login_default(app);
    first_run::adopt_launch_origin_argument(app);

    // The verdict is published only once an icon actually exists. Announcing a tray and then
    // failing to install it would hide the window into nothing, which is the exact stranding D6
    // exists to prevent.
    let verdict = if tray.is_available() && install_tray(app, deadline).await {
        TrayAvailability::Available
    } else {
        TrayAvailability::Unavailable
    };
    if let Some(coordinator) = app.try_state::<crate::exit::ExitCoordinator>() {
        coordinator.set_tray(verdict);
    }

    if let Some(window) = app.get_webview_window("main") {
        if shows_window(LaunchOrigin::detect(), verdict) {
            crate::window::show(&window);
        }
    }
    if let Some(startup) = app.try_state::<Startup>() {
        startup.remember_registration(login);
    }
    login
}

/// Build the tray on the main thread, which is where GTK requires it on Linux.
async fn install_tray(app: &AppHandle, deadline: Instant) -> bool {
    let handle = app.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    if app
        .run_on_main_thread(move || {
            let _ = sender.send(crate::tray::install(&handle).map_err(|error| error.to_string()));
        })
        .is_err()
    {
        return false;
    }
    match tokio::time::timeout_at(deadline, receiver).await {
        Ok(Ok(Ok(()))) => true,
        Ok(Ok(Err(error))) => {
            crate::logging::log_once("the tray could not be installed", &error);
            false
        }
        _ => {
            crate::logging::log_once(
                "the tray could not be installed",
                "the main thread did not answer",
            );
            false
        }
    }
}
/// Start the runtime, unless an exit is already in flight.
///
/// The coordinator reserves the spawn rather than holding its lock across it: holding it would put
/// process creation in front of the main thread's exit handler, so a wedged spawn would be a Quit
/// that never answers. A quit arriving in between is deferred until the child is ours and then
/// drains it, so it cannot observe "we own nothing" and leave a proxy running that nothing stops.
fn spawn_runtime(
    app: &AppHandle,
    endpoint: ProxyEndpoint,
    watch: &SidecarWatch,
) -> Option<Result<(), String>> {
    let coordinator = app.try_state::<crate::exit::ExitCoordinator>()?;
    if !coordinator.begin_spawn() {
        return None;
    }
    let outcome = match sidecar::start(app, endpoint, watch) {
        Ok(child) => {
            if let Some(state) = app.try_state::<AppState>() {
                state.adopt(child);
            }
            Ok(())
        }
        Err(error) => Err(error),
    };
    if let Some(reason) = coordinator.finish_spawn() {
        // A quit landed while the child was being created. It is ours now, so it gets drained.
        crate::exit::drain_now(app, reason);
        return None;
    }
    Some(outcome)
}

async fn healthy_by(proxy: &ProxyClient, deadline: Instant) -> bool {
    loop {
        if matches!(proxy.alive_within(deadline).await, Some(Ok(_))) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        sleep(POLL).await;
    }
}

fn finish(app: &AppHandle, started: Instant, endpoint: ProxyEndpoint) {
    crate::tray::set_owned(
        app,
        app.try_state::<AppState>()
            .is_some_and(|state| state.owns_runtime()),
    );
    let dashboard = endpoint.url("/#/usage");
    let mut progress = Progress::new(Phase::Ready, elapsed(started));
    progress.dashboard = Some(dashboard.clone());
    emit(app, progress, None);
    if let Some(window) = app.get_webview_window("main") {
        // justified: replacing the bootstrap page with the dashboard is how this window has always
        // navigated, and the string is a URL this process resolved, not anything a page supplied.
        let _ = window.eval(format!("window.location.replace({dashboard:?})"));
    }
}

#[allow(clippy::too_many_arguments)]
fn fail(
    app: &AppHandle,
    started: Instant,
    resolved: Option<&Resolved>,
    login: StartAtLogin,
    watch: &SidecarWatch,
    phase: Phase,
    reason: String,
) {
    let elapsed_ms = elapsed(started);
    let mut progress = Progress::new(Phase::Failed, elapsed_ms);
    progress.diagnostic = Some(diagnostic(
        resolved.map(|resolved| (resolved.endpoint, resolved.home.clone())),
        login,
        watch,
        phase,
        &reason,
        elapsed_ms,
    ));
    progress.detail = Some(reason);
    emit(app, progress, Some(phase));
}

/// The text the failure surface offers for copying.
///
/// It names the state it stopped in, the endpoint and home it was using, how the child ended and
/// what the child last said. Those together are what separates "the port was taken" from "the
/// binary will not run on this CPU" from "the home is not the one the accounts are in", and none of
/// them were reachable from the generic health failure this replaces.
pub fn diagnostic(
    resolved: Option<(ProxyEndpoint, PathBuf)>,
    login: StartAtLogin,
    watch: &SidecarWatch,
    phase: Phase,
    reason: &str,
    elapsed_ms: u64,
) -> String {
    let mut lines = vec![
        format!(
            "OpenCodex desktop {} on {}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS
        ),
        format!("state: {}", phase.id()),
        format!("reason: {reason}"),
        format!("elapsed: {elapsed_ms}ms"),
    ];
    match resolved {
        Some((endpoint, home)) => {
            lines.push(format!("endpoint: {}", endpoint.url("")));
            lines.push(format!("home: {}", home.display()));
        }
        None => lines.push("endpoint: not resolved".to_owned()),
    }
    lines.push(format!("start at login: {}", login.describe()));
    lines.push(match watch.exit() {
        Some(exit) => format!("runtime process: {}", exit.describe()),
        None => "runtime process: still running or never started".to_owned(),
    });
    let output = watch.lines();
    if output.is_empty() {
        lines.push("runtime output: none".to_owned());
    } else {
        lines.push("runtime output:".to_owned());
        lines.extend(output.into_iter().map(|line| format!("  {line}")));
    }
    lines.join("\n")
}

fn report(app: &AppHandle, started: Instant, phase: Phase, detail: Option<String>) {
    let mut progress = Progress::new(phase, elapsed(started));
    progress.detail = detail;
    emit(app, progress, None);
}

fn emit(app: &AppHandle, mut progress: Progress, failed_in: Option<Phase>) {
    if let Some(startup) = app.try_state::<Startup>() {
        startup.publish(&mut progress, failed_in);
    }
    let _ = app.emit(PHASE_EVENT, progress);
}

fn elapsed(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::{
        shows_window, LaunchOrigin, Phase, ATTACH_BUDGET, AUTOSTART_FLAG, DEADLINE, PHASES,
    };
    use crate::tray_availability::TrayAvailability;
    use tokio::time::Duration;

    #[test]
    fn only_the_autostart_argument_marks_a_login_launch() {
        let user = ["/Applications/OpenCodex.app".to_owned()];
        assert_eq!(
            LaunchOrigin::from_args(user.into_iter()),
            LaunchOrigin::User
        );
        let login = [
            "/Applications/OpenCodex.app".to_owned(),
            AUTOSTART_FLAG.to_owned(),
        ];
        assert_eq!(
            LaunchOrigin::from_args(login.into_iter()),
            LaunchOrigin::Autostart
        );
    }

    #[test]
    fn a_manual_launch_always_shows_the_window() {
        assert!(shows_window(
            LaunchOrigin::User,
            TrayAvailability::Available
        ));
        assert!(shows_window(
            LaunchOrigin::User,
            TrayAvailability::Unavailable
        ));
    }

    #[test]
    fn a_login_launch_hides_only_where_there_is_a_tray_to_hide_in() {
        assert!(!shows_window(
            LaunchOrigin::Autostart,
            TrayAvailability::Available
        ));
        assert!(shows_window(
            LaunchOrigin::Autostart,
            TrayAvailability::Unavailable
        ));
    }

    #[test]
    fn registration_runs_before_the_runtime_is_touched() {
        let order: Vec<&str> = PHASES.iter().map(|phase| phase.id()).collect();
        let registering = order.iter().position(|id| *id == "registering").unwrap();
        for later in ["resolving", "probing", "starting", "waiting"] {
            assert!(registering < order.iter().position(|id| *id == later).unwrap());
        }
    }

    #[test]
    fn every_phase_has_a_distinct_identifier_and_a_label() {
        let mut ids: Vec<&str> = PHASES.iter().map(|phase| phase.id()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), PHASES.len());
        assert!(PHASES.iter().all(|phase| !phase.label().is_empty()));
        assert_eq!(PHASES.iter().filter(|phase| phase.is_terminal()).count(), 2);
        assert!(PHASES.contains(&Phase::Ready));
    }

    #[test]
    fn the_whole_sequence_is_bounded_well_under_the_minute_it_used_to_take() {
        let budgets = [DEADLINE, ATTACH_BUDGET];
        assert!(budgets
            .iter()
            .all(|budget| *budget <= Duration::from_secs(45)));
        assert!(ATTACH_BUDGET < DEADLINE);
    }
}
