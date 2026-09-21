//! Who is allowed to end the process, and what has to happen first.
//!
//! Three gestures arrive looking like an exit: closing the window, the platform's own quit gesture
//! (Cmd+Q on macOS, Alt+F4 on Windows, the window manager's close on Linux), and the tray's Quit
//! item. Only the last one means "end the runtime". Until this module existed the shell had no
//! `ExitRequested` handler at all, so the quit gesture went straight to `RunEvent::Exit`, which
//! called `CommandChild::kill()` — a SIGKILL on Unix — on a keystroke the user reads as "hide".
//!
//! Tauri separates a user gesture from a programmatic exit: `RunEvent::ExitRequested` carries
//! `code: None` for the gesture and `Some(_)` for `AppHandle::exit` or `AppHandle::restart`. What
//! it cannot tell apart is the tray's Quit from an update's restart, and those end differently: a
//! quit stops the runtime and stays stopped, an update restart runs the same drain and comes back.
//! [`ExitReason`] records which one asked. macOS needs one more thing on top, because its menu
//! Quit never raises the event at all; see [`crate::menu`].
//!
//! The drain cannot run inside the event handler — it is asynchronous and can take seconds — so
//! every path funnels through one three-step phase: hold the exit, drain, ask again. The phase, the
//! reason and the permission to start a runtime all live under one lock, because they are one
//! decision: a quit that lands while the startup sequence is spawning must not leave the spawned
//! process behind.

use crate::{sidecar, tray_availability::TrayAvailability, window, AppState};
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

/// How far the one drain-and-exit sequence has got.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitPhase {
    /// Nothing is in flight.
    Idle,
    /// A runtime is being started. An exit arriving now is held until the child exists and is
    /// recorded, because the alternative is a process nobody owns and nobody will stop.
    Spawning,
    /// The drain is running. Further exit requests wait for it rather than starting a second one.
    Draining,
    /// The drain has reported. The next exit request is the real one.
    Drained,
}

/// What the event loop should do with an exit request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitDecision {
    /// Nothing asked the app to end and there is a tray to come back from: hide instead.
    Hide,
    /// Hold the exit and drain for this reason; the exit is requested again when the drain reports.
    Drain(ExitReason),
    /// A drain is already running. Hold the exit and let that one finish.
    Wait,
    /// The drain has reported. Let the process end.
    Proceed,
}

