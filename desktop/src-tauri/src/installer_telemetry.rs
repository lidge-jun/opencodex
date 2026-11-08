//! The Windows installer's "Send anonymous usage statistics" choice.
//!
//! SignPath Foundation's conditions require software that sends usage data to include an
//! installation option that disables it. The MSI page generated into
//! `desktop/src-tauri/wix/telemetry-choice.wxs` records the choice machine-wide under
//! `HKLM\Software\OpenCodex\Telemetry`: `InstallerChoice` (`send` or `optout`) and
//! `InstallerChoiceStamp` (when it was chosen). HKLM is what makes a silent install run as SYSTEM
//! (Intune, SCCM) reach the people who later use the app; an upgrade carries the previous choice and
//! stamp forward.
//!
//! Before the app resolves, attaches to or starts a proxy, this module carries an opt-out into the
//! current user's opencodex config by running the bundled `ocx telemetry disable`, which persists
//! `telemetry.decision = "declined"` (on a fresh install it is held without creating `config.json`).
//! The applied stamp is then recorded in that user's `HKCU\Software\OpenCodex\Telemetry`, so each
//! opt-out applies once per user and a later dashboard choice is never overridden. A new install that
//! carries an opt-out has a new stamp and applies again; that is a person or an administrator
//! choosing again.
//!
//! When the decline could not be persisted, a sidecar this app starts runs with
//! `OCX_TELEMETRY=0`, and the save is retried in the background (`RETRY_DELAYS`) and again on the
//! next launch. A proxy this app only attaches to was started elsewhere with its own environment;
//! it follows the saved decline once a retry succeeds (it re-reads the config on every tick).
//!
//! An MSI install does not put `ocx.exe` on PATH; the terminal command is installed by this app.
//! The app therefore runs before any proxy from that install can.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tokio::time::{timeout_at, Instant};

// Read and written only on Windows; the names are pinned against the WiX fragment by a test.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const REGISTRY_KEY: &str = r"Software\OpenCodex\Telemetry";
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const REGISTRY_VALUE: &str = "InstallerChoice";
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const STAMP_VALUE: &str = "InstallerChoiceStamp";
/// Written by this app under HKCU: the stamp of the last installer opt-out applied for this user.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const APPLIED_STAMP_VALUE: &str = "AppliedInstallerStamp";
pub const OPT_OUT: &str = "optout";

static SIDECAR_ENV_OPT_OUT: AtomicBool = AtomicBool::new(false);

/// The opt-out step's own budget, so a slow first `ocx` start cannot use up the startup deadline.
const STEP_CAP: Duration = Duration::from_secs(10);
/// Background retries after a failed save, so an attached proxy does not keep its old setting.
pub const RETRY_DELAYS: [Duration; 4] = [
    Duration::from_secs(10),
    Duration::from_secs(30),
    Duration::from_secs(120),
    Duration::from_secs(600),
];
const RETRY_TIMEOUT: Duration = Duration::from_secs(30);

/// The machine-wide choice the installer recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallerChoice {
    pub choice: String,
    pub stamp: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No opt-out is pending for this user: no choice, `send`, or one already applied.
    NothingPending,
    /// The decline is in the user's config and its stamp is recorded for this user.
    Applied,
    /// The decline is in the config, but the stamp could not be recorded; the next launch re-applies it.
    AppliedUnmarked,
    /// The decline could not be persisted; a sidecar this app starts runs with `OCX_TELEMETRY=0`.
    NotPersisted,
}

/// The stamp of an installer opt-out this user has not applied yet.
pub fn pending_stamp<'a>(
    choice: Option<&'a InstallerChoice>,
    applied: Option<&str>,
) -> Option<&'a str> {
    let choice = choice?;
    if !choice.choice.trim().eq_ignore_ascii_case(OPT_OUT) {
        return None;
    }
    let stamp = choice.stamp.trim();
    if applied.map(str::trim) == Some(stamp) {
        return None;
    }
    Some(stamp)
}

/// `ocx telemetry disable` exits 0 only once the decline is persisted.
pub fn decline_persisted(exit_code: Option<i32>) -> bool {
    exit_code == Some(0)
}

/// Decide what a pending opt-out leads to, given how persisting and recording its stamp went.
pub fn settle(
    pending: Option<&str>,
    persist: impl FnOnce() -> bool,
    mark_applied: impl FnOnce(&str) -> bool,
) -> Outcome {
    let Some(stamp) = pending else {
        return Outcome::NothingPending;
    };
    if !persist() {
        return Outcome::NotPersisted;
    }
    if mark_applied(stamp) {
        Outcome::Applied
    } else {
        Outcome::AppliedUnmarked
    }
}

/// Whether the sidecar this app starts must carry `OCX_TELEMETRY=0`.
pub fn sidecar_env_opt_out() -> bool {
    SIDECAR_ENV_OPT_OUT.load(Ordering::SeqCst)
}

/// Carry a pending installer opt-out into the current user's opencodex config.
pub async fn apply(app: &AppHandle, deadline: Instant) -> Outcome {
    let choice = os::read_choice();
    let applied = os::read_applied_stamp();
    let pending = pending_stamp(choice.as_ref(), applied.as_deref()).map(str::to_owned);
    let persisted = match pending {
        Some(_) => disable(app, deadline.min(Instant::now() + STEP_CAP)).await,
        None => false,
    };
    let outcome = settle(pending.as_deref(), || persisted, os::mark_applied);
    match outcome {
        Outcome::NotPersisted => {
            SIDECAR_ENV_OPT_OUT.store(true, Ordering::SeqCst);
            crate::logging::log_once(
                "the installer's telemetry opt-out could not be saved",
                "a proxy this app starts runs with OCX_TELEMETRY=0; saving is retried in the background",
            );
            if let Some(stamp) = pending {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { retry(app, stamp).await });
            }
        }
        Outcome::AppliedUnmarked => crate::logging::log_once(
            "the installer's telemetry opt-out was saved but not recorded as applied",
            "the next launch saves the decline again",
        ),
        Outcome::NothingPending | Outcome::Applied => {}
    }
    outcome
}

