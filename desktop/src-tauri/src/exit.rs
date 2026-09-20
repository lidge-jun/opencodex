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
        ExitPhase::Draining => ExitDecision::Wait,
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

    pub fn hides_to_tray(&self) -> bool {
        self.inner().hides_to_tray
    }

    #[cfg(test)]
    fn phase(&self) -> ExitPhase {
        self.inner().phase
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
    pub fn claim_drain(&self, fallback: ExitReason) -> Option<ExitReason> {
        let mut inner = self.inner();
        if inner.phase != ExitPhase::Idle {
            return None;
        }
        let reason = *inner.reason.get_or_insert(fallback);
        inner.phase = ExitPhase::Draining;
        Some(reason)
    }

    pub fn finish_drain(&self) {
        self.inner().phase = ExitPhase::Drained;
    }

    /// Start a runtime, but only while no exit is in flight.
    ///
    /// The lock is held across the whole closure so that spawning a child and recording that we own
    /// it cannot be split by a quit. Without that, a Quit arriving mid-startup reads "we own
    /// nothing", drains nothing, and the process exits moments after the sequence spawned a proxy
    /// that nothing will ever stop. The closure must not call back into this coordinator.
    pub fn spawn_unless_ending<T>(&self, spawn: impl FnOnce() -> T) -> Option<T> {
        let inner = self.inner();
        if inner.phase != ExitPhase::Idle {
            return None;
        }
        Some(spawn())
    }
}

impl Default for ExitCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether the current session hides to a tray rather than ending on a close.
pub fn hides_to_tray(app: &AppHandle) -> bool {
    app.try_state::<ExitCoordinator>()
        .map(|coordinator| coordinator.hides_to_tray())
        .unwrap_or_else(|| TrayAvailability::assumed().hides_to_tray())
}

/// The platform's quit gesture, and what closing the window means.
///
/// It is not a request to end. D2 makes it mean the same thing on all three platforms: hide where
/// there is a tray to come back from, and a graceful quit where there is not.
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
        assert_eq!(coordinator.spawn_unless_ending(|| 7), Some(7));
        coordinator.claim_drain(ExitReason::UserQuit);
        assert_eq!(coordinator.spawn_unless_ending(|| 7), None);
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
