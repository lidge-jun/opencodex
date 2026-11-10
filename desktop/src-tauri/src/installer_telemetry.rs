//! The Windows installer's "Send anonymous usage statistics" choice.
//!
//! SignPath Foundation's conditions require software that sends usage data to include an
//! installation option that disables it. The MSI page generated into
//! `desktop/src-tauri/wix/telemetry-choice.wxs` records the choice machine-wide under
//! `HKLM\Software\OpenCodex\Telemetry`: `InstallerChoice` (`send` or `optout`) and
//! `InstallerChoiceStamp` (when it was chosen). HKLM is what makes a silent install run as SYSTEM
//! (Intune, SCCM) or approved by another administrator reach the people who later use the app; an
//! upgrade carries the previous choice and stamp forward. The same two values under the user's own
//! `HKCU\Software\OpenCodex\Telemetry` are honoured too, as a per-user choice.
//!
//! Before the app resolves, attaches to or starts a proxy, this module carries an opt-out into the
//! current user's opencodex config by running the bundled `ocx telemetry disable`, which persists
//! `telemetry.decision = "declined"` (on a fresh install it is held as `pendingDecision` without
//! creating `config.json`). It then records the applied stamp in that user's HKCU, one value per
//! scope, so each opt-out applies once per user and a later dashboard choice is not overridden until
//! an install records a new opt-out. `send` is never acted on, and this module has no path that
//! enables telemetry, so no installer choice can turn a decline back on.
//!
//! When the decline could not be persisted, a sidecar this app starts runs with
//! `OCX_TELEMETRY=0`, and the save is retried in the background (`RETRY_DELAYS`) and again on the
//! next launch. A proxy this app only attaches to was started elsewhere with its own environment;
//! it follows the saved decline once a retry succeeds (it re-reads the config on every tick). If a
//! decline was saved but its stamp could not be recorded, the next launch saves it again, which can
//! override a dashboard enable made in between; that errs toward privacy.
//!
//! An MSI install does not put `ocx.exe` on PATH; the terminal command is installed by this app.
//! On a first install the app therefore runs before any proxy from that install can. After the app
//! has installed the terminal command, `ocx service install` can register a logon task that starts a
//! proxy without the app; an opt-out recorded by a later manual upgrade reaches that proxy's config
//! when the app next starts, and until then the service may still make its daily send.

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
/// Written by this app under HKCU: the stamp of the last machine-wide opt-out applied for this user.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const APPLIED_STAMP_VALUE: &str = "AppliedInstallerStamp";
/// Written by this app under HKCU: the stamp of the last per-user opt-out applied.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const APPLIED_USER_STAMP_VALUE: &str = "AppliedUserInstallerStamp";
// The installer's value for an opt-out, pinned against the WiX fragment by a test; the app treats any
// value other than `SEND` as an opt-out.
#[allow(dead_code)]
pub const OPT_OUT: &str = "optout";
pub const SEND: &str = "send";

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

/// Where an installer choice was recorded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// `HKLM`: every account on the computer.
    Machine,
    /// `HKCU`: this account only. Only the Windows registry reader records it.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    User,
}

impl Scope {
    /// The HKCU value this app writes once an opt-out from this scope is applied.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn applied_value(self) -> &'static str {
        match self {
            Scope::Machine => APPLIED_STAMP_VALUE,
            Scope::User => APPLIED_USER_STAMP_VALUE,
        }
    }
}

/// A choice the installer recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallerChoice {
    pub scope: Scope,
    pub choice: String,
    pub stamp: String,
}

/// Registry access, injected so the decision logic is tested without Windows.
pub trait InstallerRegistry {
    /// The choices the installer recorded, in any order.
    fn choices(&self) -> Vec<InstallerChoice>;
    /// The stamp this app last applied for `scope` in this account.
    fn applied_stamp(&self, scope: Scope) -> Option<String>;
    /// Record that the opt-out with `stamp` from `scope` is applied in this account.
    fn mark_applied(&self, scope: Scope, stamp: &str) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No opt-out is pending for this user: no choice, `send`, or one already applied.
    NothingPending,
    /// The decline is in the user's config and every pending stamp is recorded.
    Applied,
    /// The decline is in the config, but a stamp could not be recorded; the next launch re-applies it.
    AppliedUnmarked,
    /// The decline could not be persisted; a sidecar this app starts runs with `OCX_TELEMETRY=0`.
    NotPersisted,
}

