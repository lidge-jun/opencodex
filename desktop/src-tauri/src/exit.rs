//! Who is allowed to end the process, and what has to happen first.
//!
//! Three gestures arrive looking like an exit: closing the window, the platform's own quit gesture
//! (Cmd+Q on macOS, Alt+F4 on Windows, the window manager's close on Linux), and the tray's Quit
//! item. Only the last one means "end the runtime". Until this module existed the shell had no
//! `ExitRequested` handler, so the quit gesture went straight to `RunEvent::Exit`, which called
//! `CommandChild::kill()` — a SIGKILL on Unix — on a keystroke the user reads as "hide".
//!
//! Tauri separates a user gesture from a programmatic exit: `RunEvent::ExitRequested` carries
//! `code: None` for the gesture and `Some(_)` for `AppHandle::exit` or `AppHandle::restart`. What
//! it cannot tell apart is the tray's Quit from an update's restart, and those end differently.
//! [`ExitReason`] records which one asked. macOS needs one more thing on top, because its menu Quit
//! never raises the event at all; see [`crate::menu`].
//!
//! Everything that stops the runtime funnels through one phase here — the tray's Quit, the tray's
//! Stop, an update, and a window close on a session with no tray. Two of them running at once is
//! two stops racing over one child, so a second one waits rather than starting its own.
//!
//! A drain that does not complete is **not** recorded as a drain. A quit may still proceed on one,
//! because refusing to close is the worse answer and a standing runtime is recoverable. A restart
//! may not: coming back onto a runtime that was never stopped puts the user on the old version
//! while they believe they are on the new one.

use crate::{proxy::ProxyClient, sidecar, tray_availability::TrayAvailability, window, AppState};
use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{AppHandle, ExitRequestApi, Manager};

/// Why the process has been asked to end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitReason {
    /// The tray's Quit item, or a window close on a session with no tray to hide into.
    UserQuit,
    /// An installed update restarting the app. It drains exactly as a quit does and then comes
    /// back, which is why it is a coordinated restart rather than an exception to the quit rule.
    CoordinatedRestart,
}

/// How far the one drain sequence has got.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitPhase {
    /// Nothing is in flight.
    Idle,
    /// A runtime is being started. An exit arriving now is held until the child exists and is
    /// recorded, because the alternative is a process nobody owns and nobody will stop.
    Spawning,
    /// The runtime is being stopped without ending the app: the tray's Stop.
    Stopping,
    /// The drain that ends the app is running.
    Draining,
    /// The runtime this app owned is confirmed stopped, or was never ours to stop.
    Drained,
    /// The stop was refused, or the runtime still answered after the deadline.
    DrainFailed,
    /// Who owns the runtime could not be established, so nothing was stopped and nothing may be
    /// replaced on the assumption that it was.
    OwnershipUnknown,
}

/// What the event loop should do with an exit request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitDecision {
    /// Nothing asked the app to end and there is a tray to come back from: hide instead.
    Hide,
    /// Hold the exit and drain for this reason; the exit is requested again when the drain reports.
    Drain(ExitReason),
    /// Something else is already draining. Hold the exit and let that one finish.
    Wait,
    /// The drain has reported success. Let the process end.
    Proceed,
    /// The drain did not complete, and this reason is one that may not proceed on that.
    Refuse,
}

/// What a drain established.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainVerdict {
    /// The runtime this app owned is gone, or there was never one of ours to stop.
    Drained,
    /// The stop was refused, or the endpoint still answered after the deadline.
    Failed,
    /// The process answering could not be identified, so nothing was stopped.
    OwnershipUnknown,
}

/// Whether an update may start replacing files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestartReadiness {
    /// The runtime is confirmed stopped. The install may proceed.
    Ready,
    /// The drain did not complete, so the install must not start.
    DrainFailed,
    /// Who owns the runtime could not be established.
    OwnershipUnknown,
    /// Something else is already ending or stopping the runtime.
    Busy,
}

