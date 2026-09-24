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
    claim,
    endpoint::ProxyEndpoint,
    first_run::{self, StartAtLogin},
    identity, ownership,
    proxy::{ProxyClient, RuntimeIdentity},
    resolve, runtime_stop,
    sidecar::{self, SidecarWatch},
    tray_availability::{self, TrayAvailability},
    AppState,
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, MutexGuard, PoisonError,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use tokio::time::{sleep, sleep_until, Duration, Instant};

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

const POLL: Duration = Duration::from_millis(250);

/// How long the deadline guard waits past the ceiling before speaking for a run that has not.
///
/// The run's own failure names the endpoint, the home and how the child ended; the guard's can
/// only name where it stalled. The grace lets the run lose its own race first, so the better
/// diagnostic is the one on screen.
const SETTLE_GRACE: Duration = Duration::from_secs(2);

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
    /// Nothing has run yet.
    ///
    /// This is what the sequence's state says before its first report, and it is deliberately not
    /// one of the [`PHASES`]: it is the absence of a run, not a step of one. Seeding the state
    /// with `Registering` instead made "the sequence has not started" render exactly like "the
    /// sequence is registering", so a shell that never began was indistinguishable from one that
    /// had — on the one surface whose job is to tell those apart.
    NotStarted,
    Registering,
    Resolving,
    Probing,
    Attaching,
    TakingOver,
    Starting,
    Waiting,
    Ready,
    Failed,
}

/// Every phase, in the order they run. The bootstrap page derives its checklist from this rather
/// than restating it, so a phase cannot exist in one place and be missing from the other.
///
/// [`Phase::NotStarted`] is absent on purpose. It is the state of not having run, so a checklist
/// row for it would be a step that never completes.
pub const PHASES: [Phase; 9] = [
    Phase::Registering,
    Phase::Resolving,
    Phase::Probing,
    Phase::Attaching,
    Phase::TakingOver,
    Phase::Starting,
    Phase::Waiting,
    Phase::Ready,
    Phase::Failed,
];

impl Phase {
    /// The stable identifier the bootstrap page keys on.
    pub fn id(self) -> &'static str {
        match self {
            Self::NotStarted => "not-started",
            Self::Registering => "registering",
            Self::Resolving => "resolving",
            Self::Probing => "probing",
            Self::Attaching => "attaching",
            Self::TakingOver => "taking-over",
            Self::Starting => "starting",
            Self::Waiting => "waiting",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::NotStarted => "Waiting for the startup sequence to begin",
            Self::Registering => "Registering the tray and the login item",
            Self::Resolving => "Resolving the configuration home and port",
            Self::Probing => "Looking for a runtime that is already listening",
            Self::Attaching => "Attaching to the runtime that answered",
            Self::TakingOver => "Taking over the runtime that was already listening",
            Self::Starting => "Starting the bundled runtime",
            Self::Waiting => "Waiting for the runtime to report healthy",
            Self::Ready => "Ready",
            Self::Failed => "OpenCodex could not start its runtime",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Ready | Self::Failed)
    }

    /// The phase a published id came from, for a caller that only has the wire value.
    ///
    /// Derived from [`PHASES`] rather than restating the mapping, so a phase cannot be resolvable
    /// here and missing from the checklist.
    pub fn from_id(id: &str) -> Option<Self> {
        PHASES.into_iter().find(|phase| phase.id() == id)
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
    /// Present only while the shell is waiting on the user's takeover decision.
    pub consent: Option<ConsentPrompt>,
}

/// What the consent panel renders. `blocked` carries the CLI's refusal reason when a
/// takeover cannot be offered; the panel is shown only for the offerable case today, but
/// the field is part of the wire so a later UI does not need a schema change.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentPrompt {
    pub endpoint: String,
    pub port: u16,
    pub home: String,
    pub owner: String,
    pub blocked: Option<String>,
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
            consent: None,
        }
    }
}

/// What the page is told when the sequence's own state is not registered.
///
/// The command used to answer `None` here, and the page dropped it: `apply` returns early on a
/// falsy progress, so the surface kept its initial markup, no event ever arrived, and nothing on
/// screen distinguished that from a run still in progress. A shell that cannot find its own
/// startup state is a defect, and a defect the user can read and copy beats a window that looks
/// like it is still working.
pub fn unavailable() -> Progress {
    let reason =
        "the shell's startup state is not registered, so it cannot report on its own startup";
    let mut progress = Progress::new(Phase::Failed, 0);
    progress.diagnostic = Some(format!(
        "OpenCodex desktop {} on {}\nstate: {}\nreason: {reason}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        Phase::NotStarted.id(),
    ));
    progress.detail = Some(reason.to_owned());
    progress
}

/// Where the sequence is pointed, once the CLI has said.
#[derive(Clone)]
struct Target {
    endpoint: ProxyEndpoint,
    home: PathBuf,
}

/// What registering established about this installation.
#[derive(Clone, Debug)]
pub struct Registration {
    pub login: StartAtLogin,
    /// This installation's own id, minted once in the app's config directory.
    pub install_id: Option<String>,
}

struct Live {
    latest: Progress,
    reported: Vec<&'static str>,
    /// The takeover decision state. Answered stays set until the run clears it: the deadline
    /// extension lands between the decision and the clear, and the guard must keep waiting
    /// through both.
    consent: ConsentState,
    /// The current run's ceiling.
    ///
    /// The consent wait moves it by however long the person took, so the deadline guard
    /// re-reads it instead of racing a stale copy. It lives under this lock so the expiry
    /// decision and the terminal publish are one critical section against consent transitions.
    deadline: Instant,
}

impl Live {
    fn is_settled(&self) -> bool {
        self.latest.phase == Phase::Ready.id() || self.latest.phase == Phase::Failed.id()
    }

    /// Record the latest state. A run that already said how it ended refuses further
    /// reports: the terminal state is the page's promise that the screen stopped changing,
    /// and a probe resuming after the expiry landed must not move it back — nor reopen the
    /// consent gate that reads this state. Returns whether the report was taken.
    fn publish(&mut self, progress: &mut Progress, failed_in: Option<Phase>) -> bool {
        if self.is_settled() {
            return false;
        }
        if !self.reported.contains(&progress.phase)
            && progress.phase != Phase::Ready.id()
            && progress.phase != Phase::Failed.id()
        {
            self.reported.push(progress.phase);
        }
        progress.completed = self
            .reported
            .iter()
            .copied()
            .filter(|id| *id != progress.phase)
            .collect();
        progress.failed_phase = failed_in.map(Phase::id);
        self.latest = progress.clone();
        true
    }
}

/// The takeover prompt's decision state.
enum ConsentState {
    /// No prompt is up and none was just answered.
    Idle,
    /// A prompt is up; the sender resolves with the user's decision.
    Pending(oneshot::Sender<bool>),
    /// The user answered and the run has not yet consumed the extension.
    Answered,
}

/// What the deadline guard's expiry step found.
enum Expiry {
    /// The run is terminal or superseded; the guard is done.
    Dead,
    /// A consent prompt is pending or its answer is being consumed; re-check shortly.
    Blocked,
    /// Not expired yet; the current ceiling plus its grace.
    Waiting(Instant),
    /// Expired and the failure was published in the same critical section; emit it.
    Fired(Box<Progress>),
}

