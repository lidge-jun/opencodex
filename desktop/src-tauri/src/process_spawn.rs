//! Keep Unix forks from inheriting a writable descriptor for a soon-to-be-published executable.
//! CLOEXEC only closes it at exec; closing the parent's copy does not close a child's copy.

// A queued writer must not block another spawner: a plugin launcher can wait for the main
// thread, where a second launcher may run. std::RwLock may prefer the queued writer and deadlock
// those two readers. Use reader preference; only an active writer excludes process creation.
#[cfg(unix)]
static EXECUTABLE_IO: Gate = Gate::new();

#[cfg(unix)]
struct Gate {
    access: std::sync::Mutex<Access>,
    changed: std::sync::Condvar,
}

#[cfg(unix)]
struct Access {
    spawners: usize,
    writing: bool,
}

#[cfg(unix)]
struct Guard<'a> {
    gate: &'a Gate,
    writing: bool,
}

#[cfg(unix)]
impl Gate {
    const fn new() -> Self {
        Self {
            access: std::sync::Mutex::new(Access {
                spawners: 0,
                writing: false,
            }),
            changed: std::sync::Condvar::new(),
        }
    }

    fn access(&self) -> std::sync::MutexGuard<'_, Access> {
        self.access
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn acquire(&self, writing: bool) -> Guard<'_> {
        let mut access = self
            .changed
            .wait_while(self.access(), |s| s.writing || (writing && s.spawners != 0))
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if writing {
            access.writing = true;
        } else {
            access.spawners += 1;
        }
        Guard {
            gate: self,
            writing,
        }
    }
}

#[cfg(unix)]
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        let mut access = self.gate.access();
        if self.writing {
            access.writing = false;
        } else {
            access.spawners -= 1;
        }
        self.gate.changed.notify_all();
    }
}

#[cfg(unix)]
pub(crate) fn executable_write() -> impl Drop {
    EXECUTABLE_IO.acquire(true)
}

/// Cover process creation through exec, not the subsequent wait for the child's exit.
/// Never request an executable writer from a spawner, or call this from a writer/pre_exec hook.
pub(crate) fn with_spawn<T>(spawn: impl FnOnce() -> T) -> T {
    #[cfg(unix)]
    let _guard = EXECUTABLE_IO.acquire(false);
    spawn()
}

/// The pinned shell plugin's output future spawns synchronously when polled. Guard each poll
/// so creation is covered even for a lazy future; release before Pending, never across await.
pub(crate) async fn with_spawn_async<F: std::future::Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    std::future::poll_fn(|cx| with_spawn(|| future.as_mut().poll(cx))).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        future::{poll_fn, Future},
        sync::{mpsc, Arc},
        task::{Context, Poll, Waker},
        time::Duration,
    };

    #[test]
    fn a_spawn_waits_for_the_writer_and_releases_before_child_exit() {
        let writer = executable_write();
        let (started_tx, started_rx) = mpsc::channel();
        let (spawned_tx, spawned_rx) = mpsc::channel();
        let spawner = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let child = with_spawn(|| {
                std::process::Command::new("/bin/cat")
                    .stdin(std::process::Stdio::piped())
                    .spawn()
            });
            spawned_tx.send(child).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let early = spawned_rx.recv_timeout(Duration::from_millis(100));
        drop(writer);
        let mut child = match early {
            Err(mpsc::RecvTimeoutError::Timeout) => spawned_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap(),
            Ok(Ok(mut child)) => {
                drop(child.stdin.take());
                let _ = child.wait();
                panic!("spawn overlapped an executable writer");
            }
            _ => panic!("spawn failed before the writer was released"),
        };
        spawner.join().unwrap();
        // cat is still waiting for EOF, but executable publication must already be unblocked.
        let writer = executable_write();
        assert!(child.try_wait().unwrap().is_none());
        drop(writer);
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn queued_writer_does_not_block_a_launchers_main_thread_callback() {
        // An independent instance of the production gate keeps unrelated fixture/spawn stress
        // from consuming this scheduling test's deadline.
        let gate = Arc::new(Gate::new());
        let launcher = gate.acquire(false);
        let writer_gate = gate.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let _writer = writer_gate.acquire(true);
            done_tx.send(()).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        // Model an install helper waiting for a main-thread callback that launches a URL.
        let callback = gate.acquire(false);
        assert_eq!(gate.access().spawners, 2);
        drop(callback);
        drop(launcher);
        done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        writer.join().unwrap();
    }

    #[test]
    fn async_spawn_is_guarded_on_poll_without_holding_a_lock_across_pending() {
        let mut polled = false;
        let future = with_spawn_async(poll_fn(|_| {
            assert!(
                EXECUTABLE_IO.access().spawners > 0,
                "async spawn poll must hold shared access"
            );
            if polled {
                Poll::Ready(42)
            } else {
                polled = true;
                Poll::Pending
            }
        }));
        fn assert_send(_: &impl Send) {}
        assert_send(&future);
        let mut future = std::pin::pin!(future);
        let mut cx = Context::from_waker(Waker::noop());
        assert_eq!(future.as_mut().poll(&mut cx), Poll::Pending);
        // A paused output reader cannot stop a reconcile from writing its shim.
        drop(executable_write());
        assert_eq!(future.as_mut().poll(&mut cx), Poll::Ready(42));
    }

    #[test]
    fn failed_spawns_release_the_guard() {
        let result = with_spawn(|| std::process::Command::new("/ocx-missing-executable").spawn());
        assert!(result.is_err());
        drop(executable_write());
    }
}