async fn retry(app: AppHandle, stamp: String) {
    for delay in RETRY_DELAYS {
        tokio::time::sleep(delay).await;
        if disable(&app, Instant::now() + RETRY_TIMEOUT).await {
            if !os::mark_applied(&stamp) {
                crate::logging::log_once(
                    "the installer's telemetry opt-out was saved but not recorded as applied",
                    "the next launch saves the decline again",
                );
            }
            return;
        }
    }
    crate::logging::log_once(
        "the installer's telemetry opt-out could not be saved after retries",
        "the next launch tries again; check that config.json is writable",
    );
}

async fn disable(app: &AppHandle, deadline: Instant) -> bool {
    let command = match app.shell().sidecar("ocx") {
        Ok(command) => command.args(["telemetry", "disable", "--json"]),
        Err(_) => return false,
    };
    match timeout_at(
        deadline,
        crate::process_spawn::with_spawn_async(command.output()),
    )
    .await
    {
        Ok(Ok(output)) => decline_persisted(output.status.code()),
        _ => false,
    }
}

#[cfg(target_os = "windows")]
mod os {
    use winreg::enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };
    use winreg::RegKey;

    /// The installer's machine-wide choice, from the 64-bit view first and the 32-bit view second.
    pub fn read_choice() -> Option<super::InstallerChoice> {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE)
                .open_subkey_with_flags(super::REGISTRY_KEY, KEY_READ | view)
            else {
                continue;
            };
            if let Ok(choice) = key.get_value::<String, _>(super::REGISTRY_VALUE) {
                let stamp = key
                    .get_value::<String, _>(super::STAMP_VALUE)
                    .unwrap_or_default();
                return Some(super::InstallerChoice { choice, stamp });
            }
        }
        None
    }

    pub fn read_applied_stamp() -> Option<String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(super::REGISTRY_KEY, KEY_READ)
            .ok()?
            .get_value::<String, _>(super::APPLIED_STAMP_VALUE)
            .ok()
    }

    pub fn mark_applied(stamp: &str) -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(super::REGISTRY_KEY)
            .and_then(|(key, _)| key.set_value(super::APPLIED_STAMP_VALUE, &stamp.to_owned()))
            .is_ok()
    }
}

#[cfg(not(target_os = "windows"))]
mod os {
    // Only the Windows installer records a choice.
    pub fn read_choice() -> Option<super::InstallerChoice> {
        None
    }

    pub fn read_applied_stamp() -> Option<String> {
        None
    }

    pub fn mark_applied(_stamp: &str) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{decline_persisted, pending_stamp, settle, InstallerChoice, Outcome};
    use std::cell::Cell;

    fn choice(choice: &str, stamp: &str) -> InstallerChoice {
        InstallerChoice {
            choice: choice.to_owned(),
            stamp: stamp.to_owned(),
        }
    }

    #[test]
    fn an_opt_out_is_pending_until_its_stamp_is_applied_for_this_user() {
        let opt_out = choice("optout", "11/8/2026 10:12:33");
        assert_eq!(
            pending_stamp(Some(&opt_out), None),
            Some("11/8/2026 10:12:33")
        );
        assert_eq!(
            pending_stamp(Some(&choice(" OptOut ", "s1")), Some("s0")),
            Some("s1")
        );
        assert_eq!(
            pending_stamp(Some(&opt_out), Some("11/8/2026 10:12:33")),
            None
        );
        for other in [
            choice("send", "s1"),
            choice("", "s1"),
            choice("opt-out-later", "s1"),
        ] {
            assert_eq!(pending_stamp(Some(&other), None), None, "{other:?}");
        }
        assert_eq!(pending_stamp(None, None), None);
    }

    #[test]
    fn only_a_clean_exit_counts_as_persisted() {
        assert!(decline_persisted(Some(0)));
        for code in [None, Some(1), Some(2), Some(-1)] {
            assert!(!decline_persisted(code), "{code:?}");
        }
    }

    #[test]
    fn nothing_runs_without_a_pending_opt_out() {
        let ran = Cell::new(false);
        let outcome = settle(
            None,
            || {
                ran.set(true);
                true
            },
            |_| {
                ran.set(true);
                true
            },
        );
        assert_eq!(outcome, Outcome::NothingPending);
        assert!(!ran.get());
    }

    #[test]
    fn a_stamp_is_recorded_only_after_the_decline_persisted() {
        let marked = Cell::new(None::<String>);
        assert_eq!(
            settle(
                Some("s1"),
                || false,
                |stamp| {
                    marked.set(Some(stamp.to_owned()));
                    true
                }
            ),
            Outcome::NotPersisted
        );
        assert_eq!(marked.take(), None);
        assert_eq!(
            settle(
                Some("s1"),
                || true,
                |stamp| {
                    marked.set(Some(stamp.to_owned()));
                    true
                }
            ),
            Outcome::Applied
        );
        assert_eq!(marked.take().as_deref(), Some("s1"));
        assert_eq!(
            settle(Some("s1"), || true, |_| false),
            Outcome::AppliedUnmarked
        );
    }
}