/// The sequence's managed state: the latest thing it said, what it has already finished, and
/// whether it is running, so a retry cannot start a second run alongside the first.
pub struct Startup {
    live: Mutex<Live>,
    /// Serialize state publication with its synchronous event dispatch. Always acquired
    /// before `live`, and never held across an await.
    reporting: Mutex<()>,
    running: AtomicBool,
    /// Whether this window has already left the bundled bootstrap surface.
    ///
    /// Explicit open actions can arrive repeatedly from the tray, the single-instance hook, and
    /// the shell command. Navigating on every action would recreate the React application and
    /// discard renderer state, so the transition is owned here and consumed exactly once per run.
    dashboard_loaded: AtomicBool,
    /// Whether a person asked for the dashboard during this run.
    ///
    /// An explicit open that arrives while startup is still running only shows the bootstrap page;
    /// `finish` reads this after it has recorded Ready, and `open_dashboard` sets it before it
    /// reads progress, so whichever of the two runs second sees the other and navigates.
    dashboard_requested: AtomicBool,
    /// Which run the state belongs to.
    ///
    /// A run's deadline guard outlives the run it was started for, and a retry that begins before
    /// the old guard fires would otherwise be failed by it.
    generation: AtomicU64,
    /// The outcome of the one-time registration, once it has happened.
    registered: Mutex<Option<Registration>>,
}

impl Startup {
    pub fn new() -> Self {
        Self {
            live: Mutex::new(Live {
                latest: Progress::new(Phase::NotStarted, 0),
                reported: Vec::new(),
                consent: ConsentState::Idle,
                deadline: Instant::now(),
            }),
            reporting: Mutex::new(()),
            running: AtomicBool::new(false),
            dashboard_loaded: AtomicBool::new(false),
            dashboard_requested: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            registered: Mutex::new(None),
        }
    }