/// Decide what an exit request means.
///
/// `reason` is what the app itself asked for and is `None` for a bare user gesture.
/// `hides_to_tray` is D6: on a session with no usable tray there is nowhere to hide, so a close is
/// a quit and takes the same graceful drain rather than leaving a running process unreachable.
pub fn decide(phase: ExitPhase, reason: Option<ExitReason>, hides_to_tray: bool) -> ExitDecision {
    match phase {
        ExitPhase::Spawning | ExitPhase::Draining => ExitDecision::Wait,
        ExitPhase::Drained => ExitDecision::Proceed,
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
    /// An exit that arrived while a runtime was being started, and still has to happen.
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

    /// Record the session's tray verdict once the probe has answered.
    pub fn set_tray(&self, tray: TrayAvailability) {
        self.inner().hides_to_tray = tray.hides_to_tray();
    }

    #[cfg(test)]
    fn phase(&self) -> ExitPhase {
        self.inner().phase
    }

    #[cfg(test)]
    fn hides_to_tray(&self) -> bool {
        self.inner().hides_to_tray
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
    /// While a runtime is being started the answer is "not yet": the reason is recorded and the
    /// drain is handed to [`ExitCoordinator::finish_spawn`], which runs once the child is ours.
    pub fn claim_drain(&self, fallback: ExitReason) -> Option<ExitReason> {
        let mut inner = self.inner();
        match inner.phase {
            ExitPhase::Idle => {
                let reason = *inner.reason.get_or_insert(fallback);
                inner.phase = ExitPhase::Draining;
                Some(reason)
            }
            ExitPhase::Spawning => {
                inner.reason.get_or_insert(fallback);
                inner.deferred = true;
                None
            }
            ExitPhase::Draining | ExitPhase::Drained => None,
        }
    }

    pub fn finish_drain(&self) {
        self.inner().phase = ExitPhase::Drained;
    }

    /// Reserve the right to start a runtime. False once an exit is in flight.
    ///
    /// The reservation exists instead of holding the lock across the spawn. Holding it would make
    /// the main thread's exit handler wait on process creation, so a wedged spawn would be a Quit
    /// that never responds. Reserving instead keeps every lock hold short, and an exit arriving in
    /// between is deferred rather than lost — which is the thing that must not happen, because a
    /// quit that reads "we own nothing" leaves the child it just missed running forever.
    pub fn begin_spawn(&self) -> bool {
        let mut inner = self.inner();
        if inner.phase != ExitPhase::Idle {
            return false;
        }
        inner.phase = ExitPhase::Spawning;
        true
    }

    /// Release the reservation. Returns the reason to drain for when an exit arrived meanwhile.
    pub fn finish_spawn(&self) -> Option<ExitReason> {
        let mut inner = self.inner();
        if inner.phase != ExitPhase::Spawning {
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
        ExitDecision::Wait | ExitDecision::Proceed => {}
    }
}

/// Ask the app to end for a stated reason. This is the only way the shell ends itself.
pub fn request(app: &AppHandle, reason: ExitReason) {
    if let Some(coordinator) = app.try_state::<ExitCoordinator>() {
        coordinator.claim(reason);
    }
    app.exit(0);
}

/// Ask the app to drain and come back, which is what an installed update needs.
///
/// This does not go through [`request`]. `AppHandle::restart` ignores `prevent_exit`, so the event
/// loop cannot hold a restart long enough to drain inside it; the drain has to happen first and
/// issue the restart itself, which is what [`start_drain`] does for this reason.
pub fn request_restart(app: &AppHandle) {
    if let Some(coordinator) = app.try_state::<ExitCoordinator>() {
        coordinator.claim(ExitReason::CoordinatedRestart);
    }
    start_drain(app, ExitReason::CoordinatedRestart);
}

/// Handle `RunEvent::ExitRequested`.
pub fn on_exit_requested(app: &AppHandle, code: Option<i32>, api: &ExitRequestApi) {
    // `AppHandle::restart` documents that `prevent_exit` is ignored for its own exit code, so a
    // restart cannot be held here even to drain. The updater therefore drains before it restarts,
    // and this branch only records the reason so nothing downstream reads the restart as a quit.
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
        ExitDecision::Drain(reason) => {
            api.prevent_exit();
            start_drain(app, reason);
        }
        ExitDecision::Proceed => {}
    }
}

/// Drain an app-owned runtime and then ask to end again.
///
/// Nothing kills the child. The old path did, with `CommandChild::kill()`, and that is a SIGKILL on
/// Unix: it cut off the in-flight requests, the client-configuration restore and the state-file
/// clearing that the CLI's own stop performs.
///
/// A drain that does not complete is reported and the exit still proceeds. That is a deliberate
/// trade and it has a cost: the runtime this app started can outlive it. The alternative is
/// refusing to quit when the user asked to, on a window that is showing the dashboard and has
/// nowhere to explain itself, and a runtime left standing is recoverable with `ocx stop` while a
/// half-restored client configuration is not.
pub fn start_drain(app: &AppHandle, reason: ExitReason) {
    let Some(coordinator) = app.try_state::<ExitCoordinator>() else {
        return;
    };
    let Some(reason) = coordinator.claim_drain(reason) else {
        return;
    };
    drain_now(app, reason);
}

/// Run the drain for a reason the coordinator has already been moved to draining for.
///
/// The only other caller is the startup sequence, which reaches draining through
/// [`ExitCoordinator::finish_spawn`] when a quit arrived while it was starting a runtime.
pub fn drain_now(app: &AppHandle, reason: ExitReason) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let owned = app
            .try_state::<AppState>()
            .map(|state| (state.proxy(), state.owns_runtime(), state.watch.clone()));
        if let Some((Some(proxy), owned, watch)) = owned {
            let outcome = sidecar::drain(&proxy, owned, &watch).await;
            match outcome.failure() {
                None => {
                    if let Some(state) = app.try_state::<AppState>() {
                        state.release();
                    }
                }
                Some(error) => crate::logging::log_once("graceful stop did not complete", &error),
            }
        }
        if let Some(coordinator) = app.try_state::<ExitCoordinator>() {
            coordinator.finish_drain();
        }
        match reason {
            ExitReason::UserQuit => app.exit(0),
            ExitReason::CoordinatedRestart => app.restart(),
        }
    });
}

fn hide_windows(app: &AppHandle) {
    for window in app.webview_windows().values() {
        window::hide(window);
    }
}

#[cfg(test)]
mod tests {
    use super::{decide, ExitCoordinator, ExitDecision, ExitPhase, ExitReason};
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
    fn an_update_restart_keeps_its_own_reason_through_the_drain() {
        assert_eq!(
            decide(ExitPhase::Idle, Some(ExitReason::CoordinatedRestart), true),
            ExitDecision::Drain(ExitReason::CoordinatedRestart)
        );
    }

    #[test]
    fn a_second_request_waits_instead_of_starting_a_second_drain() {
        for hides in [true, false] {
            assert_eq!(
                decide(ExitPhase::Draining, Some(ExitReason::UserQuit), hides),
                ExitDecision::Wait
            );
            assert_eq!(decide(ExitPhase::Draining, None, hides), ExitDecision::Wait);
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
        coordinator.finish_drain();
        assert_eq!(coordinator.phase(), ExitPhase::Drained);
        assert_eq!(coordinator.claim_drain(ExitReason::UserQuit), None);
    }

    #[test]
    fn a_runtime_is_not_started_once_an_exit_is_in_flight() {
        let coordinator = ExitCoordinator::new();
        assert!(coordinator.begin_spawn());
        assert_eq!(coordinator.finish_spawn(), None);
        assert_eq!(coordinator.phase(), ExitPhase::Idle);
        coordinator.claim_drain(ExitReason::UserQuit);
        assert!(!coordinator.begin_spawn());
    }

    #[test]
    fn a_quit_during_a_spawn_is_deferred_rather_than_lost() {
        let coordinator = ExitCoordinator::new();
        assert!(coordinator.begin_spawn());
        // The exit handler holds the exit rather than letting the process end mid-spawn.
        assert_eq!(coordinator.decision(), ExitDecision::Wait);
        assert_eq!(coordinator.claim_drain(ExitReason::UserQuit), None);
        assert_eq!(coordinator.phase(), ExitPhase::Spawning);
        // The child is ours by now, so the deferred quit becomes the drain.
        assert_eq!(coordinator.finish_spawn(), Some(ExitReason::UserQuit));
        assert_eq!(coordinator.phase(), ExitPhase::Draining);
        assert_eq!(coordinator.finish_spawn(), None);
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