/// Fail closed like the installer: any recorded value other than `send` (or nothing) is an opt-out.
fn is_opt_out(choice: &str) -> bool {
    let choice = choice.trim();
    !choice.is_empty() && !choice.eq_ignore_ascii_case(SEND)
}

/// The opt-outs this account has not applied yet, machine-wide first. `send` is never pending.
pub fn pending_opt_outs<R: InstallerRegistry + ?Sized>(registry: &R) -> Vec<InstallerChoice> {
    let mut pending: Vec<InstallerChoice> = registry
        .choices()
        .into_iter()
        .filter(|choice| is_opt_out(&choice.choice))
        .filter(|choice| {
            registry
                .applied_stamp(choice.scope)
                .as_deref()
                .map(str::trim)
                != Some(choice.stamp.trim())
        })
        .collect();
    pending.sort_by_key(|choice| choice.scope != Scope::Machine);
    pending
}

/// `ocx telemetry disable` exits 0 only once the decline is persisted.
pub fn decline_persisted(exit_code: Option<i32>) -> bool {
    exit_code == Some(0)
}

/// Apply the pending opt-outs: one persisted decline covers all of them, and only then is each
/// stamp recorded.
pub fn settle<R: InstallerRegistry + ?Sized>(
    registry: &R,
    pending: &[InstallerChoice],
    persist: impl FnOnce() -> bool,
) -> Outcome {
    if pending.is_empty() {
        return Outcome::NothingPending;
    }
    if !persist() {
        return Outcome::NotPersisted;
    }
    let mut all_marked = true;
    for choice in pending {
        all_marked &= registry.mark_applied(choice.scope, choice.stamp.trim());
    }
    if all_marked {
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
    let registry = os::SystemRegistry;
    let pending = pending_opt_outs(&registry);
    let persisted = if pending.is_empty() {
        false
    } else {
        disable(app, deadline.min(Instant::now() + STEP_CAP)).await
    };
    let outcome = settle(&registry, &pending, || persisted);
    match outcome {
        Outcome::NotPersisted => {
            SIDECAR_ENV_OPT_OUT.store(true, Ordering::SeqCst);
            crate::logging::log_once(
                "the installer's telemetry opt-out could not be saved",
                "a proxy this app starts runs with OCX_TELEMETRY=0; saving is retried in the background",
            );
            let app = app.clone();
            tauri::async_runtime::spawn(async move { retry(app, pending).await });
        }
        Outcome::AppliedUnmarked => crate::logging::log_once(
            "the installer's telemetry opt-out was saved but not recorded as applied",
            "the next launch saves the decline again",
        ),
        Outcome::NothingPending | Outcome::Applied => {}
    }
    outcome
}

async fn retry(app: AppHandle, pending: Vec<InstallerChoice>) {
    for delay in RETRY_DELAYS {
        tokio::time::sleep(delay).await;
        if disable(&app, Instant::now() + RETRY_TIMEOUT).await {
            if settle(&os::SystemRegistry, &pending, || true) == Outcome::AppliedUnmarked {
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
    use super::{InstallerChoice, InstallerRegistry, Scope};
    use winreg::enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };
    use winreg::RegKey;

    pub struct SystemRegistry;

    fn read(key: &RegKey, scope: Scope) -> Option<InstallerChoice> {
        let choice = key.get_value::<String, _>(super::REGISTRY_VALUE).ok()?;
        let stamp = key
            .get_value::<String, _>(super::STAMP_VALUE)
            .unwrap_or_default();
        Some(InstallerChoice {
            scope,
            choice,
            stamp,
        })
    }

    impl InstallerRegistry for SystemRegistry {
        fn choices(&self) -> Vec<InstallerChoice> {
            let mut choices = Vec::new();
            // The 64-bit view first, the 32-bit view second.
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                if let Some(choice) = RegKey::predef(HKEY_LOCAL_MACHINE)
                    .open_subkey_with_flags(super::REGISTRY_KEY, KEY_READ | view)
                    .ok()
                    .and_then(|key| read(&key, Scope::Machine))
                {
                    choices.push(choice);
                    break;
                }
            }
            if let Some(choice) = RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(super::REGISTRY_KEY, KEY_READ)
                .ok()
                .and_then(|key| read(&key, Scope::User))
            {
                choices.push(choice);
            }
            choices
        }

        fn applied_stamp(&self, scope: Scope) -> Option<String> {
            RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(super::REGISTRY_KEY, KEY_READ)
                .ok()?
                .get_value::<String, _>(scope.applied_value())
                .ok()
        }

        fn mark_applied(&self, scope: Scope, stamp: &str) -> bool {
            RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey(super::REGISTRY_KEY)
                .and_then(|(key, _)| key.set_value(scope.applied_value(), &stamp.to_owned()))
                .is_ok()
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod os {
    use super::{InstallerChoice, InstallerRegistry, Scope};

    /// Only the Windows installer records a choice.
    pub struct SystemRegistry;

    impl InstallerRegistry for SystemRegistry {
        fn choices(&self) -> Vec<InstallerChoice> {
            Vec::new()
        }

        fn applied_stamp(&self, _scope: Scope) -> Option<String> {
            None
        }

        fn mark_applied(&self, _scope: Scope, _stamp: &str) -> bool {
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decline_persisted, pending_opt_outs, settle, InstallerChoice, InstallerRegistry, Outcome,
        Scope,
    };
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    /// An in-memory registry: the installer's choices plus this account's applied stamps.
    #[derive(Default)]
    struct FakeRegistry {
        choices: Vec<InstallerChoice>,
        applied: RefCell<HashMap<&'static str, String>>,
        refuse_marks: bool,
    }

    impl FakeRegistry {
        fn with(choices: &[(Scope, &str, &str)]) -> Self {
            Self {
                choices: choices
                    .iter()
                    .map(|(scope, choice, stamp)| InstallerChoice {
                        scope: *scope,
                        choice: (*choice).to_owned(),
                        stamp: (*stamp).to_owned(),
                    })
                    .collect(),
                ..Self::default()
            }
        }

        fn applied(&self, scope: Scope) -> Option<String> {
            self.applied.borrow().get(scope.applied_value()).cloned()
        }

        fn set_applied(&self, scope: Scope, stamp: &str) {
            self.applied
                .borrow_mut()
                .insert(scope.applied_value(), stamp.to_owned());
        }
    }

    impl InstallerRegistry for FakeRegistry {
        fn choices(&self) -> Vec<InstallerChoice> {
            self.choices.clone()
        }

        fn applied_stamp(&self, scope: Scope) -> Option<String> {
            self.applied(scope)
        }

        fn mark_applied(&self, scope: Scope, stamp: &str) -> bool {
            if self.refuse_marks {
                return false;
            }
            self.set_applied(scope, stamp);
            true
        }
    }

    /// Run one launch: returns the outcome and whether a decline was persisted.
    fn launch(registry: &FakeRegistry, persist_ok: bool) -> (Outcome, bool) {
        let persisted = Cell::new(false);
        let pending = pending_opt_outs(registry);
        let outcome = settle(registry, &pending, || {
            persisted.set(true);
            persist_ok
        });
        (outcome, persisted.get())
    }

    #[test]
    fn a_machine_wide_opt_out_applies_once_per_account() {
        let registry = FakeRegistry::with(&[(Scope::Machine, "optout", "11/8/2026 10:12:33")]);
        assert_eq!(launch(&registry, true), (Outcome::Applied, true));
        assert_eq!(
            registry.applied(Scope::Machine).as_deref(),
            Some("11/8/2026 10:12:33")
        );
        // The next launch finds the stamp applied and does nothing, so a later dashboard enable stays.
        assert_eq!(launch(&registry, true), (Outcome::NothingPending, false));
    }

    #[test]
    fn a_new_stamp_from_a_later_install_applies_again() {
        let registry = FakeRegistry::with(&[(Scope::Machine, "optout", "s2")]);
        registry.set_applied(Scope::Machine, "s1");
        assert_eq!(launch(&registry, true), (Outcome::Applied, true));
        assert_eq!(registry.applied(Scope::Machine).as_deref(), Some("s2"));
    }

    #[test]
    fn send_from_any_scope_never_acts_so_a_decline_is_never_flipped() {
        for choices in [
            vec![(Scope::Machine, "send", "s1")],
            vec![(Scope::User, "send", "s1")],
            vec![(Scope::Machine, "send", "s1"), (Scope::User, "SEND", "s2")],
            vec![(Scope::Machine, "", "s1"), (Scope::User, " Send ", "s2")],
        ] {
            let registry = FakeRegistry::with(&choices);
            // Nothing runs: the bridge only ever runs `ocx telemetry disable`, and here not even that.
            assert_eq!(
                launch(&registry, true),
                (Outcome::NothingPending, false),
                "{choices:?}"
            );
            assert_eq!(registry.applied(Scope::Machine), None);
            assert_eq!(registry.applied(Scope::User), None);
        }
    }

    #[test]
    fn an_unrecognized_value_counts_as_an_opt_out() {
        for value in ["off", "0", "opt-out", "OptOut", " optout "] {
            let registry = FakeRegistry::with(&[(Scope::User, value, "u1")]);
            assert_eq!(
                launch(&registry, true),
                (Outcome::Applied, true),
                "{value:?}"
            );
        }
    }

    #[test]
    fn machine_and_per_user_opt_outs_are_both_honoured_machine_first() {
        let registry = FakeRegistry::with(&[
            (Scope::User, "optout", "u1"),
            (Scope::Machine, " OptOut ", "m1"),
        ]);
        let pending = pending_opt_outs(&registry);
        assert_eq!(
            pending
                .iter()
                .map(|choice| choice.scope)
                .collect::<Vec<_>>(),
            vec![Scope::Machine, Scope::User]
        );
        // One persisted decline covers both, and both stamps are recorded.
        assert_eq!(launch(&registry, true), (Outcome::Applied, true));
        assert_eq!(registry.applied(Scope::Machine).as_deref(), Some("m1"));
        assert_eq!(registry.applied(Scope::User).as_deref(), Some("u1"));
    }

    #[test]
    fn a_later_install_recording_send_leaves_an_applied_decline_alone() {
        // An opt-out from an earlier install was applied for this account ...
        let earlier = FakeRegistry::with(&[(Scope::Machine, "optout", "s1")]);
        assert_eq!(launch(&earlier, true), (Outcome::Applied, true));
        // ... then an upgrade where someone checked the box records send with a new stamp.
        let later = FakeRegistry::with(&[(Scope::Machine, "send", "s2")]);
        later.set_applied(Scope::Machine, "s1");
        // Nothing runs, so the saved decline stays, and the applied stamp is not touched.
        assert_eq!(launch(&later, true), (Outcome::NothingPending, false));
        assert_eq!(later.applied(Scope::Machine).as_deref(), Some("s1"));
    }

    #[test]
    fn a_per_user_opt_out_applies_when_the_machine_choice_is_send() {
        let registry = FakeRegistry::with(&[
            (Scope::Machine, "send", "m1"),
            (Scope::User, "optout", "u1"),
        ]);
        assert_eq!(launch(&registry, true), (Outcome::Applied, true));
        assert_eq!(registry.applied(Scope::Machine), None);
        assert_eq!(registry.applied(Scope::User).as_deref(), Some("u1"));
    }

    #[test]
    fn an_applied_machine_stamp_does_not_hide_a_new_per_user_opt_out() {
        let registry = FakeRegistry::with(&[
            (Scope::Machine, "optout", "m1"),
            (Scope::User, "optout", "u1"),
        ]);
        registry.set_applied(Scope::Machine, "m1");
        let pending = pending_opt_outs(&registry);
        assert_eq!(
            pending
                .iter()
                .map(|choice| choice.scope)
                .collect::<Vec<_>>(),
            vec![Scope::User]
        );
    }

    #[test]
    fn a_stamp_is_recorded_only_after_the_decline_persisted() {
        let registry = FakeRegistry::with(&[(Scope::Machine, "optout", "m1")]);
        assert_eq!(launch(&registry, false), (Outcome::NotPersisted, true));
        assert_eq!(registry.applied(Scope::Machine), None);
        // The next launch tries again.
        assert_eq!(launch(&registry, true), (Outcome::Applied, true));
    }

    #[test]
    fn an_unrecorded_stamp_is_reported_and_retried_next_launch() {
        let mut registry = FakeRegistry::with(&[(Scope::Machine, "optout", "m1")]);
        registry.refuse_marks = true;
        assert_eq!(launch(&registry, true), (Outcome::AppliedUnmarked, true));
        registry.refuse_marks = false;
        assert_eq!(launch(&registry, true), (Outcome::Applied, true));
    }

    #[test]
    fn no_choice_at_all_runs_nothing() {
        let registry = FakeRegistry::default();
        assert_eq!(launch(&registry, true), (Outcome::NothingPending, false));
    }

    #[test]
    fn only_a_clean_exit_counts_as_persisted() {
        assert!(decline_persisted(Some(0)));
        for code in [None, Some(1), Some(2), Some(-1)] {
            assert!(!decline_persisted(code), "{code:?}");
        }
    }
}