    fn live(&self) -> MutexGuard<'_, Live> {
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn registration(&self) -> Option<Registration> {
        self.registered
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn remember_registration(&self, registration: Registration) {
        *self
            .registered
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(registration);
    }

    /// The whole state of the run so far, which is what the page asks for when it loads.
    pub fn latest(&self) -> Progress {
        self.live().latest.clone()
    }

    /// The user's answer to a pending takeover prompt. Nothing pending is a no-op: a retry
    /// or a late click must never be read as a decision for a prompt that is not up.
    pub fn decide_takeover(&self, approved: bool) {
        let mut live = self.live();
        match std::mem::replace(&mut live.consent, ConsentState::Idle) {
            ConsentState::Pending(sender) => {
                live.consent = ConsentState::Answered;
                let _ = sender.send(approved);
            }
            // A late click or a duplicate decision answers nothing: restore what was there.
            prior => live.consent = prior,
        }
    }

    /// Register the pending prompt, unless the run already ended. A guard expiry can win the
    /// race against the prompt being posted; posting one anyway would leave a receiver that
    /// waits forever on a decision nobody can see.
    fn await_consent(&self) -> Option<oneshot::Receiver<bool>> {
        let mut live = self.live();
        if live.is_settled() {
            return None;
        }
        let (sender, receiver) = oneshot::channel();
        live.consent = ConsentState::Pending(sender);
        Some(receiver)
    }

    /// Consume the decision and publish the extended ceiling in the same critical section, so
    /// the guard's next expiry check sees either a pending/answered prompt or the new deadline,
    /// never the gap between them.
    fn resolve_consent(&self, deadline: Instant) {
        let mut live = self.live();
        live.deadline = deadline;
        live.consent = ConsentState::Idle;
    }

    fn set_deadline(&self, deadline: Instant) {
        self.live().deadline = deadline;
    }

    fn restart(&self) {
        // A retry during a pending consent prompt drops the sender, so the waiting run reads
        // the decision as declined rather than pairing an old prompt with a new sequence.
        let mut live = self.live();
        live.consent = ConsentState::Idle;
        live.reported.clear();
        live.latest = Progress::new(Phase::NotStarted, 0);
        self.dashboard_loaded.store(false, Ordering::SeqCst);
        self.dashboard_requested.store(false, Ordering::SeqCst);
    }

    fn should_navigate_dashboard(&self) -> bool {
        !self.dashboard_loaded.swap(true, Ordering::SeqCst)
    }

    /// Give the one navigation back when the WebView refused the script, so the next open retries.
    fn navigation_failed(&self) {
        self.dashboard_loaded.store(false, Ordering::SeqCst);
    }

    fn request_dashboard(&self) {
        self.dashboard_requested.store(true, Ordering::SeqCst);
    }

    fn dashboard_requested(&self) -> bool {
        self.dashboard_requested.load(Ordering::SeqCst)
    }

    /// The dashboard URL once this run is Ready, otherwise nothing.
    fn ready_dashboard(&self) -> Option<String> {
        let progress = self.latest();
        (progress.phase == Phase::Ready.id())
            .then_some(progress.dashboard)
            .flatten()
    }

    /// Whether the run has already said how it ended.
    ///
    /// A terminal state is the page's only promise that the screen has stopped changing, so it is
    /// also what tells a late guard there is nothing left to report.
    #[cfg(test)]
    fn settled(&self) -> bool {
        self.live().is_settled()
    }

    fn publish(&self, progress: &mut Progress, failed_in: Option<Phase>) -> bool {
        let mut live = self.live();
        live.publish(progress, failed_in)
    }

    fn with_reporting<T>(&self, report: impl FnOnce() -> T) -> T {
        let _reporting = self
            .reporting
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        report()
    }

    /// Publish a terminal state for a run that did not report one itself.
    ///
    /// Idempotent and bound to the run it was started for: a run that already said Ready or
    /// Failed is left alone, and a caller whose run has been superseded by a retry says
    /// nothing. The check and the publish are one critical section, so no other reporter can
    /// slip a state between them.
    fn settle(&self, started: Instant, generation: u64, reason: String) -> Option<Progress> {
        let mut live = self.live();
        self.settle_locked(&mut live, started, generation, reason)
    }

    fn settle_locked(
        &self,
        live: &mut Live,
        started: Instant,
        generation: u64,
        reason: String,
    ) -> Option<Progress> {
        if self.generation.load(Ordering::Acquire) != generation || live.is_settled() {
            return None;
        }
        let stalled_in = live.latest.phase;
        let elapsed_ms = elapsed(started);
        let mut progress = Progress::new(Phase::Failed, elapsed_ms);
        progress.diagnostic = Some(
            [
                format!(
                    "OpenCodex desktop {} on {}",
                    env!("CARGO_PKG_VERSION"),
                    std::env::consts::OS
                ),
                format!("state: {stalled_in}"),
                format!("reason: {reason}"),
                format!("elapsed: {elapsed_ms}ms"),
            ]
            .join("\n"),
        );
        progress.detail = Some(reason);
        live.publish(&mut progress, Phase::from_id(stalled_in));
        Some(progress)
    }

    /// The deadline guard's atomic expiry step. The deadline read, the consent state, the
    /// terminal check and the failure publish all share one critical section, so a prompt
    /// posted or an answer consumed on the other side of the lock can never meet a failure
    /// already in flight.
    fn expire_run(&self, started: Instant, generation: u64, reason: String) -> Expiry {
        let mut live = self.live();
        if self.generation.load(Ordering::Acquire) != generation || live.is_settled() {
            return Expiry::Dead;
        }
        if !matches!(live.consent, ConsentState::Idle) {
            // A prompt is up or an answer is being consumed. The budget does not run
            // against the person, so there is nothing to expire.
            return Expiry::Blocked;
        }
        let wake = live.deadline + SETTLE_GRACE;
        if wake > Instant::now() {
            return Expiry::Waiting(wake);
        }
        match self.settle_locked(&mut live, started, generation, reason) {
            Some(progress) => Expiry::Fired(Box::new(progress)),
            None => Expiry::Dead,
        }
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
    let generation = startup.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let started = Instant::now();
    startup.set_deadline(started + DEADLINE);
    let app = app.clone();

    // The ceiling is a promise to the page, and something has to keep it when the run does not.
    // Every `return` below that reports nothing, and every step that outlives the ceiling, used to
    // leave the surface on whatever it was last told — or on its own initial markup when nothing
    // had been published at all — for as long as the process lived. That screen is the one a user
    // cannot tell from a hung application, which is the whole thing this surface exists to avoid.
    let guard = app.clone();
    tauri::async_runtime::spawn(async move {
        // The consent wait extends the shared deadline, and while a prompt is up the budget
        // does not run at all. The expiry check, the consent state and the terminal publish
        // share one critical section, so a prompt posted or an answer consumed can never meet
        // a failure already in flight.
        loop {
            let Some(startup) = guard.try_state::<Startup>() else {
                return;
            };
            let expiry = startup.with_reporting(|| {
                let expiry = startup.expire_run(
                    started,
                    generation,
                    format!(
                        "the startup sequence did not finish within {} seconds",
                        DEADLINE.as_secs()
                    ),
                );
                if let Expiry::Fired(progress) = &expiry {
                    let _ = guard.emit(PHASE_EVENT, progress);
                }
                expiry
            });
            match expiry {
                Expiry::Dead => return,
                Expiry::Blocked => {
                    sleep(POLL).await;
                    continue;
                }
                Expiry::Waiting(wake) => {
                    sleep_until(wake).await;
                    continue;
                }
                Expiry::Fired(_) => return,
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        run(&app, started).await;
        settle(
            &app,
            started,
            generation,
            "the startup sequence ended without reporting a result".to_owned(),
        );
        if let Some(startup) = app.try_state::<Startup>() {
            startup.running.store(false, Ordering::Release);
        }
    });
}

/// Report a terminal state for a run that did not report one itself.
///
/// Idempotent and bound to the run it was started for: a run that already said Ready or Failed is
/// left alone, and a guard whose run has been superseded by a retry says nothing.
fn settle(app: &AppHandle, started: Instant, generation: u64, reason: String) {
    let Some(startup) = app.try_state::<Startup>() else {
        return;
    };
    startup.with_reporting(|| {
        if let Some(progress) = startup.settle(started, generation, reason) {
            let _ = app.emit(PHASE_EVENT, progress);
        }
    });
}

async fn run(app: &AppHandle, started: Instant) {
    let mut deadline = started + DEADLINE;
    // Publishing comes before any lookup that can fail. A sequence that returns before it has
    // said anything leaves the page unable to tell "not started" from "still going".
    report(app, started, Phase::Registering, None);
    let Some(watch) = app.try_state::<AppState>().map(|state| state.watch.clone()) else {
        return;
    };
    let registration = register(app, deadline).await;
    report(
        app,
        started,
        Phase::Registering,
        Some(registration.login.describe().to_owned()),
    );

    report(app, started, Phase::Resolving, None);
    // D5: the shell no longer resolves the home, the port or liveness. It asks the bundled CLI,
    // which owns the tuned probe budgets that exist because a shell-side reimplementation answered
    // "nobody is listening" twice and started duplicate proxies. The call is inside the sequence, so
    // a CLI that is missing or slow has a state, a diagnostic and a retry rather than a guess.
    let resolution = resolve::run(app, deadline).await;
    let Some(answer) = resolution.resolved() else {
        // Fail-closed. A resolution that could not be trusted is not an absence, and nothing below
        // may read it as one.
        fail(
            app,
            started,
            None,
            &registration,
            &watch,
            Phase::Resolving,
            resolution
                .reason()
                .unwrap_or("the runtime could not be resolved")
                .to_owned(),
        );
        return;
    };
    let endpoint = answer.endpoint();
    let target = Target {
        endpoint,
        home: answer.home(),
    };
    let proxy = match ProxyClient::new(endpoint, Auth::new(answer.home())) {
        Ok(proxy) => proxy,
        Err(error) => {
            fail(
                app,
                started,
                Some(&target),
                &registration,
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
            "{} with a configuration home of {}, resolved by the bundled CLI {}; {}",
            target.endpoint.url(""),
            target.home.display(),
            answer.cli_version,
            ownership::describe(&answer.ownership, registration.install_id.as_deref())
        )),
    );

    report(
        app,
        started,
        Phase::Probing,
        Some(match answer.liveness.status {
            resolve::Status::Live => "a runtime is already listening".to_owned(),
            resolve::Status::AbsentProven => {
                "no runtime is listening, and that absence was proven".to_owned()
            }
        }),
    );
    let mut took_over = false;
    match resolve::live_verdict(&resolution) {
        resolve::LiveVerdict::Attach => {
            // Without our own id nothing can ever match us, which is the answer Refuse gives.
            let consent = match registration.install_id.as_deref() {
                Some(install_id) => ownership::consent(&answer.ownership, install_id),
                None => ownership::Consent::Refuse,
            };
            match attach_plan(consent, &answer.takeover) {
                AttachPlan::Guest(detail) => {
                    attach_as_guest(
                        app,
                        started,
                        &target,
                        &registration,
                        &watch,
                        &proxy,
                        endpoint,
                        deadline,
                        detail,
                    )
                    .await;
                    return;
                }
                AttachPlan::Ask => {
                    // The prompt has to be visible even when this launch started hidden.
                    if let Some(window) = app.get_webview_window("main") {
                        crate::window::show(&window);
                    }
                    let Some(startup) = app.try_state::<Startup>() else {
                        return;
                    };
                    let Some(receiver) = startup.await_consent() else {
                        // The run already ended (an expiry won the race to the terminal
                        // state). Posting the prompt now would wait on a decision nobody
                        // can see, so the run stops here instead.
                        return;
                    };
                    let mut progress = Progress::new(Phase::Attaching, elapsed(started));
                    progress.detail = Some(
                        "a runtime was already listening; waiting for a decision on taking it over"
                            .to_owned(),
                    );
                    progress.consent = Some(ConsentPrompt {
                        endpoint: target.endpoint.url(""),
                        port: target.endpoint.port,
                        home: target.home.display().to_string(),
                        owner: ownership::owner_label(&answer.ownership),
                        blocked: None,
                    });
                    emit(app, progress, None);
                    // The user may take any time; the budget exists to bound the machinery, not
                    // the person, so the deadline moves by whatever the decision took.
                    let asked = Instant::now();
                    let approved = receiver.await.unwrap_or(false);
                    deadline += asked.elapsed();
                    // The extension and the clear are one critical section: the guard sees
                    // either a prompt still pending or the moved ceiling, never the gap.
                    startup.resolve_consent(deadline);
                    if !approved {
                        attach_as_guest(
                            app,
                            started,
                            &target,
                            &registration,
                            &watch,
                            &proxy,
                            endpoint,
                            deadline,
                            "a runtime was already listening and taking it over was declined, so this app is a guest on it"
                                .to_owned(),
                        )
                        .await;
                        return;
                    }
                    if take_over(
                        app,
                        started,
                        &mut deadline,
                        &target,
                        &registration,
                        &watch,
                        &proxy,
                        answer,
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    took_over = true;
                }
            }
        }
        // Something holds the port and this app cannot manage it. That is not an absence, so it
        // does not authorise starting a second runtime beside it either.
        resolve::LiveVerdict::Unusable(reason) => {
            fail(
                app,
                started,
                Some(&target),
                &registration,
                &watch,
                Phase::Attaching,
                reason,
            );
            return;
        }
        resolve::LiveVerdict::NotLive => {}
    }
    if !took_over && !resolve::may_start(&resolution) {
        // Only a proven absence authorises a start. Nothing else may fall through to one. A
        // takeover just proved its own absence by stopping what was there.
        fail(
            app,
            started,
            Some(&target),
            &registration,
            &watch,
            Phase::Probing,
            "the runtime's liveness could not be established, so no runtime was started".to_owned(),
        );
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
                    Some(&target),
                    &registration,
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
            if bind(app, &proxy, deadline).await.is_none() {
                // Healthy is not the same as identified: a 200 with a body that does not carry the
                // marker is something else holding the port, and the token is never sent to it.
                fail(
                    app,
                    started,
                    Some(&target),
                    &registration,
                    &watch,
                    Phase::Waiting,
                    "the runtime reported healthy but did not identify itself".to_owned(),
                );
                return;
            }
            finish(app, started, endpoint);
            return;
        }
        // A child that has already exited will never answer, so the deadline is not worth waiting
        // out. This is the case the discarded event stream used to hide behind a generic timeout.
        if let Some(exit) = watch.exit() {
            fail(
                app,
                started,
                Some(&target),
                &registration,
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
        Some(&target),
        &registration,
        &watch,
        Phase::Waiting,
        format!(
            "the runtime did not report healthy within {} seconds",
            DEADLINE.as_secs()
        ),
    );
}

/// What an attach turns into once the recorded owner and the CLI's compatibility answer are
/// laid next to each other. The approved resolve answer carries the claim token.
enum AttachPlan {
    /// Stay a guest on what answered; the string is the detail the phase reports.
    Guest(String),
    /// Offer the takeover and wait on the user.
    Ask,
}

fn attach_plan(consent: ownership::Consent, takeover: &resolve::Takeover) -> AttachPlan {
    match consent {
        ownership::Consent::Held => AttachPlan::Guest(
            "a runtime was already listening and this installation already owns it".to_owned(),
        ),
        ownership::Consent::Refuse => AttachPlan::Guest(
            "a runtime was already listening; its recorded owner could not be read, so this app is a guest on it and asked nothing".to_owned(),
        ),
        ownership::Consent::AskFirstTime | ownership::Consent::AskAgain => match takeover {
            resolve::Takeover::Blocked { reason, detail } => AttachPlan::Guest(format!(
                "a runtime was already listening, but taking it over is not available ({reason}: {detail}), so this app is a guest on it"
            )),
            resolve::Takeover::Supported { .. } => AttachPlan::Ask,
        },
    }
}

/// Report, bind and finish as a guest on the runtime that answered.
#[allow(clippy::too_many_arguments)]
async fn attach_as_guest(
    app: &AppHandle,
    started: Instant,
    target: &Target,
    registration: &Registration,
    watch: &SidecarWatch,
    proxy: &ProxyClient,
    endpoint: ProxyEndpoint,
    deadline: Instant,
    detail: String,
) {
    report(app, started, Phase::Attaching, Some(detail));
    if bind(app, proxy, deadline).await.is_none() {
        fail(
            app,
            started,
            Some(target),
            registration,
            watch,
            Phase::Attaching,
            "the runtime answered but did not identify itself, so this app did not attach"
                .to_owned(),
        );
        return;
    }
    finish(app, started, endpoint);
}

fn approval_still_current(approved: &resolve::Resolved, fresh: &resolve::Resolution) -> bool {
    let Some(now) = fresh.resolved() else {
        return false;
    };
    matches!(resolve::live_verdict(fresh), resolve::LiveVerdict::Attach)
        && matches!(&now.takeover, resolve::Takeover::Supported { .. })
        && approved.ownership == now.ownership
        && approved.takeover == now.takeover
        && approved.config_home == now.config_home
        && approved.cli_version == now.cli_version
        && approved.port == now.port
        && approved.liveness == now.liveness
}

async fn stop_after_approval<F, Fut>(
    approved: &resolve::Resolved,
    fresh: &resolve::Resolution,
    stop: F,
) -> Option<runtime_stop::StopResult>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = runtime_stop::StopResult>,
{
    if !approval_still_current(approved, fresh) {
        return None;
    }
    Some(stop().await)
}

async fn claim_after_silence<F, Fut>(
    stopped: &runtime_stop::StopResult,
    silent: bool,
    claim: F,
) -> Option<claim::ClaimResult>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = claim::ClaimResult>,
{
    if !silent || !stopped.may_check_silence() {
        return None;
    }
    Some(claim().await)
}

/// Stop the runtime that answered, wait for its silence, and record this installation as
/// the owner. An `Err` has already been reported; `Ok` means the Starting branch may run.
#[allow(clippy::too_many_arguments)]
async fn take_over(
    app: &AppHandle,
    started: Instant,
    deadline: &mut Instant,
    target: &Target,
    registration: &Registration,
    watch: &SidecarWatch,
    proxy: &ProxyClient,
    approved: &resolve::Resolved,
) -> Result<(), ()> {
    let fresh = resolve::run(app, *deadline).await;
    let stopped = stop_after_approval(approved, &fresh, || async {
        report(
            app,
            started,
            Phase::TakingOver,
            Some("stopping the runtime that was already listening".to_owned()),
        );
        runtime_stop::run_approved(app, *deadline, approved).await
    })
    .await;
    let Some(stopped) = stopped else {
        fail(
            app,
            started,
            Some(target),
            registration,
            watch,
            Phase::TakingOver,
            "the runtime or its managing CLI changed after approval; retry to review it".to_owned(),
        );
        return Err(());
    };
    if stopped.is_approval_changed() || !stopped.may_check_silence() {
        fail(
            app,
            started,
            Some(target),
            registration,
            watch,
            Phase::TakingOver,
            format!(
                "the guarded stop could not confirm the approved runtime: {}",
                stopped.describe()
            ),
        );
        return Err(());
    }
    // A refused connection, not exit 0 and not the probe's deadline, is the receipt: `ocx stop`
    // reports exit 79 when the proxy stopped but history cleanup failed after it exited, and a
    // `None` from alive_within is only the clock running out — neither is silence. Only a
    // validated stop result reaches this loop, and claim still requires active refusal.
    let mut silent = false;
    let mut still_answering = false;
    while Instant::now() < *deadline {
        match proxy.alive_within(*deadline).await {
            Some(Err(_)) => {
                silent = true;
                break;
            }
            Some(Ok(_)) => {
                still_answering = true;
                sleep(POLL).await;
            }
            None => {
                still_answering = false;
                break;
            }
        }
    }
    if !silent {
        fail(
            app,
            started,
            Some(target),
            registration,
            watch,
            Phase::TakingOver,
            format!(
                "the runtime that was already listening {} ({})",
                if still_answering {
                    "is still answering after the stop"
                } else {
                    "did not go silent before the deadline"
                },
                stopped.describe()
            ),
        );
        return Err(());
    }
    if !stopped.is_stopped() {
        report(
            app,
            started,
            Phase::TakingOver,
            Some(format!(
                "the runtime that was already listening stopped answering (stop reported: {})",
                stopped.describe()
            )),
        );
    }

    report(
        app,
        started,
        Phase::TakingOver,
        Some("recording this installation as the runtime owner".to_owned()),
    );
    let install_id = registration.install_id.clone().unwrap_or_default();
    // An unknown record reaches here only off the UI path, and the claim has to refuse rather
    // than fabricate the subject it is claiming against.
    let resolve::Takeover::Supported { token, .. } = &approved.takeover else {
        return Err(());
    };
    let Some(argv) = claim::args(&install_id, &approved.ownership, token) else {
        fail(
            app,
            started,
            Some(target),
            registration,
            watch,
            Phase::TakingOver,
            "the recorded owner could not be read, so no claim was made".to_owned(),
        );
        return Err(());
    };
    match claim_after_silence(&stopped, silent, || claim::run(app, argv, *deadline)).await {
        Some(claim::ClaimResult::Recorded(ownership)) => {
            report(
                app,
                started,
                Phase::TakingOver,
                Some(format!(
                    "this installation now owns the runtime (consent generation {})",
                    ownership.consent_generation
                )),
            );
            Ok(())
        }
        Some(claim::ClaimResult::Failed(message)) => {
            // The runtime is stopped either way. Refusing here leaves the next launch an
            // ordinary absence to start into, which is the acceptable end state.
            fail(
                app,
                started,
                Some(target),
                registration,
                watch,
                Phase::TakingOver,
                format!(
                    "the runtime was stopped, but this installation could not be recorded as its owner: {message}"
                ),
            );
            Err(())
        }
        None => {
            fail(
                app,
                started,
                Some(target),
                registration,
                watch,
                Phase::TakingOver,
                "the approved runtime changed, so no ownership claim was attempted".to_owned(),
            );
            Err(())
        }
    }
}

/// Establish the app's own surface: the tray verdict, the tray, and the login item.
///
/// It happens once per process. A retry re-runs the runtime half of the sequence, and running this
/// half again would build a second tray icon with its own refresh loop and its own menu handlers —
/// the failure would look like the app duplicating itself every time the user pressed Retry.
async fn register(app: &AppHandle, deadline: Instant) -> Registration {
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
    // This installation's own id, and what the recorded runtime owner says about it. The claim
    // lives in the shared service install state and the CLI is what reads it; the comparison
    // against our own id is the rule that record publishes.
    // This installation's own id; what the recorded runtime owner says about it is part of the
    // resolve answer, so the identity line is written where the answer exists.
    let registration = Registration {
        login,
        install_id: identity::install_id(app),
    };
    if let Some(startup) = app.try_state::<Startup>() {
        startup.remember_registration(registration.clone());
    }
    registration
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

/// Establish which instance is answering, and whether it is the child this app started.
///
/// The health body is unauthenticated and carries the marker, the pid and the port, so identity is
/// settled before any credential is sent. It is also the only thing that grants process ownership:
/// a spawn records a pid, and this is what says that pid is the one holding the port. An answer
/// that cannot be read leaves the app owning nothing, which is the safe way round — an owner's stop
/// sent to a listener that is not ours is a stop sent to somebody else's runtime.
///
/// The answer is returned rather than swallowed, because a sequence that cannot identify what it is
/// talking to has not finished. Reporting Ready there would navigate the window to a dashboard the
/// shell cannot authenticate against, since the management token is only sent to a bound instance.
async fn bind(app: &AppHandle, proxy: &ProxyClient, deadline: Instant) -> Option<RuntimeIdentity> {
    let identity = match tokio::time::timeout_at(deadline, proxy.identify()).await {
        Ok(Ok(identity)) => identity,
        _ => return None,
    };
    proxy.bind(identity);
    if let Some(state) = app.try_state::<AppState>() {
        state.confirm_ownership(identity);
    }
    Some(identity)
}

fn finish(app: &AppHandle, started: Instant, endpoint: ProxyEndpoint) {
    // Ownership is whatever the confirmation above established, not whatever a spawn assumed.
    crate::tray::set_owned(
        app,
        app.try_state::<AppState>()
            .is_some_and(|state| state.owns_runtime()),
    );
    let path = format!(
        "/?desktop_session={}#/usage",
        app.state::<crate::updater::DesktopUpdateState>()
            .session_id()
    );
    let dashboard = endpoint.url(&path);
    let mut progress = Progress::new(Phase::Ready, elapsed(started));
    progress.dashboard = Some(dashboard.clone());
    if !emit(app, progress, None) {
        // The run already ended — the expiry won while this one was still binding. The
        // terminal state stays and the window must not navigate away from it.
        return;
    }
    app.state::<crate::updater::DesktopUpdateState>().wake();
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(true);
        let startup = app.try_state::<Startup>();
        let requested = startup
            .as_ref()
            .is_some_and(|startup| startup.dashboard_requested());
        if loads_dashboard_on_ready(LaunchOrigin::detect(), visible, requested) {
            match startup {
                Some(startup) => {
                    navigate_once(&startup, &dashboard, |url| navigate_dashboard(&window, url));
                }
                None => {
                    navigate_dashboard(&window, &dashboard);
                }
            }
        }
    }
}

/// Open the full dashboard only when a person asks for it.
///
/// A hidden login launch deliberately leaves its WebView on the tiny bundled startup surface after
/// the runtime becomes ready. The tray, a second ordinary application launch, or the bootstrap
/// command reaches this function and pays the dashboard cost at that point. If startup is still in
/// progress the bootstrap is merely shown; `finish` observes the now-visible window and performs
/// the navigation once the endpoint is ready.
pub fn open_dashboard(app: &AppHandle) {
    let startup = app.try_state::<Startup>();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Some(startup) = startup {
        // The request is recorded before progress is read; see `dashboard_requested`.
        startup.request_dashboard();
        if let Some(dashboard) = startup.ready_dashboard() {
            navigate_once(&startup, &dashboard, |url| navigate_dashboard(&window, url));
        }
    }
    crate::window::show(&window);
}

pub fn return_to_dashboard(app: &AppHandle) -> Result<(), String> {
    let startup = app.try_state::<Startup>().ok_or("dashboard is not ready")?;
    let dashboard = startup.ready_dashboard();
    let window = app
        .get_webview_window("main")
        .ok_or("dashboard window is unavailable")?;
    return_ready_dashboard(dashboard.as_deref(), |url| navigate_dashboard(&window, url))?;
    crate::window::show(&window);
    Ok(())
}

fn return_ready_dashboard(
    dashboard: Option<&str>,
    navigate: impl FnOnce(&str) -> bool,
) -> Result<(), String> {
    let dashboard = dashboard.ok_or("dashboard is not ready")?;
    if !navigate(dashboard) {
        return Err("dashboard could not be opened".into());
    }
    Ok(())
}

fn loads_dashboard_on_ready(origin: LaunchOrigin, window_visible: bool, requested: bool) -> bool {
    origin == LaunchOrigin::User || window_visible || requested
}

/// Perform this run's single dashboard navigation through `navigate`.
///
/// `navigate` reports whether the WebView accepted the script. Acceptance is not proof that the
/// page finished loading, but a refusal certainly left the bootstrap page in place, so the claim is
/// returned and the next explicit open tries again instead of being suppressed for the whole run.
fn navigate_once(startup: &Startup, dashboard: &str, navigate: impl FnOnce(&str) -> bool) -> bool {
    if !startup.should_navigate_dashboard() {
        return false;
    }
    if navigate(dashboard) {
        return true;
    }
    startup.navigation_failed();
    false
}

fn navigate_dashboard(window: &tauri::WebviewWindow, dashboard: &str) -> bool {
    // justified: replacing the bootstrap page with the dashboard is how this window has always
    // navigated, and the string is a URL this process resolved, not anything a page supplied.
    window
        .eval(format!("window.location.replace({dashboard:?})"))
        .is_ok()
}

#[allow(clippy::too_many_arguments)]
fn fail(
    app: &AppHandle,
    started: Instant,
    target: Option<&Target>,
    registration: &Registration,
    watch: &SidecarWatch,
    phase: Phase,
    reason: String,
) {
    let elapsed_ms = elapsed(started);
    let mut progress = Progress::new(Phase::Failed, elapsed_ms);
    progress.diagnostic = Some(diagnostic(
        target.map(|target| (target.endpoint, target.home.clone())),
        registration,
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
    target: Option<(ProxyEndpoint, PathBuf)>,
    registration: &Registration,
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
    match target {
        Some((endpoint, home)) => {
            lines.push(format!("endpoint: {}", endpoint.url("")));
            lines.push(format!("home: {}", home.display()));
        }
        None => lines.push("endpoint: not resolved".to_owned()),
    }
    lines.push(format!("start at login: {}", registration.login.describe()));
    lines.push(format!(
        "installation id: {}",
        registration.install_id.as_deref().unwrap_or("not minted")
    ));
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

/// Publish and emit one state. A report refused because the run already ended is not
/// emitted either, so a stale event cannot move the page past the terminal state the
/// snapshot keeps. Returns whether the report was published.
fn emit(app: &AppHandle, mut progress: Progress, failed_in: Option<Phase>) -> bool {
    if let Some(startup) = app.try_state::<Startup>() {
        return startup.with_reporting(|| {
            if !startup.publish(&mut progress, failed_in) {
                return false;
            }
            let _ = app.emit(PHASE_EVENT, progress);
            true
        });
    }
    let _ = app.emit(PHASE_EVENT, progress);
    true
}

fn elapsed(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::{
        approval_still_current, attach_plan, claim_after_silence, loads_dashboard_on_ready,
        navigate_once, return_ready_dashboard, shows_window, stop_after_approval, unavailable,
        AttachPlan, ConsentState, Expiry, LaunchOrigin, Phase, Progress, Startup, AUTOSTART_FLAG,
        DEADLINE, PHASES, POLL,
    };
    use crate::claim::ClaimResult;
    use crate::ownership::{Claim, Consent, Owner, Recorded};
    use crate::resolve::{Liveness, Port, Resolution, Resolved, Status, Takeover};
    use crate::runtime_stop::{self, StopResult};
    use crate::tray_availability::TrayAvailability;
    use std::cell::Cell;
    use std::sync::atomic::Ordering;
    use tokio::time::{Duration, Instant};

    fn supported() -> Takeover {
        Takeover::Supported {
            protocol_version: 1,
            minimum_cli_version: "2.61.0".to_owned(),
            token: "tok".to_owned(),
        }
    }

    fn blocked() -> Takeover {
        Takeover::Blocked {
            reason: "managing-cli-unsupported".to_owned(),
            detail: "path uses 2.59.0".to_owned(),
        }
    }

    fn approved_answer() -> Resolved {
        Resolved {
            schema: "ocx-resolve/1".to_owned(),
            cli_version: "2.61.0".to_owned(),
            config_home: "/sandbox/a".to_owned(),
            port: Port {
                effective: 10100,
                configured: 10100,
            },
            liveness: Liveness {
                status: Status::Live,
                pid: Some(42),
                port: Some(10100),
                hostname: None,
                version: Some("2.61.0".to_owned()),
                role: None,
            },
            ownership: Recorded::Owned {
                ownership: Claim {
                    owner: Owner::Cli,
                    install_id: "cli-a".to_owned(),
                    consent_generation: 2,
                },
                revision: 7,
            },
            takeover: supported(),
        }
    }

    #[test]
    fn a_changed_answer_never_invokes_stop() {
        tauri::async_runtime::block_on(async {
            let approved = approved_answer();
            let mut changed = approved.clone();
            changed.ownership = Recorded::None { revision: 8 };
            let called = Cell::new(false);
            let refused = stop_after_approval(
                &approved,
                &Resolution::Answered(Box::new(changed)),
                || async {
                    called.set(true);
                    StopResult::Failed("called".to_owned())
                },
            )
            .await;
            assert!(refused.is_none());
            assert!(!called.get());
            let accepted = stop_after_approval(
                &approved,
                &Resolution::Answered(Box::new(approved.clone())),
                || async {
                    called.set(true);
                    StopResult::Failed("called".to_owned())
                },
            )
            .await;
            assert!(accepted.is_some());
            assert!(called.get());
            let mut moved = approved.clone();
            moved.liveness.pid = Some(43);
            assert!(!approval_still_current(
                &approved,
                &Resolution::Answered(Box::new(moved))
            ));
            let mut moved = approved.clone();
            moved.port.effective = 10101;
            assert!(!approval_still_current(
                &approved,
                &Resolution::Answered(Box::new(moved))
            ));
            let mut moved = approved.clone();
            moved.config_home = "/sandbox/b".to_owned();
            assert!(!approval_still_current(
                &approved,
                &Resolution::Answered(Box::new(moved))
            ));
            let mut moved = approved.clone();
            moved.cli_version = "2.62.0".to_owned();
            assert!(!approval_still_current(
                &approved,
                &Resolution::Answered(Box::new(moved))
            ));
            let mut moved = approved.clone();
            moved.liveness.hostname = Some("localhost".to_owned());
            assert!(!approval_still_current(
                &approved,
                &Resolution::Answered(Box::new(moved))
            ));
            let mut moved = approved.clone();
            if let Takeover::Supported { token, .. } = &mut moved.takeover {
                *token = "changed".to_owned();
            }
            assert!(!approval_still_current(
                &approved,
                &Resolution::Answered(Box::new(moved))
            ));
            let mut moved = approved.clone();
            moved.takeover = blocked();
            assert!(!approval_still_current(
                &approved,
                &Resolution::Answered(Box::new(moved))
            ));
            assert!(!approval_still_current(
                &approved,
                &Resolution::Unknown("unreadable".to_owned())
            ));
        });
    }

    #[test]
    fn terminal_stop_results_never_invoke_claim_after_silence() {
        tauri::async_runtime::block_on(async {
            let approved = approved_answer();
            let answer = Resolution::Answered(Box::new(approved.clone()));
            let called = Cell::new(false);
            for result in [
                StopResult::ApprovalChanged("moved".to_owned()),
                StopResult::ManagerStillActive("active".to_owned()),
                runtime_stop::read(Some(1), b"{", b""),
                StopResult::Failed("the bundled CLI timed out".to_owned()),
            ] {
                let stopped = stop_after_approval(&approved, &answer, || async { result })
                    .await
                    .expect("matching answer");
                assert!(!stopped.may_check_silence());
                let claimed = claim_after_silence(&stopped, true, || async {
                    called.set(true);
                    ClaimResult::Failed("called".to_owned())
                })
                .await;
                assert!(claimed.is_none());
                assert!(!called.get());
            }
            let history = StopResult::HistoryIncomplete("history-incomplete".to_owned());
            let claimed = claim_after_silence(&history, true, || async {
                called.set(true);
                ClaimResult::Failed("called".to_owned())
            })
            .await;
            assert!(matches!(claimed, Some(ClaimResult::Failed(_))));
            assert!(called.get());
        });
    }

    #[test]
    fn a_retry_drops_a_prompt_the_run_is_still_waiting_on() {
        // The waiting run reads the dropped sender as declined, so a stale prompt can never
        // pair a decision meant for it with the retried sequence.
        let startup = Startup::new();
        let mut receiver = startup.await_consent().expect("no terminal state yet");
        startup.restart();
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Closed)
        ));
    }

    #[test]
    fn an_ask_only_arises_when_the_takeover_can_be_taken() {
        // Held and Refuse never ask, whatever the CLI reported about compatibility.
        assert!(matches!(
            attach_plan(Consent::Held, &supported()),
            AttachPlan::Guest(_)
        ));
        assert!(matches!(
            attach_plan(Consent::Refuse, &supported()),
            AttachPlan::Guest(_)
        ));
        assert!(matches!(
            attach_plan(Consent::AskFirstTime, &supported()),
            AttachPlan::Ask
        ));
        match attach_plan(Consent::AskAgain, &blocked()) {
            AttachPlan::Guest(detail) => {
                assert!(detail.contains("managing-cli-unsupported: path uses 2.59.0"))
            }
            AttachPlan::Ask => panic!("a blocked takeover is not an offer"),
        }
    }

    #[test]
    fn not_having_started_is_not_a_step_of_the_run() {
        // A checklist row for it would be a step that never completes, and resolving it out of a
        // published id would name a phase the page has nowhere to draw.
        assert!(!PHASES.contains(&Phase::NotStarted));
        assert_eq!(Phase::from_id(Phase::NotStarted.id()), None);
        for phase in PHASES {
            assert_eq!(Phase::from_id(phase.id()), Some(phase));
        }
    }

    #[test]
    fn a_sequence_that_has_not_run_says_so() {
        // Seeding the state with Registering made "has not started" render exactly like "started,
        // and registering" — on the one surface whose job is to tell those apart.
        let startup = Startup::new();
        assert_eq!(startup.latest().phase, Phase::NotStarted.id());
        assert!(!startup.latest().can_retry);
        assert!(!startup.settled());
    }

    #[test]
    fn the_snapshot_never_answers_with_nothing() {
        // The page returns early on a falsy progress, so answering None here was a window frozen
        // on its own markup with no diagnostic in it and no event coming.
        let progress = unavailable();
        assert_eq!(progress.phase, Phase::Failed.id());
        assert!(progress.can_retry);
        assert!(progress.detail.is_some());
        assert!(progress
            .diagnostic
            .is_some_and(|text| text.contains("reason:")));
    }

    #[test]
    fn only_a_terminal_state_settles_a_run() {
        // This is what stops the deadline guard from overwriting a run that already reported, and
        // what makes it speak for one that never did.
        let startup = Startup::new();
        let mut running = Progress::new(Phase::Waiting, 1);
        startup.publish(&mut running, None);
        assert!(!startup.settled());
        let mut done = Progress::new(Phase::Ready, 2);
        startup.publish(&mut done, None);
        assert!(startup.settled());
    }

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
    fn only_a_hidden_login_launch_defers_the_full_dashboard() {
        assert!(loads_dashboard_on_ready(LaunchOrigin::User, false, false));
        assert!(loads_dashboard_on_ready(LaunchOrigin::User, true, false));
        assert!(loads_dashboard_on_ready(
            LaunchOrigin::Autostart,
            true,
            false
        ));
        assert!(!loads_dashboard_on_ready(
            LaunchOrigin::Autostart,
            false,
            false
        ));
        // An open that arrived during startup counts even if the queued show has not landed yet.
        assert!(loads_dashboard_on_ready(
            LaunchOrigin::Autostart,
            false,
            true
        ));
    }

    #[test]
    fn explicit_dashboard_navigation_is_consumed_once_per_run() {
        let startup = Startup::new();
        let mut navigations = Vec::new();
        assert!(navigate_once(
            &startup,
            "http://127.0.0.1:10100/#/usage",
            |url| {
                navigations.push(url.to_string());
                true
            }
        ));
        assert!(!navigate_once(
            &startup,
            "http://127.0.0.1:10100/#/usage",
            |url| {
                navigations.push(url.to_string());
                true
            }
        ));
        assert_eq!(
            navigations,
            vec!["http://127.0.0.1:10100/#/usage".to_string()]
        );

        startup.restart();
        assert!(navigate_once(
            &startup,
            "http://127.0.0.1:10101/#/usage",
            |_| true
        ));
        assert!(!navigate_once(
            &startup,
            "http://127.0.0.1:10101/#/usage",
            |_| true
        ));
    }

    #[test]
    fn a_refused_dashboard_navigation_is_retried_on_the_next_open() {
        let startup = Startup::new();
        assert!(!navigate_once(
            &startup,
            "http://127.0.0.1:10100/#/usage",
            |_| false
        ));
        let mut attempts = 0;
        assert!(navigate_once(
            &startup,
            "http://127.0.0.1:10100/#/usage",
            |_| {
                attempts += 1;
                true
            }
        ));
        assert_eq!(attempts, 1);
        assert!(!navigate_once(
            &startup,
            "http://127.0.0.1:10100/#/usage",
            |_| true
        ));
    }

    #[test]
    fn an_open_during_startup_is_remembered_until_the_run_restarts() {
        let startup = Startup::new();
        assert!(!startup.dashboard_requested());
        assert_eq!(startup.ready_dashboard(), None);
        startup.request_dashboard();
        assert!(startup.dashboard_requested());
        startup.restart();
        assert!(!startup.dashboard_requested());
    }

    #[test]
    fn update_page_return_requires_a_ready_dashboard_and_retries_refused_navigation() {
        assert_eq!(
            return_ready_dashboard(None, |_| true).unwrap_err(),
            "dashboard is not ready"
        );
        assert_eq!(
            return_ready_dashboard(Some("http://127.0.0.1:10100/#/usage"), |_| false).unwrap_err(),
            "dashboard could not be opened"
        );
        let mut visited = None;
        assert!(
            return_ready_dashboard(Some("http://127.0.0.1:10100/#/usage"), |url| {
                visited = Some(url.to_owned());
                true
            })
            .is_ok()
        );
        assert_eq!(visited.as_deref(), Some("http://127.0.0.1:10100/#/usage"));
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
        let budgets = [DEADLINE, POLL];
        assert!(budgets
            .iter()
            .all(|budget| *budget <= Duration::from_secs(45)));
        assert!(POLL < DEADLINE);
    }

    #[test]
    fn an_expired_run_publishes_failed_in_the_same_step() {
        // The expiry decision and the terminal publish share one critical section: an expired
        // deadline with no prompt up fails the run, and the failure is already there when the
        // call returns.
        let startup = Startup::new();
        startup.generation.store(1, Ordering::SeqCst);
        startup.set_deadline(tokio::time::Instant::now() - Duration::from_secs(60));
        match startup.expire_run(
            tokio::time::Instant::now() - Duration::from_secs(60),
            1,
            "expired".to_owned(),
        ) {
            Expiry::Fired(progress) => {
                assert_eq!(progress.phase, Phase::Failed.id());
                assert!(progress.can_retry);
            }
            _ => panic!("an expired deadline with no consent must fire"),
        }
        assert!(startup.settled());
        // A second expiry for the same run says nothing.
        assert!(matches!(
            startup.expire_run(tokio::time::Instant::now(), 1, "again".to_owned()),
            Expiry::Dead
        ));
    }

    #[test]
    fn a_pending_prompt_blocks_expiry_and_the_prompt_still_resolves() {
        // The losing side of the race the guard used to win: the prompt is up while the
        // deadline sits in the past. Expiry must yield, and the user's answer must still
        // reach the waiting run.
        let startup = Startup::new();
        startup.generation.store(1, Ordering::SeqCst);
        startup.set_deadline(tokio::time::Instant::now() - Duration::from_secs(60));
        let mut receiver = startup.await_consent().expect("no terminal state yet");
        assert!(matches!(
            startup.expire_run(tokio::time::Instant::now(), 1, "expired".to_owned()),
            Expiry::Blocked
        ));
        startup.decide_takeover(true);
        assert_eq!(receiver.try_recv(), Ok(true));
        // The answer was consumed but the extension has not landed yet: still not expirable.
        assert!(matches!(
            startup.expire_run(tokio::time::Instant::now(), 1, "expired".to_owned()),
            Expiry::Blocked
        ));
        // Once the run publishes the moved ceiling the guard waits on it instead of firing.
        startup.resolve_consent(tokio::time::Instant::now() + Duration::from_secs(60));
        assert!(matches!(
            startup.expire_run(tokio::time::Instant::now(), 1, "expired".to_owned()),
            Expiry::Waiting(_)
        ));
    }

    #[test]
    fn a_terminal_run_posts_no_prompt() {
        // The other half of the race: the failure already landed, so the ask path must not
        // register a prompt that would wait on a decision nobody can see.
        let startup = Startup::new();
        startup.generation.store(1, Ordering::SeqCst);
        let mut terminal = Progress::new(Phase::Failed, 1);
        startup.publish(&mut terminal, None);
        assert!(startup.await_consent().is_none());
        // And the consent state stays idle, so a later run is not shadowed by a stale prompt.
        assert!(matches!(startup.live().consent, ConsentState::Idle));
    }

    #[test]
    fn a_terminal_state_is_not_moved_by_a_late_report() {
        // The expiry lands while the run is still inside a probe; the probe then resumes and
        // reports. Neither the snapshot nor the consent gate may move: the terminal state is
        // the page's promise that it stopped changing, and a report that could undo it would
        // also reopen the prompt the terminal state just ruled out.
        let startup = Startup::new();
        startup.generation.store(1, Ordering::SeqCst);
        startup.set_deadline(tokio::time::Instant::now() - Duration::from_secs(60));
        match startup.expire_run(
            tokio::time::Instant::now() - Duration::from_secs(60),
            1,
            "expired".to_owned(),
        ) {
            Expiry::Fired(progress) => assert_eq!(progress.phase, Phase::Failed.id()),
            _ => panic!("an expired deadline with no consent must fire"),
        }
        let mut late = Progress::new(Phase::Probing, 2);
        assert!(!startup.publish(&mut late, None));
        assert_eq!(startup.latest().phase, Phase::Failed.id());
        assert!(startup.await_consent().is_none());
        // A second terminal report is refused as well: the first ending stands.
        let mut ready = Progress::new(Phase::Ready, 3);
        assert!(!startup.publish(&mut ready, None));
        assert_eq!(startup.latest().phase, Phase::Failed.id());
    }

    #[test]
    fn expiry_waits_for_an_accepted_report_to_be_dispatched() {
        let startup = Startup::new();
        startup.generation.store(1, Ordering::SeqCst);
        startup.set_deadline(Instant::now() - Duration::from_secs(60));
        let events = std::sync::Mutex::new(Vec::new());
        let (checked_tx, checked_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            startup.with_reporting(|| {
                let mut progress = Progress::new(Phase::Probing, 1);
                assert!(startup.publish(&mut progress, None));
                let startup = &startup;
                let events = &events;
                scope.spawn(move || {
                    // The report was accepted but has not dispatched yet. Expiry cannot
                    // overtake it, even though the state mutex itself is no longer held.
                    assert!(matches!(
                        startup.reporting.try_lock(),
                        Err(std::sync::TryLockError::WouldBlock)
                    ));
                    checked_tx.send(()).unwrap();
                    startup.with_reporting(|| {
                        match startup.expire_run(Instant::now(), 1, "expired".to_owned()) {
                            Expiry::Fired(progress) => events.lock().unwrap().push(progress.phase),
                            _ => panic!("the unblocked expiry must publish failure"),
                        }
                    });
                });
                checked_rx.recv().unwrap();
                events.lock().unwrap().push(progress.phase);
            });
        });
        assert_eq!(
            *events.lock().unwrap(),
            vec![Phase::Probing.id(), Phase::Failed.id()]
        );
    }

    #[test]
    fn a_superseded_guard_reports_nothing() {
        // A retry bumped the generation: the old guard's expiry is dead even with the
        // deadline in the past.
        let startup = Startup::new();
        startup.generation.store(2, Ordering::SeqCst);
        startup.set_deadline(tokio::time::Instant::now() - Duration::from_secs(60));
        assert!(matches!(
            startup.expire_run(tokio::time::Instant::now(), 1, "expired".to_owned()),
            Expiry::Dead
        ));
    }
}