impl RestartReadiness {
    pub fn describe(self) -> &'static str {
        match self {
            Self::Ready => "the runtime is stopped",
            Self::DrainFailed => "the runtime did not stop",
            Self::OwnershipUnknown => "the running proxy could not be identified",
            Self::Busy => "the app is already stopping its runtime",
        }
    }
}

/// Decide what an exit request means.
///
/// `reason` is what the app itself asked for and is `None` for a bare user gesture.
/// `hides_to_tray` is D6: on a session with no usable tray there is nowhere to hide, so a close is
/// a quit and takes the same graceful drain rather than leaving a running process unreachable.
pub fn decide(phase: ExitPhase, reason: Option<ExitReason>, hides_to_tray: bool) -> ExitDecision {
    match phase {
        ExitPhase::Spawning | ExitPhase::Stopping | ExitPhase::Draining => ExitDecision::Wait,
        ExitPhase::Drained => ExitDecision::Proceed,
        // A quit that could not drain still closes the app: refusing to close is the worse answer
        // and the runtime is recoverable. A restart is a different judgement — it would come back
        // attached to a runtime that was never stopped, under a user who believes they upgraded.
        ExitPhase::DrainFailed | ExitPhase::OwnershipUnknown => match reason {
            Some(ExitReason::CoordinatedRestart) => ExitDecision::Refuse,
            _ => ExitDecision::Proceed,
        },
        ExitPhase::Idle => match reason {
            Some(reason) => ExitDecision::Drain(reason),
            None if hides_to_tray => ExitDecision::Hide,
            None => ExitDecision::Drain(ExitReason::UserQuit),
        },
    }
}

struct Inner {
    phase: ExitPhase,
    reason: Option<ExitReason>,
    hides_to_tray: bool,
    /// An exit that arrived while a runtime was being started or stopped, and still has to happen.
    deferred: bool,
}

/// The exit sequence's state, managed by the app.
pub struct ExitCoordinator {
    inner: Mutex<Inner>,
}

