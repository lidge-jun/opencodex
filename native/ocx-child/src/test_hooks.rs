//! Env-gated synchronization points used by process-level lifecycle tests.
//!
//! Compiled only with `debug_assertions` (the profile `cargo test` builds the binary with);
//! a release build has no barrier and reads no barrier environment variable.
//!
//! Every call is a no-op unless both `OCX_CHILD_TEST_BARRIER_DIR` and
//! `OCX_CHILD_TEST_BARRIERS` are set. When the current point is listed, the process writes
//! `<dir>/<name>.reached` (containing its PID) and waits until `<dir>/<name>.release` exists,
//! for at most 60 seconds. A point whose release file already exists passes immediately, so
//! a point reached repeatedly blocks only once.

#[cfg(debug_assertions)]
pub const BARRIER_DIR_ENV: &str = "OCX_CHILD_TEST_BARRIER_DIR";
#[cfg(debug_assertions)]
pub const BARRIERS_ENV: &str = "OCX_CHILD_TEST_BARRIERS";

#[cfg(debug_assertions)]
pub fn barrier(name: &str) {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    let Some(dir) = std::env::var_os(BARRIER_DIR_ENV).filter(|v| !v.is_empty()) else {
        return;
    };
    let Ok(list) = std::env::var(BARRIERS_ENV) else {
        return;
    };
    if !list.split(',').any(|entry| entry.trim() == name) {
        return;
    }
    let dir = PathBuf::from(dir);
    let release = dir.join(format!("{name}.release"));
    if release.exists() {
        return;
    }
    let _ = std::fs::write(
        dir.join(format!("{name}.reached")),
        std::process::id().to_string(),
    );
    let deadline = Instant::now() + Duration::from_secs(60);
    while !release.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(not(debug_assertions))]
#[inline(always)]
pub fn barrier(_name: &str) {}

/// Keep a spawned relay from inheriting the barrier configuration of its lifecycle parent.
#[cfg(debug_assertions)]
pub fn strip_barrier_env(cmd: &mut std::process::Command) {
    cmd.env_remove(BARRIER_DIR_ENV).env_remove(BARRIERS_ENV);
}

#[cfg(not(debug_assertions))]
#[inline(always)]
pub fn strip_barrier_env(_cmd: &mut std::process::Command) {}
