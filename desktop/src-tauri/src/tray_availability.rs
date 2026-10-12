//! Whether this session actually has a tray, as opposed to a tray backend that accepts an icon.
//!
//! `TrayIconBuilder::build` returning `Ok` proves nothing on Linux. The pinned backend creates an
//! AppIndicator and reports success without checking that anything will display it, so on stock
//! GNOME — which ships no AppIndicator extension — construction succeeds and no icon ever appears.
//! The shell's macOS-shaped assumptions then compound it: the window was created hidden and close
//! always hid, which leaves a running process with no way back in.
//!
//! So the question is asked of the session bus. Not whether the watcher exists — a watcher with no
//! host attached still accepts registrations and still draws nothing — but whether it reports a
//! host registered, which is the StatusNotifier specification's own answer to "is there somewhere
//! for an icon to appear". macOS and Windows have a status area that is always present and answer
//! without a probe.

/// The result of asking whether this session can display a tray icon.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayAvailability {
    /// There is somewhere for the icon to appear, so hiding to the tray is a real place to hide.
    Available,
    /// There is not. The window is shown on launch and closing it ends the app through the drain.
    Unavailable,
}

impl TrayAvailability {
    pub fn is_available(self) -> bool {
        matches!(self, Self::Available)
    }

    /// Whether a window close or a platform quit gesture may hide the app instead of ending it.
    pub fn hides_to_tray(self) -> bool {
        self.is_available()
    }

    /// What to assume before the probe has answered.
    ///
    /// The probe is asynchronous, and a window close can land before it returns. Assuming a tray
    /// that turns out not to exist is the failure this whole module is about, so the platforms that
    /// need a probe assume nothing until they have one.
    pub fn assumed() -> Self {
        if cfg!(target_os = "linux") {
            Self::Unavailable
        } else {
            Self::Available
        }
    }
}

/// The StatusNotifier watcher, and the property that says a host is attached to it.
#[cfg(target_os = "linux")]
pub const WATCHER_NAME: &str = "org.kde.StatusNotifierWatcher";
#[cfg(target_os = "linux")]
pub const WATCHER_PATH: &str = "/StatusNotifierWatcher";
#[cfg(target_os = "linux")]
pub const HOST_REGISTERED: &str = "IsStatusNotifierHostRegistered";

/// How long the session-bus probe may take.
#[cfg(target_os = "linux")]
const PROBE_TIMEOUT_MS: u64 = 750;

/// Read a host-registered answer as an availability verdict.
///
/// `None` means the question could not be asked at all — no session bus, no watcher on it, no
/// reply, a malformed one. That is deliberately folded into the same answer as a watcher with no
/// host, because the two are indistinguishable from here and the safe response to both is
/// identical: show the window and let close mean close. Guessing the other way strands the user.
pub fn from_host_registered(registered: Option<bool>) -> TrayAvailability {
    match registered {
        Some(true) => TrayAvailability::Available,
        Some(false) | None => TrayAvailability::Unavailable,
    }
}

#[cfg(not(target_os = "linux"))]
pub fn detect() -> TrayAvailability {
    // macOS and Windows both have a status area that is always there, so the answer is known
    // without asking anything. It still goes through the same reading so there is one place where
    // an availability verdict is produced.
    from_host_registered(Some(true))
}

#[cfg(target_os = "linux")]
pub fn detect() -> TrayAvailability {
    from_host_registered(host_registered())
}

#[cfg(target_os = "linux")]
fn host_registered() -> Option<bool> {
    use dbus::blocking::{stdintf::org_freedesktop_dbus::Properties, Connection};
    use std::time::Duration;

    let connection = Connection::new_session().ok()?;
    let watcher = connection.with_proxy(
        WATCHER_NAME,
        WATCHER_PATH,
        Duration::from_millis(PROBE_TIMEOUT_MS),
    );
    // A watcher nobody owns makes this call fail rather than answer, which is the same verdict.
    watcher.get(WATCHER_NAME, HOST_REGISTERED).ok()
}

#[cfg(test)]
mod tests {
    use super::{from_host_registered, TrayAvailability};

    #[test]
    fn only_a_registered_host_is_an_available_tray() {
        assert_eq!(
            from_host_registered(Some(true)),
            TrayAvailability::Available
        );
        assert_eq!(
            from_host_registered(Some(false)),
            TrayAvailability::Unavailable
        );
        assert_eq!(from_host_registered(None), TrayAvailability::Unavailable);
    }

    #[test]
    fn hiding_is_only_offered_where_the_icon_would_be_drawn() {
        assert!(TrayAvailability::Available.hides_to_tray());
        assert!(!TrayAvailability::Unavailable.hides_to_tray());
    }

    #[test]
    fn nothing_is_assumed_on_the_platform_that_needs_a_probe() {
        assert_eq!(
            TrayAvailability::assumed().is_available(),
            !cfg!(target_os = "linux")
        );
    }
}