impl ExitCoordinator {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                phase: ExitPhase::Idle,
                reason: None,
                // Until the probe answers, assume only what the platform guarantees. Assuming a
                // tray that turns out not to exist is the exact failure D6 is about.
                hides_to_tray: TrayAvailability::assumed().hides_to_tray(),
                deferred: false,
            }),
        }
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Record the session's tray verdict once the probe has answered and an icon exists.
    pub fn set_tray(&self, tray: TrayAvailability) {
        self.inner().hides_to_tray = tray.hides_to_tray();
    }

    pub fn decision(&self) -> ExitDecision {
        let inner = self.inner();
        decide(inner.phase, inner.reason, inner.hides_to_tray)
    }

    /// Record why the app is ending, without starting anything. The first reason wins.
    pub fn claim(&self, reason: ExitReason) {
        let mut inner = self.inner();
        inner.reason.get_or_insert(reason);
    }

    /// Take ownership of the drain, and with it the reason the app is ending.
    ///
    /// Claiming the reason and moving out of `Idle` is one step on purpose. Split apart, a Quit
    /// that claimed first could still be overtaken by an update that started the drain, and the app
    /// would restart under a user who asked it to stop. `fallback` is only used when nothing has
    /// claimed a reason yet.
    ///
    /// While a runtime is being started or stopped the answer is "not yet": the reason is recorded
    /// and the drain is handed to whichever of [`ExitCoordinator::finish_spawn`] or
    /// [`ExitCoordinator::finish_stop`] is holding the phase.
    pub fn claim_drain(&self, fallback: ExitReason) -> Option<ExitReason> {
        let mut inner = self.inner();
        match inner.phase {
            ExitPhase::Idle => {
                let reason = *inner.reason.get_or_insert(fallback);
                inner.phase = ExitPhase::Draining;
                Some(reason)
            }
            ExitPhase::Spawning | ExitPhase::Stopping => {
                inner.reason.get_or_insert(fallback);
                inner.deferred = true;
                None
            }
            // A failed drain is a terminal failure, not work in flight, and retrying it is the
            // recovery: the update stayed pending, so the next attempt runs the stop again. Without
            // this the first refusal would be permanent until the app was restarted by hand — which
            // is the one thing a user with a runtime that would not stop cannot easily do.
            ExitPhase::DrainFailed | ExitPhase::OwnershipUnknown => {
                let reason = *inner.reason.get_or_insert(fallback);
                inner.phase = ExitPhase::Draining;
                Some(reason)
            }
            ExitPhase::Draining | ExitPhase::Drained => None,
        }
    }

    /// Record what the drain established. A failure is not a drain.
    pub fn finish_drain(&self, verdict: DrainVerdict) {
        self.inner().phase = match verdict {
            DrainVerdict::Drained => ExitPhase::Drained,
            DrainVerdict::Failed => ExitPhase::DrainFailed,
            DrainVerdict::OwnershipUnknown => ExitPhase::OwnershipUnknown,
        };
    }

    /// Reserve the right to start a runtime. False once something else owns the phase.
    ///
    /// The reservation exists instead of holding the lock across the spawn. Holding it would make
    /// the main thread's exit handler wait on process creation, so a wedged spawn would be a Quit
    /// that never responds. An exit arriving in between is deferred rather than lost — which is the
    /// thing that must not happen, because a quit that reads "we own nothing" leaves the child it
    /// just missed running forever.
    pub fn begin_spawn(&self) -> bool {
        self.begin(ExitPhase::Spawning)
    }

    /// Release the spawn reservation, handing back a reason that arrived meanwhile.
    pub fn finish_spawn(&self) -> Option<ExitReason> {
        self.finish(ExitPhase::Spawning)
    }

    /// Reserve the runtime for a stop that does not end the app.
    pub fn begin_stop(&self) -> bool {
        self.begin(ExitPhase::Stopping)
    }

    /// Release the stop, handing back a reason that arrived meanwhile.
    pub fn finish_stop(&self) -> Option<ExitReason> {
        self.finish(ExitPhase::Stopping)
    }

    fn begin(&self, phase: ExitPhase) -> bool {
        let mut inner = self.inner();
        if inner.phase != ExitPhase::Idle {
            return false;
        }
        inner.phase = phase;
        true
    }

    fn finish(&self, phase: ExitPhase) -> Option<ExitReason> {
        let mut inner = self.inner();
        if inner.phase != phase {
            return None;
        }
        if inner.deferred {
            let reason = *inner.reason.get_or_insert(ExitReason::UserQuit);
            inner.phase = ExitPhase::Draining;
            inner.deferred = false;
            return Some(reason);
        }
        inner.phase = ExitPhase::Idle;
        None
    }

    #[cfg(test)]
    fn phase(&self) -> ExitPhase {
        self.inner().phase
    }

    #[cfg(test)]
    fn hides_to_tray(&self) -> bool {
        self.inner().hides_to_tray
    }
}

impl Default for ExitCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

/// The platform's quit gesture, and what closing the window means.
///
/// It is not a request to end. D2 makes it mean the same thing on all three platforms: hide where
/// there is a tray to come back from, and a graceful quit where there is not. Closing the window
/// arrives here too: one decision point, so the two gestures cannot drift apart.
pub fn gesture(app: &AppHandle) {
    let Some(coordinator) = app.try_state::<ExitCoordinator>() else {
        return;
    };
    match coordinator.decision() {
        ExitDecision::Hide => hide_windows(app),
        ExitDecision::Drain(reason) => start_drain(app, reason),
        ExitDecision::Wait | ExitDecision::Proceed | ExitDecision::Refuse => {}
    }
}

/// Ask the app to end for a stated reason. This is the only way the shell ends itself.
pub fn request(app: &AppHandle, reason: ExitReason) {
    if let Some(coordinator) = app.try_state::<ExitCoordinator>() {
        coordinator.claim(reason);
    }
    app.exit(0);
}

