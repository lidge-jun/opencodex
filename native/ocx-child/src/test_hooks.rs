//! Env-gated synchronization points used by process-level lifecycle tests.
//!
//! Every call is a no-op unless both `OCX_CHILD_TEST_BARRIER_DIR` and
//! `OCX_CHILD_TEST_BARRIERS` are set. When the current point is listed, the process writes
//! `<dir>/<name>.reached` (containing its PID) and waits until `<dir>/<name>.release` exists,
//! for at most 60 seconds. A point whose release file already exists passes immediately, so
//! a point reached repeatedly blocks only once.

use std::path::PathBuf;
use std::time::{Duration, Instant};

pub const BARRIER_DIR_ENV: &str = "OCX_CHILD_TEST_BARRIER_DIR";
pub const BARRIERS_ENV: &str = "OCX_CHILD_TEST_BARRIERS";

pub fn barrier(name: &str) {
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
