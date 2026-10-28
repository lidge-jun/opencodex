//! Recovery work is narrower than the person's general wish to have a runtime.
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Default)]
enum Run {
    #[default]
    Idle,
    Starting {
        retry: bool,
    },
    Failed {
        retry: bool,
    },
    Ready {
        owned: bool,
    },
    Supervised,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    run: Run,
    reservations: usize,
}

/// One view shared by accepted startup reports and the supervisor's actual work.
#[derive(Default)]
pub struct Activity {
    inner: Mutex<Inner>,
}

impl Activity {
    pub fn begin_run(&self, generation: u64, recovering: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            if generation > inner.generation {
                inner.generation = generation;
                inner.run = Run::Starting { retry: recovering };
            }
        }
    }

    fn update_run(&self, generation: u64, update: impl FnOnce(&mut Run)) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation == generation {
                update(&mut inner.run);
            }
        }
    }

    /// Only an accepted Ready report supplies the binding's confirmed ownership.
    pub fn ready(&self, generation: u64, owned: bool) {
        self.update_run(generation, |run| {
            if matches!(run, Run::Starting { .. }) {
                *run = Run::Ready { owned };
            }
        });
    }

    /// A terminal launch failure loses credit even while its async cleanup is running.
    pub fn failed(&self, generation: u64) {
        self.update_run(generation, |run| {
            if let Run::Starting { retry } = *run {
                *run = Run::Failed { retry };
            }
        });
    }

    /// An owned child's exit during a run gives that run a real follow-up obligation.
    pub fn defer_recovery(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            match &mut inner.run {
                Run::Starting { retry } | Run::Failed { retry } => *retry = true,
                _ => {}
            }
        }
    }

    /// Failed runs finish only after their follow-up has acquired any new reservation.
    pub fn finish_run(&self, generation: u64, ready: bool) {
        self.update_run(generation, |run| {
            *run = if ready && matches!(run, Run::Ready { owned: true } | Run::Supervised) {
                Run::Supervised
            } else {
                Run::Idle
            };
        });
    }

    /// Keep the scheduled work alive across pending -> startup, including cancellation.
    pub fn reserve(self: &Arc<Self>) -> Option<Reservation> {
        let mut inner = self.inner.lock().ok()?;
        inner.reservations = inner.reservations.checked_add(1)?;
        Some(Reservation(Arc::clone(self)))
    }

    /// The exit coordinator can revoke every kind of work without waiting for its cleanup.
    pub fn recovering(&self, allowed: bool) -> bool {
        allowed
            && self.inner.lock().is_ok_and(|inner| {
                inner.reservations > 0
                    || matches!(
                        inner.run,
                        Run::Starting { .. }
                            | Run::Failed { retry: true }
                            | Run::Ready { owned: true }
                            | Run::Supervised
                    )
            })
    }
}

/// Each task releases only its own reservation, including an early return or cancellation.
pub struct Reservation(Arc<Activity>);

impl Drop for Reservation {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.0.inner.lock() {
            inner.reservations -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_accepted_start_covers_the_resolved_home_before_spawn() {
        let activity = Activity::default();
        assert!(!activity.recovering(true));
        activity.begin_run(1, false);
        assert!(activity.recovering(true));
    }

    #[test]
    fn a_terminal_launch_failure_stops_credit_before_cleanup_finishes() {
        let activity = Activity::default();
        activity.begin_run(1, false);
        assert!(activity.recovering(true));
        // Both an ordinary failure and the deadline guard publish this same transition.
        activity.failed(1);
        assert!(!activity.recovering(true));
        activity.finish_run(1, false);
        assert!(!activity.recovering(true));
    }

    #[test]
    fn guest_ready_does_not_claim_recovery_while_its_watchdog_waits() {
        let activity = Arc::new(Activity::default());
        activity.begin_run(1, false);
        activity.ready(1, false);
        assert!(!activity.recovering(true));
        activity.finish_run(1, true);
        assert!(!activity.recovering(true));
        // The guest watchdog may later schedule actual work.
        let reservation = activity.reserve().unwrap();
        assert!(activity.recovering(true));
        drop(reservation);
        assert!(!activity.recovering(true));
    }

    #[test]
    fn confirmed_own_child_attachment_stays_supervised_after_ready() {
        let activity = Arc::new(Activity::default());
        activity.begin_run(1, false);
        activity.ready(1, true);
        activity.finish_run(1, true);
        assert!(activity.recovering(true));
        // Releasing the dead child's handle cannot erase this accepted Ready ownership.
        let reservation = activity.reserve().unwrap();
        activity.begin_run(2, true);
        drop(reservation);
        assert!(activity.recovering(true));
    }

    #[test]
    fn recovery_failure_transfers_credit_through_backoff_to_the_next_run() {
        let activity = Arc::new(Activity::default());
        activity.begin_run(1, true);
        activity.failed(1);
        assert!(activity.recovering(true));
        let reservation = activity.reserve().unwrap();
        activity.finish_run(1, false);
        assert!(activity.recovering(true));
        // The timer has cleared pending, but has not called begin_with yet.
        assert!(activity.recovering(true));
        activity.begin_run(2, true);
        drop(reservation);
        assert!(activity.recovering(true));
    }

    #[test]
    fn a_deferred_owned_exit_preserves_only_the_follow_up_obligation() {
        let activity = Arc::new(Activity::default());
        activity.begin_run(1, false);
        activity.defer_recovery();
        activity.failed(1);
        assert!(activity.recovering(true));
        let reservation = activity.reserve().unwrap();
        activity.finish_run(1, false);
        assert!(activity.recovering(true));
        drop(reservation);
        assert!(!activity.recovering(true));
    }

    #[test]
    fn a_held_or_cancelled_retry_without_scheduled_work_loses_credit() {
        let activity = Activity::default();
        activity.begin_run(1, true);
        activity.failed(1);
        assert!(activity.recovering(true));
        activity.finish_run(1, false);
        assert!(!activity.recovering(true));
    }

    #[test]
    fn an_old_terminal_report_or_finalizer_cannot_clear_a_new_start() {
        let activity = Activity::default();
        activity.begin_run(1, false);
        activity.failed(1);
        activity.begin_run(2, false);
        activity.ready(1, false);
        activity.failed(1);
        activity.finish_run(1, false);
        assert!(activity.recovering(true));
        activity.ready(2, false);
        activity.begin_run(1, true);
        assert!(!activity.recovering(true));
    }

    #[test]
    fn cancelling_an_older_task_does_not_release_a_newer_reservation() {
        let activity = Arc::new(Activity::default());
        let older = activity.reserve().unwrap();
        let newer = activity.reserve().unwrap();
        drop(older);
        assert!(activity.recovering(true));
        drop(newer);
        assert!(!activity.recovering(true));
    }

    #[test]
    fn exit_revocation_overrides_startup_owned_and_reserved_work() {
        let activity = Arc::new(Activity::default());
        activity.begin_run(1, false);
        assert!(!activity.recovering(false));
        activity.ready(1, true);
        activity.finish_run(1, true);
        assert!(!activity.recovering(false));
        let _reservation = activity.reserve().unwrap();
        activity.begin_run(2, true);
        activity.failed(2);
        assert!(!activity.recovering(false));
    }
}