/// Stop the runtime without ending the app: the tray's Stop item.
///
/// It takes the same phase the quit path takes, so pressing Stop twice, or Stop and then Quit, or
/// Stop during an update, is one execution rather than two racing over one child. Unlike a quit it
/// returns the coordinator to idle, because the app is still running and may start a runtime again.
pub fn request_stop(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(claimed) = app
            .try_state::<ExitCoordinator>()
            .map(|coordinator| coordinator.begin_stop())
        else {
            return;
        };
        if !claimed {
            return;
        }
        let verdict = drain_current(&app).await;
        if verdict == DrainVerdict::Drained {
            if let Some(state) = app.try_state::<AppState>() {
                state.release();
            }
            crate::tray::set_owned(&app, false);
        } else {
            crate::logging::log_once("the runtime could not be stopped", verdict.describe());
        }
        let deferred = app
            .try_state::<ExitCoordinator>()
            .and_then(|coordinator| coordinator.finish_stop());
        if let Some(reason) = deferred {
            drain_now(&app, reason);
        }
    });
}

impl DrainVerdict {
    pub fn describe(self) -> &'static str {
        match self {
            Self::Drained => "the runtime is stopped",
            Self::Failed => "the stop was refused or the runtime still answered",
            Self::OwnershipUnknown => "the running proxy could not be identified",
        }
    }
}

/// Handle `RunEvent::ExitRequested`.
pub fn on_exit_requested(app: &AppHandle, code: Option<i32>, api: &ExitRequestApi) {
    // `AppHandle::restart` documents that `prevent_exit` is ignored for its own exit code, so a
    // restart cannot be held here even to drain. The update path therefore drains before it
    // restarts, and this branch only records the reason so nothing reads the restart as a quit.
    if code == Some(tauri::RESTART_EXIT_CODE) {
        if let Some(coordinator) = app.try_state::<ExitCoordinator>() {
            coordinator.claim(ExitReason::CoordinatedRestart);
        }
        return;
    }
    let Some(coordinator) = app.try_state::<ExitCoordinator>() else {
        return;
    };
    match coordinator.decision() {
        ExitDecision::Hide => {
            api.prevent_exit();
            hide_windows(app);
        }
        ExitDecision::Wait => api.prevent_exit(),
        ExitDecision::Refuse => api.prevent_exit(),
        ExitDecision::Drain(reason) => {
            api.prevent_exit();
            start_drain(app, reason);
        }
        ExitDecision::Proceed => {}
    }
}

/// Drain and then ask to end again.
pub fn start_drain(app: &AppHandle, reason: ExitReason) {
    let Some(coordinator) = app.try_state::<ExitCoordinator>() else {
        return;
    };
    let Some(reason) = coordinator.claim_drain(reason) else {
        return;
    };
    drain_now(app, reason);
}

/// Run the drain for a reason the coordinator has already moved to draining for.
pub fn drain_now(app: &AppHandle, reason: ExitReason) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        finish_and_exit_after(&app, reason).await;
    });
}

async fn finish_and_exit_after(app: &AppHandle, reason: ExitReason) {
    let verdict = drain_current(app).await;
    if let Some(coordinator) = app.try_state::<ExitCoordinator>() {
        coordinator.finish_drain(verdict);
    }
    match (reason, verdict) {
        (ExitReason::UserQuit, _) => app.exit(0),
        (ExitReason::CoordinatedRestart, DrainVerdict::Drained) => {
            app.restart();
        }
        (ExitReason::CoordinatedRestart, _) => {
            crate::logging::log_once("the update restart was refused", verdict.describe());
        }
    }
}

