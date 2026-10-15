# Desktop Start at Login

How the macOS tray's **Start at Login** item decides what to show and what a click may change,
and how the once-per-installation launch-origin migration avoids another copy's login item. The
surrounding first-run default and tray are described in [Desktop shell](desktop-shell.md); the
plan and audit history is in `devlog/_plan/261012_6972_tray_start_at_login/`.

On macOS the tray's Start at Login item does not read the plugin's `is_enabled`, which is
only "the LaunchAgent plist exists". `desktop/src-tauri/src/login_registration.rs` ports
`macLoginRegistration` and `macLoginFactsFor` from `src/service/desktop-startup.ts` step for
step — plist shape, `launchctl print-disabled` override, registered app equal to this running
copy, loaded `program`/`path` or the exact service-not-found answer with an unchanged
re-read — so the item is checked exactly when Startup safety would credit this copy (#6972).
On macOS 13+ Background Task Management can resubmit the LaunchAgent through smd, and
`launchctl print` then reports `path = (submitted by smd.<pid>)` with
`managed_by = com.apple.xpc.ServiceManagement` instead of the plist path. That loaded job is
credited only when its `program` is this copy and the whole registration re-reads unchanged,
the same rule as the service-not-found answer (#7019).
The cases in `tests/fixtures/desktop-login-registration-cases.json` run against both
implementations (`login_registration::tests` and
`tests/service/service-desktop-login-registration.test.ts`); a change to either judgment
must change the fixture and pass both. Every other state is unchecked with its reason in the
label. Three states are actionable: verified turns Start at Login off, absent registers this
copy, and a launchd-disabled job of this copy opens Login Items settings, because rewriting the
plist cannot clear launchd's override.
Another copy's registration, a registration naming a missing app and unreadable evidence leave
the item disabled; the tray never rewrites them. `desktop/src-tauri/src/tray_login.rs` probes on
blocking workers under one mutex (at build, on hover at most every two seconds, every 60
seconds, and around a click, re-probing before it acts) and applies presentation in one
main-thread closure. muda flips a check item before the click reaches the app, so the click
handler restores the shown state and disables the item until its own answer; refreshes landing
meanwhile are dropped. The probe and the action are not atomic across processes: another copy
rewriting the plist in the milliseconds between them is a known limit.

The macOS launch-origin migration in `desktop/src-tauri/src/first_run.rs` is narrower than on
other platforms. The marker sits in a config directory every copy shares, and the plugin
rewrites the whole plist, so `login_registration::migration` allows the rewrite only for this
copy's entry carrying exactly the three keys the plugin writes and not replaced while it was
read. Anything else is left untouched and unmarked.
