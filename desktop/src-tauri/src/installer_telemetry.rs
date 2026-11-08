//! The Windows installer's "Send anonymous usage statistics" choice.
//!
//! SignPath Foundation's conditions require software that sends usage data to include an
//! installation option that disables it. The MSI dialog generated into
//! `desktop/src-tauri/wix/telemetry-choice.wxs` records the person's choice under
//! `HKCU\Software\OpenCodex\Telemetry\InstallerChoice`. Before the app resolves, attaches to or
//! starts a proxy, this module carries an opt-out into the user's opencodex config by running the
//! bundled `ocx telemetry disable`, which persists `telemetry.decision = "declined"`. The value is
//! then rewritten to `applied`, so a later choice made in the dashboard is never overridden.
//!
//! When the decline could not be persisted, the sidecar this app starts runs with
//! `OCX_TELEMETRY=0`, so nothing is sent in that session, and the next launch tries again.
//!
//! An MSI install does not put `ocx.exe` on PATH; the terminal command is installed by this app.
//! The app therefore runs before any proxy from that install can.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;
use tokio::time::{timeout_at, Instant};

// Read and written only on Windows; the names are pinned against the WiX fragment by a test.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const REGISTRY_KEY: &str = r"Software\OpenCodex\Telemetry";
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const REGISTRY_VALUE: &str = "InstallerChoice";
pub const OPT_OUT: &str = "optout";
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const APPLIED: &str = "applied";

static SIDECAR_ENV_OPT_OUT: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No opt-out is pending: no value, `send`, or one that was already applied.
    NothingPending,
    /// The decline is in the user's config and the registry value now reads `applied`.
    Applied,
    /// The decline is in the config, but the registry value could not be rewritten.
    AppliedUnmarked,
    /// The decline could not be persisted; this session's sidecar runs with `OCX_TELEMETRY=0`.
    NotPersisted,
}

/// Whether a recorded installer choice still has to be carried into the config.
pub fn is_pending_opt_out(value: Option<&str>) -> bool {
    value.is_some_and(|value| value.trim().eq_ignore_ascii_case(OPT_OUT))
}

/// `ocx telemetry disable` exits 0 only once the decline is persisted.
pub fn decline_persisted(exit_code: Option<i32>) -> bool {
    exit_code == Some(0)
}

/// Decide what a pending choice leads to, given how persisting and marking went.
pub fn settle(
    value: Option<&str>,
    persist: impl FnOnce() -> bool,
    mark_applied: impl FnOnce() -> bool,
) -> Outcome {
    if !is_pending_opt_out(value) {
        return Outcome::NothingPending;
    }
    if !persist() {
        return Outcome::NotPersisted;
    }
    if mark_applied() {
        Outcome::Applied
    } else {
        Outcome::AppliedUnmarked
    }
}

/// Whether the sidecar this app starts must carry `OCX_TELEMETRY=0`.
pub fn sidecar_env_opt_out() -> bool {
    SIDECAR_ENV_OPT_OUT.load(Ordering::SeqCst)
}

/// Carry a pending installer opt-out into the user's opencodex config.
pub async fn apply(app: &AppHandle, deadline: Instant) -> Outcome {
    let value = os::read();
    let persisted = if is_pending_opt_out(value.as_deref()) {
        disable(app, deadline).await
    } else {
        false
    };
    let outcome = settle(value.as_deref(), || persisted, os::mark_applied);
    match outcome {
        Outcome::NotPersisted => {
            SIDECAR_ENV_OPT_OUT.store(true, Ordering::SeqCst);
            crate::logging::log_once(
                "the installer's telemetry opt-out could not be saved",
                "this session runs with OCX_TELEMETRY=0 and the next launch tries again",
            );
        }
        Outcome::AppliedUnmarked => crate::logging::log_once(
            "the installer's telemetry opt-out was saved but not marked as applied",
            "the next launch saves the decline again",
        ),
        Outcome::NothingPending | Outcome::Applied => {}
    }
    outcome
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
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    pub fn read() -> Option<String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(super::REGISTRY_KEY, KEY_READ)
            .ok()?
            .get_value::<String, _>(super::REGISTRY_VALUE)
            .ok()
    }

    pub fn mark_applied() -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(super::REGISTRY_KEY, KEY_SET_VALUE)
            .and_then(|key| key.set_value(super::REGISTRY_VALUE, &super::APPLIED.to_owned()))
            .is_ok()
    }
}

#[cfg(not(target_os = "windows"))]
mod os {
    // Only the Windows installer records a choice.
    pub fn read() -> Option<String> {
        None
    }

    pub fn mark_applied() -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{decline_persisted, is_pending_opt_out, settle, Outcome};
    use std::cell::Cell;

    #[test]
    fn only_a_recorded_opt_out_is_pending() {
        assert!(is_pending_opt_out(Some("optout")));
        assert!(is_pending_opt_out(Some(" OptOut ")));
        for value in [
            None,
            Some(""),
            Some("send"),
            Some("applied"),
            Some("opt-out-later"),
        ] {
            assert!(!is_pending_opt_out(value), "{value:?}");
        }
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
        for value in [None, Some("send"), Some("applied")] {
            let ran = Cell::new(false);
            let outcome = settle(
                value,
                || {
                    ran.set(true);
                    true
                },
                || {
                    ran.set(true);
                    true
                },
            );
            assert_eq!(outcome, Outcome::NothingPending);
            assert!(!ran.get(), "{value:?}");
        }
    }

    #[test]
    fn an_opt_out_is_marked_only_after_the_decline_persisted() {
        let marked = Cell::new(false);
        assert_eq!(
            settle(
                Some("optout"),
                || false,
                || {
                    marked.set(true);
                    true
                }
            ),
            Outcome::NotPersisted
        );
        assert!(!marked.get());
        assert_eq!(settle(Some("optout"), || true, || true), Outcome::Applied);
        assert_eq!(
            settle(Some("optout"), || true, || false),
            Outcome::AppliedUnmarked
        );
    }
}