/// Prepare for an update's restart: confirm ownership, drain, and confirm the child is gone.
///
/// This is awaited rather than fired and forgotten, because the pinned updater's Windows install
/// ends the process itself. A restart asked for after `install` returns is a restart that never
/// happens there, so the stop has to be finished before the installer is started at all.
pub async fn prepare_restart(app: &AppHandle) -> RestartReadiness {
    let Some(reason) = app
        .try_state::<ExitCoordinator>()
        .and_then(|coordinator| coordinator.claim_drain(ExitReason::CoordinatedRestart))
    else {
        return RestartReadiness::Busy;
    };
    if reason != ExitReason::CoordinatedRestart {
        // A quit claimed the exit first. It owns the drain now, and the update does not install
        // into an app that is on its way out.
        drain_now(app, reason);
        return RestartReadiness::Busy;
    }
    let verdict = drain_current(app).await;
    if let Some(coordinator) = app.try_state::<ExitCoordinator>() {
        coordinator.finish_drain(verdict);
    }
    match verdict {
        DrainVerdict::Drained => RestartReadiness::Ready,
        DrainVerdict::Failed => RestartReadiness::DrainFailed,
        DrainVerdict::OwnershipUnknown => RestartReadiness::OwnershipUnknown,
    }
}

/// Come back, once the installer has finished and returned.
pub fn complete_restart(app: &AppHandle) -> ! {
    app.restart()
}

/// Stop the runtime this app owns and confirm it is gone.
///
/// Ownership is re-established here rather than read off a flag. A flag set when the child was
/// spawned says nothing about the process answering the endpoint now: the child can have exited and
/// a service can have taken the port back. Sending an owner's stop to that listener is sending it
/// to somebody else's runtime, so the pid is checked first and a listener that cannot be identified
/// is left alone.
///
/// Nothing kills the child. The old path did, with `CommandChild::kill()`, and that is a SIGKILL on
/// Unix: it cut off the in-flight requests, the client-configuration restore and the state-file
/// clearing that the CLI's own stop performs.
pub async fn drain_current(app: &AppHandle) -> DrainVerdict {
    let Some((proxy, child_pid, watch)) = app
        .try_state::<AppState>()
        .map(|state| (state.proxy(), state.child_pid(), state.watch.clone()))
    else {
        return DrainVerdict::OwnershipUnknown;
    };
    let Some(proxy) = proxy else {
        // Nothing resolved, so there is nothing of ours listening anywhere.
        return DrainVerdict::Drained;
    };
    let Some(child_pid) = child_pid else {
        // This app never started a runtime, so it does not stop one.
        return DrainVerdict::Drained;
    };
    match confirm(&proxy, child_pid, &watch).await {
        Ownership::Gone => DrainVerdict::Drained,
        Ownership::Foreign => DrainVerdict::Drained,
        Ownership::Unknown => DrainVerdict::OwnershipUnknown,
        Ownership::Ours => match sidecar::drain(&proxy, true, &watch).await.failure() {
            None => DrainVerdict::Drained,
            Some(error) => {
                crate::logging::log_once("graceful stop did not complete", &error);
                DrainVerdict::Failed
            }
        },
    }
}

enum Ownership {
    /// The process answering is the child this app started.
    Ours,
    /// Something else holds the port.
    Foreign,
    /// Nothing is listening, and the child has reported its own exit.
    Gone,
    /// The listener could not be identified.
    Unknown,
}

async fn confirm(proxy: &ProxyClient, child_pid: u32, watch: &sidecar::SidecarWatch) -> Ownership {
    match proxy.identify().await {
        Ok(identity) if identity.pid == child_pid => Ownership::Ours,
        Ok(_) => Ownership::Foreign,
        Err(error) if error.is_unreachable() => {
            // Nothing is listening. That is only proof the child is gone if the child said so.
            if watch.exit().is_some() {
                Ownership::Gone
            } else {
                Ownership::Unknown
            }
        }
        Err(_) => Ownership::Unknown,
    }
}

fn hide_windows(app: &AppHandle) {
    for window in app.webview_windows().values() {
        window::hide(window);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decide, DrainVerdict, ExitCoordinator, ExitDecision, ExitPhase, ExitReason,
        RestartReadiness,
    };
    use crate::tray_availability::TrayAvailability;

    #[test]
    fn a_bare_gesture_hides_when_there_is_a_tray_to_come_back_from() {
        assert_eq!(decide(ExitPhase::Idle, None, true), ExitDecision::Hide);
    }

    #[test]
    fn a_bare_gesture_quits_through_the_drain_when_there_is_no_tray() {
        assert_eq!(
            decide(ExitPhase::Idle, None, false),
            ExitDecision::Drain(ExitReason::UserQuit)
        );
    }

    #[test]
    fn an_explicit_quit_drains_even_though_a_tray_exists() {
        assert_eq!(
            decide(ExitPhase::Idle, Some(ExitReason::UserQuit), true),
            ExitDecision::Drain(ExitReason::UserQuit)
        );
    }

    #[test]
    fn every_in_flight_phase_holds_the_exit() {
        for phase in [
            ExitPhase::Spawning,
            ExitPhase::Stopping,
            ExitPhase::Draining,
        ] {
            assert_eq!(
                decide(phase, Some(ExitReason::UserQuit), true),
                ExitDecision::Wait
            );
            assert_eq!(decide(phase, None, false), ExitDecision::Wait);
        }
    }

    #[test]
    fn only_a_reported_drain_lets_the_process_end() {
        assert_eq!(
            decide(ExitPhase::Drained, Some(ExitReason::UserQuit), true),
            ExitDecision::Proceed
        );
    }

    #[test]
    fn a_quit_tolerates_a_failed_drain_and_a_restart_refuses_it() {
        for phase in [ExitPhase::DrainFailed, ExitPhase::OwnershipUnknown] {
            assert_eq!(
                decide(phase, Some(ExitReason::UserQuit), true),
                ExitDecision::Proceed
            );
            assert_eq!(
                decide(phase, Some(ExitReason::CoordinatedRestart), true),
                ExitDecision::Refuse
            );
        }
    }

    #[test]
    fn a_failed_drain_is_not_recorded_as_a_drain() {
        let coordinator = ExitCoordinator::new();
        coordinator.claim_drain(ExitReason::CoordinatedRestart);
        coordinator.finish_drain(DrainVerdict::Failed);
        assert_eq!(coordinator.phase(), ExitPhase::DrainFailed);
        // The restart that asked for it does not get to proceed on that.
        assert_eq!(coordinator.decision(), ExitDecision::Refuse);
    }

    #[test]
    fn an_unidentified_runtime_is_its_own_state() {
        let coordinator = ExitCoordinator::new();
        coordinator.claim_drain(ExitReason::CoordinatedRestart);
        coordinator.finish_drain(DrainVerdict::OwnershipUnknown);
        assert_eq!(coordinator.phase(), ExitPhase::OwnershipUnknown);
        assert_eq!(coordinator.decision(), ExitDecision::Refuse);
    }

    #[test]
    fn a_refused_restart_can_be_tried_again() {
        let coordinator = ExitCoordinator::new();
        coordinator.claim_drain(ExitReason::CoordinatedRestart);
        coordinator.finish_drain(DrainVerdict::Failed);
        // The update stayed pending, so pressing Install again runs the stop again rather than
        // finding the app permanently unable to try.
        assert_eq!(
            coordinator.claim_drain(ExitReason::CoordinatedRestart),
            Some(ExitReason::CoordinatedRestart)
        );
        assert_eq!(coordinator.phase(), ExitPhase::Draining);
        coordinator.finish_drain(DrainVerdict::Drained);
        assert_eq!(coordinator.decision(), ExitDecision::Proceed);
    }

    #[test]
    fn a_successful_drain_is_not_re_entered() {
        let coordinator = ExitCoordinator::new();
        coordinator.claim_drain(ExitReason::UserQuit);
        coordinator.finish_drain(DrainVerdict::Drained);
        assert_eq!(coordinator.claim_drain(ExitReason::UserQuit), None);
    }

    #[test]
    fn the_first_claimed_reason_wins_the_drain() {
        let coordinator = ExitCoordinator::new();
        coordinator.claim(ExitReason::UserQuit);
        assert_eq!(
            coordinator.claim_drain(ExitReason::CoordinatedRestart),
            Some(ExitReason::UserQuit)
        );
        assert_eq!(coordinator.phase(), ExitPhase::Draining);
    }

    #[test]
    fn only_one_caller_owns_the_drain() {
        let coordinator = ExitCoordinator::new();
        assert_eq!(
            coordinator.claim_drain(ExitReason::UserQuit),
            Some(ExitReason::UserQuit)
        );
        assert_eq!(coordinator.claim_drain(ExitReason::UserQuit), None);
        coordinator.finish_drain(DrainVerdict::Drained);
        assert_eq!(coordinator.phase(), ExitPhase::Drained);
        assert_eq!(coordinator.claim_drain(ExitReason::UserQuit), None);
    }

    #[test]
    fn a_stop_and_a_spawn_both_hold_the_runtime_alone() {
        for begin in [ExitPhase::Spawning, ExitPhase::Stopping] {
            let coordinator = ExitCoordinator::new();
            let started = match begin {
                ExitPhase::Spawning => coordinator.begin_spawn(),
                _ => coordinator.begin_stop(),
            };
            assert!(started);
            assert!(!coordinator.begin_spawn());
            assert!(!coordinator.begin_stop());
            assert_eq!(coordinator.decision(), ExitDecision::Wait);
        }
    }

    #[test]
    fn a_quit_during_a_stop_is_deferred_rather_than_lost() {
        let coordinator = ExitCoordinator::new();
        assert!(coordinator.begin_stop());
        assert_eq!(coordinator.claim_drain(ExitReason::UserQuit), None);
        assert_eq!(coordinator.phase(), ExitPhase::Stopping);
        assert_eq!(coordinator.finish_stop(), Some(ExitReason::UserQuit));
        assert_eq!(coordinator.phase(), ExitPhase::Draining);
        assert_eq!(coordinator.finish_stop(), None);
    }

    #[test]
    fn a_quit_during_a_spawn_is_deferred_rather_than_lost() {
        let coordinator = ExitCoordinator::new();
        assert!(coordinator.begin_spawn());
        assert_eq!(coordinator.decision(), ExitDecision::Wait);
        assert_eq!(coordinator.claim_drain(ExitReason::UserQuit), None);
        assert_eq!(coordinator.finish_spawn(), Some(ExitReason::UserQuit));
        assert_eq!(coordinator.phase(), ExitPhase::Draining);
    }

    #[test]
    fn a_deferred_update_restart_keeps_its_own_reason() {
        let coordinator = ExitCoordinator::new();
        assert!(coordinator.begin_spawn());
        assert_eq!(
            coordinator.claim_drain(ExitReason::CoordinatedRestart),
            None
        );
        assert_eq!(
            coordinator.finish_spawn(),
            Some(ExitReason::CoordinatedRestart)
        );
    }

    #[test]
    fn an_undrained_runtime_is_never_reported_as_ready_to_install_over() {
        assert_eq!(RestartReadiness::Ready.describe(), "the runtime is stopped");
        for refused in [
            RestartReadiness::DrainFailed,
            RestartReadiness::OwnershipUnknown,
            RestartReadiness::Busy,
        ] {
            assert_ne!(refused, RestartReadiness::Ready);
            assert!(!refused.describe().is_empty());
        }
    }

    #[test]
    fn the_tray_verdict_replaces_the_platform_assumption() {
        let coordinator = ExitCoordinator::new();
        assert_eq!(
            coordinator.hides_to_tray(),
            TrayAvailability::assumed().hides_to_tray()
        );
        coordinator.set_tray(TrayAvailability::Unavailable);
        assert!(!coordinator.hides_to_tray());
        assert_eq!(
            coordinator.decision(),
            ExitDecision::Drain(ExitReason::UserQuit)
        );
        coordinator.set_tray(TrayAvailability::Available);
        assert_eq!(coordinator.decision(), ExitDecision::Hide);
    }
}
