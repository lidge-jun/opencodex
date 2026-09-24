# 030 — Desktop update page (wp3, commit 3)

## Outcome and boundary

Commit 3 makes both update entries in the *embedded* dashboard open a bundled desktop update page. The page can inspect, check, install, retry, and return to the dashboard through four native commands. Tray and page installation share one atomic claim and restore the pending signed update on failure. The browser dashboard retains its package update dialog. The dependency is commit 1's package badge freshness and commit 2's per-session desktop badge, updater-state publication, and tray icon state; rebase this diff on those commits and preserve their publication calls. This document proposes code; it does not implement it.

IN: `desktop/ui/update.html`, the four commands, shared install claim, desktop GUI routing, tests, structure and public docs. OUT: `/api/update/run` changes, remote-origin updater IPC, updater key/signature policy, auto-install, tray icon art, package cache, npm PowerShell tray, and release/deployment. Commit 2 owns the `desktop_session` query key and the desktop badge request through `gui/src/lib/desktop-shell.ts::desktopSession`, `gui/src/lib/desktop-shell.ts::updateBadgeUrl`, and `gui/src/components/sidebar-github-row.tsx` ([020_phase2_desktop_state_icons.md](020_phase2_desktop_state_icons.md), “Embedded GUI poll”); wp3 leaves that code intact. That session is display identity only, never install authority (D3/D4 in `000_plan.md`).

Current anchors at `9ffa2261ba`: `generate_handler!` and `WebviewUrl::App("index.html".into())` in `desktop/src-tauri/src/lib.rs:214-250`; `CheckGeneration`, `UiProjection`, `DesktopUpdateState`, `PendingUpdate`, and `check_and_show` in `desktop/src-tauri/src/updater.rs:12-238,329-378`; the still-ungated install arm, `TrayState`, and setter functions in `desktop/src-tauri/src/tray.rs:20-40,219-250,312-360`; `startup::open_dashboard`, `ready_dashboard`, and `navigate_dashboard` in `desktop/src-tauri/src/startup.rs:498-504,1454-1495`; app-origin policy in `desktop/src-tauri/src/window.rs:37-77`; `frontendDist`, `withGlobalTauri`, and CSP in `desktop/src-tauri/tauri.conf.json:6-15`; `window.__TAURI__.core.invoke` and nonce pattern in `desktop/ui/index.html:75-123`; GUI entry points in `gui/src/App.tsx:454-462`, `gui/src/components/sidebar-github-row.tsx:127-156`, and `gui/src/pages/use-dashboard-data.ts:861-901`. The maintenance anchor calls `openUpdateDialog` at `gui/src/pages/dashboard-overview-sections.tsx:219-229`; no edit there. `gui/src/lib/desktop-shell.ts:7-33` now owns desktop/session/OS detection and `updateBadgeUrl`.

## File change map and executable edits

No DELETE paths. Code blocks show the full new file or the exact replacement/addition at the named current-HEAD anchor. Preserve commit 2's snapshot publication and serialized UI projection worker when replacing check/install logic.

### NEW `desktop/ui/update.html` — full file

The page stays self-contained and English-only, matching `desktop/ui/index.html:1-74`. The inline script's Tauri nonce is required by the tested Linux CSP behavior at `desktop/ui/index.html:75-87` and `tests/clients/desktop-startup-surface.test.ts:313-323`. It does not call HTTP, parse a token, or use browser alert/confirm/prompt.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenCodex update</title>
    <style>
      :root { color-scheme: light dark; font: 15px system-ui, sans-serif; }
      body { display: grid; min-height: 100vh; place-items: center; margin: 0; background: #f5f5f7; color: #202124; }
      main { width: min(38rem, calc(100vw - 3rem)); box-sizing: border-box; padding: 2rem; border-radius: 1rem; background: white; box-shadow: 0 8px 30px #0001; }
      h1 { margin-top: 0; font-size: 1.4rem; }
      p { line-height: 1.5; }
      #state { min-height: 1.5rem; }
      #error { color: #b3261e; }
      #error[hidden] { display: none; }
      .actions { display: flex; flex-wrap: wrap; gap: .6rem; }
      button { border: 0; border-radius: .5rem; padding: .6rem 1rem; background: #2563eb; color: white; cursor: pointer; font: inherit; }
      button.secondary { background: #e3e3e8; color: #202124; }
      button[disabled] { opacity: .5; cursor: default; }
      button:focus-visible { outline: 3px solid #65a3ff; outline-offset: 2px; }
      @media (prefers-color-scheme: dark) {
        body { background: #1c1c1e; color: #f5f5f7; }
        main { background: #2c2c2e; }
        #error { color: #ff8a80; }
        button.secondary { background: #3a3a3c; color: #f5f5f7; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>OpenCodex update</h1>
      <p id="state" role="status" aria-live="polite">Reading update status…</p>
      <p id="error" role="alert" hidden></p>
      <div class="actions">
        <button id="check" type="button">Check again</button>
        <button id="install" type="button" disabled>Install update</button>
        <button id="back" type="button" class="secondary">Back to dashboard</button>
      </div>
    </main>
    <script nonce="__TAURI_SCRIPT_NONCE__">
const invoke = window.__TAURI__?.core?.invoke;
const state = document.querySelector("#state");
const error = document.querySelector("#error");
const check = document.querySelector("#check");
const install = document.querySelector("#install");
const back = document.querySelector("#back");
const DEADLINE_MS = 5000;
const CHECK_DEADLINE_MS = 60000;
const INSTALL_DEADLINE_MS = 10 * 60 * 1000;
let busy = false;
let latest = null;
let statusPoll = null;

function bounded(work, name, deadlineMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(name + " did not answer within " + deadlineMs + " ms")), deadlineMs);
    Promise.resolve(work).then(
      value => { clearTimeout(timer); resolve(value); },
      cause => { clearTimeout(timer); reject(cause); },
    );
  });
}
function showError(cause) {
  error.textContent = cause instanceof Error ? cause.message : String(cause);
  error.hidden = false;
}
function render(snapshot) {
  latest = snapshot;
  if (snapshot.installing) state.textContent = "Installing update…";
  else if (snapshot.checking) state.textContent = "Checking for updates…";
  else if (snapshot.available && snapshot.latestVersion) state.textContent = "Update v" + snapshot.latestVersion + " is available. Installed version: " + snapshot.currentVersion + ".";
  else state.textContent = "OpenCodex v" + snapshot.currentVersion + " is up to date or has no pending update.";
  check.disabled = busy || snapshot.installing;
  install.disabled = busy || snapshot.installing || !snapshot.available;
  if (statusPoll !== null) { clearTimeout(statusPoll); statusPoll = null; }
  if (snapshot.checking && !snapshot.installing) {
    statusPoll = setTimeout(() => {
      statusPoll = null;
      if (busy) { render(latest); return; }
      void refresh("update_status");
    }, 1000);
  }
}
async function call(name) {
  if (!invoke) throw new Error("Open this page from the OpenCodex desktop app.");
  const deadlineMs = name === "update_install" ? INSTALL_DEADLINE_MS
    : name === "update_check" ? CHECK_DEADLINE_MS : DEADLINE_MS;
  return await bounded(invoke(name), name, deadlineMs);
}
async function refresh(name) {
  if (busy) return;
  busy = true;
  check.disabled = true;
  install.disabled = true;
  error.hidden = true;
  state.textContent = name === "update_check" ? "Checking for updates…" : "Reading update status…";
  try { render(await call(name)); }
  catch (cause) { showError(cause); if (latest) render(latest); }
  finally { busy = false; if (latest) render(latest); else check.disabled = false; }
}
check.addEventListener("click", () => { void refresh("update_check"); });
install.addEventListener("click", async () => {
  if (busy || !latest?.available) return;
  busy = true;
  check.disabled = true;
  install.disabled = true;
  error.hidden = true;
  state.textContent = "Installing update…";
  try { render(await call("update_install")); }
  catch (cause) { showError(cause); try { render(await call("update_status")); } catch (readError) { showError(readError); } }
  finally { busy = false; if (latest) render(latest); else check.disabled = false; }
});
back.addEventListener("click", async () => {
  back.disabled = true;
  error.hidden = true;
  try { await call("return_to_dashboard"); }
  catch (cause) { showError(cause); back.disabled = false; }
});
if (!invoke) { state.textContent = "Open this page from the OpenCodex desktop app."; check.disabled = true; back.disabled = true; }
else void refresh("update_status");
    </script>
  </body>
</html>
```

### MODIFY `desktop/src-tauri/src/updater.rs`

Before adding the page command, extend the current `#[derive(Clone)] pub enum UiProjection` at `updater.rs:12-16` with `Installing(String)`; keep the derive. Add `UiProjection::Installing(version) => tray::show_installing(&app, &version),` to `start_ui_projection_worker`'s match at `updater.rs:137-140`. Replace the full `CheckGeneration::claim_install` at `updater.rs:64-80` with this block and add `InstallClaim` at module level. `pending_version` runs under the gate **before** anything is committed: `NoPending` leaves the flag, `install_epoch`, and `latest_ui_revision` untouched, so an in-flight check remains valid. `on_claim` only publishes the in-memory snapshot under the gate; neither closure calls a Tauri setter. Remove the commit-2 `#[allow(dead_code)]` markers from `claim_install`, `epoch_is_current`, and `inspect` when wp3 wires them (`updater.rs:65,82,98`). Leave the unrelated `popup_nonmac_test` marker at `updater.rs:242` intact.

```rust
// Module level in updater.rs, next to CheckGeneration:
#[derive(Debug, PartialEq, Eq)]
pub enum InstallClaim { Claimed, Busy, NoPending }

// Inside impl CheckGeneration, replacing commit 2's claim_install:
pub fn claim_install(
    &self, installing: &std::sync::atomic::AtomicBool,
    pending_version: impl FnOnce() -> Option<String>,
    on_claim: impl FnOnce(),
) -> InstallClaim {
    let _guard = self.application.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if installing.load(Ordering::Acquire) {
        return InstallClaim::Busy;
    }
    // Verify pending under the gate before committing anything: a stale Install click with no
    // pending update must not bump the epoch and orphan an in-flight check.
    let Some(version) = pending_version() else { return InstallClaim::NoPending; };
    if installing.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return InstallClaim::Busy;
    }
    self.install_epoch.fetch_add(1, Ordering::AcqRel);
    self.latest_ui_revision.fetch_add(1, Ordering::AcqRel); // invalidate queued check UI
    on_claim();
    self.queue_ui(UiProjection::Installing(version));
    InstallClaim::Claimed
}
```

The current tray install arm does **not** call commit 2's `claim_install(&installing) -> bool`: it still takes `PendingUpdate` directly at `tray.rs:228-233`. Replace that entire arm with `install_pending` below; the new three-way claim lives in that shared function and runs before either entry takes pending. The existing Rust test at `updater.rs:467-480` is the only live old-signature call site and must be changed as shown below.

Reuse commit 2's `use serde::Serialize;` and `use std::sync::atomic::{AtomicU64, Ordering};` imports; do not add a second `Ordering` import ([020_phase2_desktop_state_icons.md](020_phase2_desktop_state_icons.md), “Rust transport and state”, `desktop/src-tauri/src/updater.rs`). Keep `PendingUpdate`'s single `Mutex<Option<Update>>`; there is no second copy of signed `Update`. Add this after `PendingUpdate` and make all app-origin commands return the same projection. `PageUpdateStatus` is a new serialized type, not a new persisted schema.

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageUpdateStatus {
    current_version: String,
    latest_version: Option<String>,
    available: bool,
    installing: bool,
    checking: bool,
}

pub fn page_status(app: &AppHandle) -> PageUpdateStatus {
    app.state::<CheckGeneration>().inspect(|| {
        let pending = app.state::<PendingUpdate>();
        let pending = pending.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let latest_version = pending.as_ref().map(|update| update.version.clone());
        let installing = tray::is_installing(app);
        let checking = app.state::<DesktopUpdateState>().tx.borrow().phase == "checking";
        PageUpdateStatus {
            current_version: env!("CARGO_PKG_VERSION").to_owned(),
            available: latest_version.is_some(),
            latest_version,
            installing,
            checking,
        }
    })
}

pub async fn install_pending(app: &AppHandle) -> Result<PageUpdateStatus, String> {
    let state = app.state::<tray::TrayState>();
    let gate = app.state::<CheckGeneration>();
    match gate.claim_install(
        &state.installing,
        || app.state::<PendingUpdate>().0.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref().map(|update| update.version.clone()),
        || app.state::<DesktopUpdateState>().retain_phase("installing"),
    ) {
        InstallClaim::Claimed => {}
        InstallClaim::Busy => return Err("an update is already installing".into()),
        InstallClaim::NoPending => return Err("no update is ready to install".into()),
    }
    let pending = app.state::<PendingUpdate>();
    let update = pending.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
    let Some(update) = update else {
        // Unreachable while the claim holds: only a claimed installer takes PendingUpdate and
        // checks are rejected by the bumped epoch. Release under the gate defensively.
        gate.inspect(|| {
            state.installing.store(false, Ordering::Release);
            app.state::<DesktopUpdateState>().retain_phase("current");
            gate.queue_ui(UiProjection::Current);
        });
        return Err("no update is ready to install".into());
    };
    let version = update.version.clone();
    let retry_update = update.clone();
    let result = install(app, update).await;
    if let Err(error) = result {
        gate.inspect(|| {
            let pending = app.state::<PendingUpdate>();
            *pending.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(retry_update);
            state.installing.store(false, Ordering::Release);
            state.update_pending.store(true, Ordering::Release);
            app.state::<DesktopUpdateState>().retain_phase("install-failed");
            gate.queue_ui(UiProjection::Available(version));
        });
        return Err(error);
    }
    state.installing.store(false, Ordering::Release);
    Ok(page_status(app))
}
```

The existing `install(app, update)` body at `updater.rs:288-313` remains unchanged: its signed `download` precedes `exit::prepare_restart`, then `update.install` and `exit::complete_restart`. The claim happens *before* taking `PendingUpdate` and increments the gate-owned epoch inside the same short mutex used by check-result application. Its `pending_version` closure reads the pending version; `on_claim` publishes the pure `"installing"` snapshot; `claim_install` queues the install UI projection while still in the gate. None makes a Tauri setter call. Keep commit 2's `DesktopUpdateState` and `start_snapshot_publisher` (`updater.rs:156-236`), whose 60-second wait uses `tokio::time::timeout`, not `select!`; `wake()` notifies via `send_modify` without replacing the snapshot (`updater.rs:197-204`). On a failed download or drain, the gate protects pending restoration, claim release, `"install-failed"` publication, and a new available projection together. The serialized UI worker performs menu/icon/overlay setters afterward. No second app update is fetched during installation. Do not return a raw updater error over IPC if it can contain a URL or local path; map it to fixed user-facing copy and keep detailed error in `logging::log_once` (current tray logger at `tray.rs:247`).

Commit 2 owns `desktop/src-tauri/src/updater.rs::CheckGeneration` and `check_and_show` ([020_phase2_desktop_state_icons.md](020_phase2_desktop_state_icons.md), “Rust transport and state”). Change only `check_and_show`'s return/error contract; the gate already owns `install_epoch` and `latest_ui_revision`. The page command in `lib.rs::update_check` below calls this same function as the tray action and background loop; it must not call `check(app)` or create a second generation counter. `begin_if_not_installing` captures the epoch and publishes `"checking"` only after a locked install-flag recheck. Compare the epoch **inside** `apply_if_current`, before any pending, tray model, snapshot, or UI projection mutation. A superseded check returns `Ok(())` without publishing or reporting its obsolete error, then `page_status` returns `checking: true` while the newer generation is in flight; the page polls until a settled status arrives.

```rust
pub async fn check_and_show(app: &AppHandle) -> Result<(), String> {
    let gate = app.state::<CheckGeneration>();
    let state = app.state::<tray::TrayState>();
    let Some((generation, epoch)) = gate.begin_if_not_installing(&state.installing, || {
        app.state::<DesktopUpdateState>().retain_phase("checking");
    }) else { return Ok(()); };
    let answer = check(app).await;
    let applied = gate.apply_if_current(generation, || {
        if tray::is_installing(app) || !gate.epoch_is_current(epoch) {
            return Ok(());
        }
        match answer {
            Ok(Some(update)) => {
                let version = update.version.clone();
                if let Ok(mut pending) = app.state::<PendingUpdate>().0.lock() {
                    *pending = Some(update);
                }
                app.state::<DesktopUpdateState>()
                    .publish("available", Some(version.clone()), Some(now_ms()));
                state.update_pending.store(true, Ordering::Release);
                gate.queue_ui(UiProjection::Available(version));
                Ok(())
            }
            Ok(None) => {
                if let Ok(mut pending) = app.state::<PendingUpdate>().0.lock() {
                    *pending = None;
                }
                app.state::<DesktopUpdateState>().publish("current", None, Some(now_ms()));
                state.update_pending.store(false, Ordering::Release);
                gate.queue_ui(UiProjection::Current);
                Ok(())
            }
            Err(error) => {
                app.state::<DesktopUpdateState>().retain_phase("error");
                Err(error)
            }
        }
    });
    if let Some(Err(error)) = &applied { logging::log_once("updater check failed", error); }
    applied.unwrap_or(Ok(()))
}
```

`CheckGeneration::apply_if_current` makes pending, the pure tray flag, snapshot, and UI projection one ordered model transition with the install claim. It rejects a page result once the later tray check has started, regardless of completion order. The gate-owned `install_epoch` rejects a check that spans an install even if its generation is still current. `begin_if_not_installing` checks the flag again while holding that gate and publishes `"checking"` before releasing it. The single `start_ui_projection_worker` rechecks `latest_ui_revision` and performs Tauri setters without the gate; if a setter is already waiting on AppKit when a newer revision arrives, the worker applies the newer projection afterward. `page_status` uses `inspect` to read pending and the native phase against the same gate, so it cannot combine pending from before a completed check with phase from after it. In `start_background_checks` and the tray `check-updates` arm use `let _ = check_and_show(&app).await;` because the function itself logs an applied error and publishes `"error"`; the page command maps an applied error to fixed copy. A rejected stale error returns success without falsely replacing the current native state.

Append Rust tests under the existing `#[cfg(test)] mod tests` at `updater.rs:380-505`. Retain commit 2's `CheckGeneration` and `AtomicBool` imports; add `InstallClaim`, `UiProjection`, `Ordering`, and `std::sync::{mpsc, Arc}`. `CheckGeneration` and its private `ui`, `queue_ui`, and `apply_ui_projection_if_current` methods are accessible to these child-module tests.

Commit 2's inherited test `checking_publication_rechecks_install_claim_inside_the_gate` calls the commit-2 one-argument `claim_install(&installing)` and would stop compiling here. Replace its claim line in this commit:

```rust
-        assert!(checks.claim_install(&installing));
+        assert_eq!(checks.claim_install(&installing, || Some("2.66.0".into()), || {}), InstallClaim::Claimed);
```

The tray arm currently contains no `claim_install` call. After this change, `rg -n 'claim_install\(' desktop/src-tauri/src/{updater,tray}.rs` should show the new declaration, the shared `install_pending` call, and three-argument test calls, with no old one-argument call.

```rust
#[test]
fn install_claim_has_one_winner_and_can_retry_after_failure() {
    let gate = CheckGeneration::default();
    let installing = AtomicBool::new(false);
    assert_eq!(gate.claim_install(&installing, || Some("2.66.0".into()), || {}), InstallClaim::Claimed);
    assert_eq!(gate.install_epoch.load(Ordering::Acquire), 1);
    assert_eq!(gate.claim_install(&installing, || Some("2.66.0".into()), || {}), InstallClaim::Busy);
    assert_eq!(gate.install_epoch.load(Ordering::Acquire), 1);
    installing.store(false, Ordering::Release);
    assert_eq!(gate.claim_install(&installing, || Some("2.66.0".into()), || {}), InstallClaim::Claimed);
    assert_eq!(gate.install_epoch.load(Ordering::Acquire), 2);
}

#[test]
fn install_click_without_pending_leaves_in_flight_check_valid() {
    let gate = CheckGeneration::default();
    let installing = AtomicBool::new(false);
    let (generation, epoch) = gate.begin_if_not_installing(&installing, || {}).unwrap();
    let revision = gate.latest_ui_revision.load(Ordering::Acquire);
    let mut claimed_hook = false;
    assert_eq!(gate.claim_install(&installing, || None, || { claimed_hook = true; }), InstallClaim::NoPending);
    assert!(!claimed_hook);
    assert!(!installing.load(Ordering::Acquire));
    assert_eq!(gate.install_epoch.load(Ordering::Acquire), 0);
    assert_eq!(gate.latest_ui_revision.load(Ordering::Acquire), revision);
    // The check that was running when the stale Install click arrived still settles.
    assert!(gate.epoch_is_current(epoch));
    assert_eq!(gate.apply_if_current(generation, || "current"), Some("current"));
}

#[test]
fn page_check_started_before_tray_check_cannot_override_it_in_either_completion_order() {
    let gate = CheckGeneration::default();
    let installing = AtomicBool::new(false);
    let mut pending = Some("previous");
    let mut phase = "available";

    let (page, _) = gate.begin_if_not_installing(&installing, || { phase = "checking"; }).unwrap();
    let (tray, _) = gate.begin_if_not_installing(&installing, || { phase = "checking"; }).unwrap();
    assert_eq!(gate.apply_if_current(page, || { pending = None; phase = "current"; }), None);
    assert_eq!((pending, phase), (Some("previous"), "checking"));
    assert_eq!(gate.apply_if_current(tray, || { pending = Some("tray"); phase = "available"; }), Some(()));
    assert_eq!((pending, phase), (Some("tray"), "available"));

    let (page, _) = gate.begin_if_not_installing(&installing, || { phase = "checking"; }).unwrap();
    let (tray, _) = gate.begin_if_not_installing(&installing, || { phase = "checking"; }).unwrap();
    assert_eq!(gate.apply_if_current(tray, || { pending = Some("new tray"); phase = "available"; }), Some(()));
    assert_eq!(gate.apply_if_current(page, || { pending = None; phase = "current"; }), None);
    assert_eq!((pending, phase), (Some("new tray"), "available"));
}

#[test]
fn install_claim_cannot_land_between_check_guard_and_pending_tray_write() {
    let gate = Arc::new(CheckGeneration::default());
    let installing = Arc::new(AtomicBool::new(false));
    let (generation, epoch) = gate.begin_if_not_installing(&installing, || {}).unwrap();
    let (attempt_tx, attempt_rx) = mpsc::channel();
    let (claimed_tx, claimed_rx) = mpsc::channel();
    let mut pending = None;
    let mut tray_visible = false;

    let claim_thread = gate.apply_if_current(generation, || {
        assert!(!installing.load(Ordering::Acquire)); // result guard
        assert!(gate.epoch_is_current(epoch));
        let claim_gate = Arc::clone(&gate);
        let claim_flag = Arc::clone(&installing);
        let thread = std::thread::spawn(move || {
            attempt_tx.send(()).unwrap();
            claimed_tx.send(claim_gate.claim_install(&claim_flag, || Some("signed update".into()), || {})).unwrap();
        });
        attempt_rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        // Force the claim attempt while this application still owns the gate.
        assert_eq!(claimed_rx.recv_timeout(std::time::Duration::from_millis(25)),
            Err(mpsc::RecvTimeoutError::Timeout));
        pending = Some("signed update");
        tray_visible = true;
        assert!(!installing.load(Ordering::Acquire));
        thread
    }).unwrap();
    assert_eq!((pending, tray_visible), (Some("signed update"), true));
    assert_eq!(claimed_rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap(), InstallClaim::Claimed);
    claim_thread.join().unwrap();
    assert!(installing.load(Ordering::Acquire));
    assert!(!gate.epoch_is_current(epoch));
}

#[test]
fn status_read_completes_while_check_ui_setter_is_blocked() {
    let gate = Arc::new(CheckGeneration::default());
    let installing = AtomicBool::new(false);
    let (generation, _) = gate.begin_if_not_installing(&installing, || {}).unwrap();
    let mut pending = None;
    assert_eq!(gate.apply_if_current(generation, || {
        pending = Some("signed update");
        gate.queue_ui(UiProjection::Available("2.66.0".into()));
    }), Some(()));
    let projected = gate.ui.borrow().clone().unwrap();
    let (setter_entered_tx, setter_entered_rx) = mpsc::channel();
    let (status_returned_tx, status_returned_rx) = mpsc::channel();
    let setter_gate = Arc::clone(&gate);
    let setter = std::thread::spawn(move || setter_gate.apply_ui_projection_if_current(
        projected, |_| {
            setter_entered_tx.send(()).unwrap();
            // Fake a Tauri setter waiting on AppKit; it finishes only after status returns.
            status_returned_rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        },
    ));
    setter_entered_rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
    let read_gate = Arc::clone(&gate);
    let (read_tx, read_rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        read_tx.send(read_gate.inspect(|| "available")).unwrap();
    });
    assert_eq!(read_rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap(), "available");
    status_returned_tx.send(()).unwrap();
    reader.join().unwrap();
    assert!(setter.join().unwrap());
    assert_eq!(pending, Some("signed update"));
}

#[test]
fn superseded_ui_projection_never_enters_its_setter() {
    let gate = CheckGeneration::default();
    gate.inspect(|| gate.queue_ui(UiProjection::Current));
    let old = gate.ui.borrow().clone().unwrap();
    gate.inspect(|| gate.queue_ui(UiProjection::Available("2.66.0".into())));
    let newest = gate.ui.borrow().clone().unwrap();
    assert!(!gate.apply_ui_projection_if_current(old, |_| panic!("stale setter ran")));
    let mut applied = false;
    assert!(gate.apply_ui_projection_if_current(newest, |_| applied = true));
    assert!(applied);
}
```

The first test checks the successful/busy/retry claim sequence. The second checks that `NoPending` leaves an in-flight check valid. The third forces a page `None` result before and after a later-started tray `Some` result; both orders leave the tray's pending version and phase intact. The fourth injects a competing claim after the result guard but before the modeled pending/tray model writes, proves the claim cannot complete while the application closure owns the mutex, then proves it completes afterward and increments the epoch. The fifth runs the production projection-application seam with a fake setter that blocks until the concurrent `inspect` read completes; the one-second channel deadline makes a regression fail instead of hanging. The sixth rejects a queued projection superseded before its setter starts. The page contract test below checks that both page and tray call `check_and_show` and `install_pending`. A packaged signed-update test is left to the desktop CI lane; a unit test cannot safely replace the running application.

### MODIFY `desktop/src-tauri/src/tray.rs`

At current HEAD, `tray.rs:225-250` takes `PendingUpdate` before any gate claim and calls the menu/snapshot setters directly. This is the reviewer High carried from wp2. The exact current arm is the **Before** block:

```rust
"install-update" => {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let update = app
            .state::<crate::updater::PendingUpdate>()
            .0
            .lock()
            .ok()
            .and_then(|mut pending| pending.take());
        let Some(update) = update else { return; };
        let version = update.version.clone();
        let retry_update = update.clone();
        set_installing(&app, &version);
        if let Err(error) = updater::install(&app, update).await {
            if let Ok(mut pending) = app.state::<crate::updater::PendingUpdate>().0.lock() {
                *pending = Some(retry_update);
            }
            set_install_failed(&app, &version);
            crate::logging::log_once("updater install failed", &error);
        }
    });
}
```

The **After** block replaces it. Both page and tray then enter `updater::install_pending`, which calls `gate.claim_install(&state.installing, pending_version, on_claim)` and handles `Claimed`, `Busy`, and `NoPending` before taking the signed update:

```rust
"install-update" => {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = updater::install_pending(&app).await {
            crate::logging::log_once("updater install failed", &error);
        }
    });
}
```

Keep `TrayState.installing` as the single flag; `CheckGeneration` owns `install_epoch`, so do not add an epoch field to `TrayState`. Replace current `set_installing` at `tray.rs:338-351` with this setter-only function, invoked solely by `start_ui_projection_worker`:

```rust
pub fn show_installing(app: &AppHandle, version: &str) {
    if let Some(menu) = menu_handles(app) {
        let _ = menu.install_update.set_text(format!("Installing update v{version}…"));
        let _ = menu.install_update.set_enabled(false);
        let _ = menu.check_updates.set_enabled(false);
    }
}
```

The deleted before-lines are `state.installing.store(true, Ordering::Release)` and `DesktopUpdateState::retain_phase("installing")`; the gate's claim now owns both. Delete private `set_install_failed` at `tray.rs:353-360`; `install_pending` publishes `"install-failed"` under the gate after restoration. Keep `is_installing`, `show_update_available`, `show_up_to_date`, `TrayState.update_pending`, and commit-2 icon updates; all updater-driven calls to those menu/icon/overlay setters go through the worker. In the check arm at `tray.rs:219-224`, use `let _ = updater::check_and_show(&app).await;` for its new `Result` contract. Both menu handlers already spawn async tasks before touching updater state; keep gate reads inside those tasks. Title refresh reads only `TrayState.update_pending` atomically. `TrayState` still exists without a rendered tray: `lib.rs:232` manages it before `startup::begin` at `lib.rs:272`, so Linux without an AppIndicator host has the same claim path.

### MODIFY `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/src/startup.rs`, `desktop/src-tauri/src/window.rs`

Add these commands before `run()` in `lib.rs`, and append their names to the existing `generate_handler!` at current `lib.rs:214-222`. The origin guard uses the actual requesting `WebviewWindow`, not a URL string supplied by JavaScript. `window::require_update_page` is defined below.

```rust
#[tauri::command]
async fn update_status(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<updater::PageUpdateStatus, String> {
    window::require_update_page(&window)?;
    Ok(updater::page_status(&app))
}

#[tauri::command]
async fn update_check(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<updater::PageUpdateStatus, String> {
    window::require_update_page(&window)?;
    updater::check_and_show(&app).await
        .map_err(|_| "the update check failed; try again".to_owned())?;
    Ok(updater::page_status(&app))
}

#[tauri::command]
async fn update_install(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<updater::PageUpdateStatus, String> {
    window::require_update_page(&window)?;
    updater::install_pending(&app).await.map_err(|error| {
        logging::log_once("updater install failed", &error);
        "the update could not be installed; try again".to_owned()
    })
}

#[tauri::command]
fn return_to_dashboard(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    window::require_update_page(&window)?;
    startup::return_to_dashboard(&app)
}
```

`update_status` is deliberately an async Tauri command: the pinned synchronous command wrapper can run inline on the AppKit thread, and `page_status` waits for `CheckGeneration::inspect`. `update_check` and `update_install` are already async and may call `page_status` or `claim_install` after an await. `return_to_dashboard` has no gate read and stays synchronous. Do not add a direct `inspect`, `claim_install`, or pending-lock read to a synchronous Tauri command or tray menu callback; spawn an async task first. This command contract and the blocked-setter regression below must be checked before the wp3 audit.

In `window.rs` add after the existing private `is_app_origin` at lines 71-77:

```rust
pub fn require_update_page(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" { return Err("update page unavailable".into()); }
    let url = window.url().map_err(|_| "update page unavailable")?;
    if !is_update_page_url(&url) {
        return Err("update page unavailable".into());
    }
    Ok(())
}

fn is_update_page_url(url: &Url) -> bool {
    is_app_origin(url) && url.path() == "/update.html"
}
```

Tighten `is_app_origin`'s `"tauri"` arm from `true` to `url.host_str() == Some("localhost") && url.port().is_none()`; keep the Windows `http://tauri.localhost` arm. This is the exact packaged URL: `tauri://localhost/update.html` on macOS/Linux and `http://tauri.localhost/update.html` on Windows (`window.rs:61-75`). The bound loopback dashboard is `http://127.0.0.1:<resolved port>` (`window.rs:45-56`) and fails the command guard. Extend the existing `window.rs:131-226` test module's `use super` import with `is_update_page_url` and add:

```rust
#[test]
fn only_the_bundled_update_page_has_update_commands() {
    for value in ["tauri://localhost/update.html", "http://tauri.localhost/update.html"] {
        assert!(is_update_page_url(&url(value)), "{value}");
    }
    for value in ["http://127.0.0.1:10100/update.html", "tauri://evil/update.html",
                  "tauri://localhost/index.html", "http://tauri.localhost/update.html.evil"] {
        assert!(!is_update_page_url(&url(value)), "{value}");
    }
}
```

`startup::open_dashboard` cannot serve as the return command: its `navigate_once` gate at `startup.rs:1472-1481` has already been consumed. Add below `open_dashboard` at line 1461:

```rust
pub fn return_to_dashboard(app: &AppHandle) -> Result<(), String> {
    let startup = app.try_state::<Startup>().ok_or("dashboard is not ready")?;
    let dashboard = startup.ready_dashboard();
    let window = app.get_webview_window("main").ok_or("dashboard window is unavailable")?;
    return_ready_dashboard(dashboard.as_deref(), |url| navigate_dashboard(&window, url))?;
    crate::window::show(&window);
    Ok(())
}

fn return_ready_dashboard(dashboard: Option<&str>, navigate: impl FnOnce(&str) -> bool) -> Result<(), String> {
    let dashboard = dashboard.ok_or("dashboard is not ready")?;
    if !navigate(dashboard) { return Err("dashboard could not be opened".into()); }
    Ok(())
}
```

The existing `ready_dashboard` accessor is at `startup.rs:498-503`, and `navigate_dashboard` is at `startup.rs:1483-1489`. Add this inline test in `startup.rs`'s existing test module, importing `return_ready_dashboard`:

```rust
#[test]
fn update_page_return_requires_a_ready_dashboard_and_retries_refused_navigation() {
    assert_eq!(return_ready_dashboard(None, |_| true).unwrap_err(), "dashboard is not ready");
    assert_eq!(return_ready_dashboard(Some("http://127.0.0.1:10100/#/usage"), |_| false).unwrap_err(), "dashboard could not be opened");
    let mut visited = None;
    assert!(return_ready_dashboard(Some("http://127.0.0.1:10100/#/usage"), |url| {
        visited = Some(url.to_owned());
        true
    }).is_ok());
    assert_eq!(visited.as_deref(), Some("http://127.0.0.1:10100/#/usage"));
}
```

Do not bypass `ready_dashboard` with a hardcoded port or local storage. Do not widen `capabilities/dashboard-zoom.json:1-8`: it grants only zoom to the loopback origin. `capabilities/default.json:1-12` is local-app-only and needs no new permission entry for these app commands; custom commands are registered in `generate_handler!`, and the Rust page-origin guard is the authority. If Tauri's generated capability schema demands a custom-command permission at implementation, add a separate capability scoped to the app origin only; never place updater commands in the `remote.urls` capability.

### MODIFY `gui/src/lib/desktop-shell.ts`, `gui/src/App.tsx`, `gui/src/components/sidebar-github-row.tsx`, `gui/src/pages/use-dashboard-data.ts`

Append to `desktop-shell.ts` (using the existing `isDesktopShell` at lines 11-13 and `hostOs` at lines 29-34):

```ts
export function desktopUpdatePageUrl(ua = currentUserAgent()): string | null {
  if (!isDesktopShell(ua)) return null;
  const os = hostOs(ua);
  if (os === "windows") return "http://tauri.localhost/update.html";
  if (os === "macos" || os === "linux") return "tauri://localhost/update.html";
  return null;
}

export function openDesktopUpdatePage(ua = currentUserAgent()): boolean {
  const url = desktopUpdatePageUrl(ua);
  if (!url) return false;
  window.location.assign(url);
  return true;
}
```

In `App.tsx:29`, import `openDesktopUpdatePage`; replace the `onOpenUpdate` body at `App.tsx:456-462` with:

```tsx
onOpenUpdate={() => {
  setNavOpen(false);
  if (openDesktopUpdatePage()) return;
  navigateToPage("dashboard", "update");
}}
```

In `use-dashboard-data.ts:1-6`, import `openDesktopUpdatePage`; prepend `if (openDesktopUpdatePage()) return;` to `openUpdateDialog` at line 861. This catches the dashboard maintenance anchor (`dashboard-overview-sections.tsx:219-229`) and cold `#dashboard/update` deep links consumed at `use-dashboard-data.ts:887-901`; it executes before `fetchUpdateCheck` or `/api/update/run`. The normal browser path then executes the unchanged package dialog. `runUpdate` at lines 903-919 remains unchanged and unreachable from the desktop entry path.

Commit 2 already replaces `sidebar-github-row.tsx`'s badge request with `updateBadgeUrl`, changes the desktop poll to 60 seconds while retaining the 10-minute `BADGE_POLL_MS` browser default, and extends `UpdateBadge.installer` to `"desktop"` ([020_phase2_desktop_state_icons.md](020_phase2_desktop_state_icons.md), “Embedded GUI poll”, `badgePoll`). Keep that exact code. In wp3 import `isDesktopShell` from `../lib/desktop-shell` and replace only the label expression at current lines 127-131 with:

```tsx
const updateLabel = updateAvailable && latestVersion
  ? t("sidebar.updateAvailable", { version: latestVersion })
  : isDesktopShell() ? t("sidebar.desktopUpdate") : t("sidebar.checkUpdate");
```

This is the only new GUI copy. Update the top comment at lines 10-14 and prop comment at line 51 to describe the two destinations.

### MODIFY all ten GUI catalogs

Add one key adjacent to `sidebar.checkUpdate` (source at `gui/src/i18n/en.ts:92-93`) in every catalog. The page's English copy is outside React/i18n, matching the English-only bootstrap page.

| Path | Exact key/value to add |
| --- | --- |
| `gui/src/i18n/en.ts` | `"sidebar.desktopUpdate": "Open desktop updates",` |
| `gui/src/i18n/de.ts` | `"sidebar.desktopUpdate": "Desktop-Updates öffnen",` |
| `gui/src/i18n/fr.ts` | `"sidebar.desktopUpdate": "Ouvrir les mises à jour de l’application",` |
| `gui/src/i18n/ja.ts` | `"sidebar.desktopUpdate": "デスクトップアプリの更新を開く",` |
| `gui/src/i18n/ko.ts` | `"sidebar.desktopUpdate": "데스크톱 앱 업데이트 열기",` |
| `gui/src/i18n/ru.ts` | `"sidebar.desktopUpdate": "Открыть обновления приложения",` |
| `gui/src/i18n/tr.ts` | `"sidebar.desktopUpdate": "Masaüstü güncellemelerini aç",` |
| `gui/src/i18n/vi.ts` | `"sidebar.desktopUpdate": "Mở cập nhật ứng dụng máy tính",` |
| `gui/src/i18n/zh.ts` | `"sidebar.desktopUpdate": "打开桌面应用更新",` |
| `gui/src/i18n/zh-TW.ts` | `"sidebar.desktopUpdate": "開啟桌面應用程式更新",` |

### NEW `tests/clients/desktop-update-surface.test.ts` — full file

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { repoPath } from "../helpers/repo-root";

const read = (path: string) => readFileSync(repoPath(path), "utf8");
const page = read("desktop/ui/update.html");
const lib = read("desktop/src-tauri/src/lib.rs");
const updater = read("desktop/src-tauri/src/updater.rs");
const tray = read("desktop/src-tauri/src/tray.rs");
const windowPolicy = read("desktop/src-tauri/src/window.rs");

function evaluatePage(invoke?: (name: string) => Promise<unknown>) {
  const script = page.match(/<script nonce="__TAURI_SCRIPT_NONCE__">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("update page script missing");
  const handlers = new Map<string, () => void>();
  const nodes = new Map(["state", "error", "check", "install", "back"].map(id => [id, {
    textContent: "", hidden: true, disabled: false,
    addEventListener: (name: string, callback: () => void) => { handlers.set(`${id}:${name}`, callback); },
  }]));
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  runInNewContext(script, {
    window: { __TAURI__: invoke ? { core: { invoke } } : undefined },
    document: { querySelector: (selector: string) => nodes.get(selector.slice(1)) },
    setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    Promise, Error,
  });
  return { nodes, timers, handlers };
}

async function settle() { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }

describe("bundled desktop update surface", () => {
  test("ships a nonce-bearing app page with only four native commands", () => {
    expect(page).toContain('<script nonce="__TAURI_SCRIPT_NONCE__">');
    for (const command of ["update_status", "update_check", "update_install", "return_to_dashboard"]) {
      expect(page).toContain(`"${command}"`);
      expect(lib).toContain(command);
    }
    expect(page).not.toContain("/api/update/run");
    expect(page).not.toMatch(/\b(?:alert|confirm|prompt)\s*\(/);
  });
  test("keeps install authority on the app page and shares the install claim", () => {
    expect(lib).toContain("window::require_update_page(&window)?");
    expect(windowPolicy).toContain('url.path() == "/update.html"');
    expect(tray).toContain("updater::install_pending(&app).await");
    expect(lib).toContain("updater::install_pending(&app).await");
    expect(tray).toContain("updater::check_and_show(&app).await");
    expect(lib).toContain("updater::check_and_show(&app).await");
    expect(updater).toContain("pub fn claim_install(");
    expect(updater).toContain("compare_exchange(false, true");
    expect(updater).toContain("gate.begin_if_not_installing(&state.installing");
    expect(updater).toContain("gate.apply_if_current(generation");
    expect(updater).toContain("start_ui_projection_worker");
    expect(lib).toContain("async fn update_status(");
    expect(updater).toContain("!gate.epoch_is_current(epoch)");
    expect(updater).toContain("app.state::<CheckGeneration>().inspect(||");
    expect(updater).toContain("= Some(retry_update);");
  });
  test("a page outside Tauri disables updater actions", () => {
    const { nodes } = evaluatePage();
    expect(nodes.get("state")?.textContent).toContain("Open this page from");
    expect(nodes.get("check")?.disabled).toBe(true);
    expect(nodes.get("install")?.disabled).toBe(true);
    expect(nodes.get("back")?.disabled).toBe(true);
  });
  test("a silent native status call becomes a visible retryable error", async () => {
    const { nodes, timers } = evaluatePage(() => new Promise(() => {}));
    expect(timers.size).toBe(1);
    timers.values().next().value?.();
    await settle();
    expect(nodes.get("error")?.hidden).toBe(false);
    expect(nodes.get("error")?.textContent).toContain("did not answer within 5000 ms");
    expect(nodes.get("check")?.disabled).toBe(false);
  });
  test("a silent native check reports its 60 second deadline", async () => {
    const status = { currentVersion: "2.65.0", latestVersion: null, available: false, installing: false, checking: false };
    const { nodes, timers, handlers } = evaluatePage(name =>
      name === "update_status" ? Promise.resolve(status) : new Promise(() => {}));
    await settle();
    handlers.get("check:click")?.();
    expect(timers.size).toBe(1);
    timers.values().next().value?.();
    await settle();
    expect(nodes.get("error")?.textContent).toContain("60000 ms");
  });
  test("an install timeout re-reads a still-held native claim", async () => {
    let installing = false;
    const status = { currentVersion: "2.65.0", latestVersion: "2.66.0", available: true, installing: false, checking: false };
    const { nodes, timers, handlers } = evaluatePage(name => {
      if (name === "update_status") return Promise.resolve({ ...status, installing });
      if (name === "update_install") { installing = true; return new Promise(() => {}); }
      return Promise.reject(new Error("unexpected command"));
    });
    await settle();
    handlers.get("install:click")?.();
    timers.values().next().value?.();
    await settle();
    expect(nodes.get("error")?.textContent).toContain("600000 ms");
    expect(nodes.get("install")?.disabled).toBe(true);
  });
  test("a page check superseded by a tray check stays checking until the tray result settles", async () => {
    const current = { currentVersion: "2.65.0", latestVersion: null, available: false, installing: false, checking: false };
    const checking = { ...current, checking: true };
    const trayResult = { ...current, latestVersion: "2.66.0", available: true };
    let nativeStatus = current;
    const { nodes, timers, handlers } = evaluatePage(name => {
      if (name === "update_check") { nativeStatus = checking; return Promise.resolve(checking); }
      if (name === "update_status") return Promise.resolve(nativeStatus);
      return Promise.reject(new Error("unexpected command"));
    });
    await settle();
    handlers.get("check:click")?.();
    await settle();
    expect(nodes.get("state")?.textContent).toBe("Checking for updates…");
    expect(nodes.get("state")?.textContent).not.toContain("up to date");
    nativeStatus = trayResult; // the newer tray/background generation completes
    const timer = [...timers.entries()][0];
    if (!timer) throw new Error("checking status did not schedule a poll");
    const [pollId, poll] = timer;
    timers.delete(pollId);
    poll();
    await settle();
    expect(nodes.get("state")?.textContent).toContain("Update v2.66.0 is available");
    expect(nodes.get("install")?.disabled).toBe(false);
    expect(timers.size).toBe(0);
  });
});
```

The first test asserts the command names used by the page and registered by Rust; it catches inadvertent package-update routing. The second is source-oracle coverage only; the Rust gate tests prove ordering and the claim boundary. The supersession test exercises the rendered checking state and 1 s status poll, while packaged smoke proves navigation. Add the new file to both JSON registries, in the existing `desktop-*` explicit group (`scripts/test-layout/layout.json:777-792`, `tests/fixtures/test-layout-expected.json:603-618`):

```json
"desktop-update-surface.test.ts": "clients",
```

### MODIFY `gui/tests/desktop-shell.test.ts`

Add `desktopUpdatePageUrl` to the import at lines 2-7. Add tests after the current OS test (lines 22-34):

```ts
test("routes bundled updates to each platform's exact app origin", () => {
  expect(desktopUpdatePageUrl(tauriMac)).toBe("tauri://localhost/update.html");
  expect(desktopUpdatePageUrl(tauriLinux)).toBe("tauri://localhost/update.html");
  expect(desktopUpdatePageUrl(tauriWindows)).toBe("http://tauri.localhost/update.html");
  expect(desktopUpdatePageUrl("Mozilla/5.0 Chrome/140.0")).toBeNull();
});
```

Do not add a second badge helper or parser in wp3. Commit 2's `desktopSession` and `updateBadgeUrl` tests cover browser/package, valid desktop session, and missing desktop session ([020_phase2_desktop_state_icons.md](020_phase2_desktop_state_icons.md), “Embedded GUI poll”, `gui/tests/desktop-shell.test.ts`). The page navigation test above covers the new URL helper; packaged smoke exercises the actual `location.assign` transition. `gui/tests/desktop-shell.test.ts` is an existing GUI test and is not in the Bun test-layout registries.

### MODIFY structure and public docs

`structure/desktop-shell.md:149-159` — after the update ordering paragraph, insert this exact present-tense contract (commit 2's snapshot paragraph remains):

```md
The embedded dashboard sends both update entries to the bundled `desktop/ui/update.html`
on the app origin. Its page is the only WebView route accepted by the four native update
commands. Tray and page installation share one atomic claim before taking `PendingUpdate`;
a failed download or drain restores that pending signed update and reenables retry. The
page returns through the startup sequence's resolved dashboard URL, independently of the
one-time initial navigation claim. The loopback dashboard has no updater IPC permission.
```

`structure/gui-and-management-api.md:40-49` — add after the dashboard serving paragraph:

```md
Inside the Tauri shell, the sidebar and Dashboard maintenance update entries navigate to
the bundled desktop update page. The sidebar reads the session-scoped desktop badge;
an absent session remains unknown. Ordinary browser dashboards retain package badge and
`/api/update/check`/`/api/update/run`. No proxy route installs a desktop update.
```

Review `structure/companion.md:1-5`: its companion display contract remains accurate and needs no text change. No `structure/manifest.json` or generated `structure/INDEX.md` edit: both owning docs already map these areas (`structure/INDEX.md:105,151`, per `000_plan.md`).

`docs-site/src/content/docs/guides/desktop-app.md:96-103` — append to Updates:

```md
In the desktop app, choose the dashboard's update button to open the app's update page.
There you can check again, install a pending signed update, or return to the dashboard.
The same install action is available from the tray menu. If installation fails, the
pending update remains available for retry. This page also works on Linux when the
desktop has no tray icon. A normal browser dashboard manages the package installation
on that proxy instead.
```

`docs-site/src/content/docs/guides/macos-menu-bar.md:24` — after the menu description add: `The desktop dashboard's update button opens the app's own update page; it checks and installs the same signed update as the tray menu.`

`docs-site/src/content/docs/guides/web-dashboard.md:102` — append to the Maintenance cell: `In the desktop shell, its update entry opens the native app update page instead of running the package updater.`

MODIFY the seven existing locale siblings of each of those three guides:

| Locale | Desktop guide | macOS guide | Dashboard guide |
| --- | --- | --- | --- |
| fr | `docs-site/src/content/docs/fr/guides/desktop-app.md` | `docs-site/src/content/docs/fr/guides/macos-menu-bar.md` | `docs-site/src/content/docs/fr/guides/web-dashboard.md` |
| ja | `docs-site/src/content/docs/ja/guides/desktop-app.md` | `docs-site/src/content/docs/ja/guides/macos-menu-bar.md` | `docs-site/src/content/docs/ja/guides/web-dashboard.md` |
| ko | `docs-site/src/content/docs/ko/guides/desktop-app.md` | `docs-site/src/content/docs/ko/guides/macos-menu-bar.md` | `docs-site/src/content/docs/ko/guides/web-dashboard.md` |
| ru | `docs-site/src/content/docs/ru/guides/desktop-app.md` | `docs-site/src/content/docs/ru/guides/macos-menu-bar.md` | `docs-site/src/content/docs/ru/guides/web-dashboard.md` |
| tr | `docs-site/src/content/docs/tr/guides/desktop-app.md` | `docs-site/src/content/docs/tr/guides/macos-menu-bar.md` | `docs-site/src/content/docs/tr/guides/web-dashboard.md` |
| zh-cn | `docs-site/src/content/docs/zh-cn/guides/desktop-app.md` | `docs-site/src/content/docs/zh-cn/guides/macos-menu-bar.md` | `docs-site/src/content/docs/zh-cn/guides/web-dashboard.md` |
| zh-tw | `docs-site/src/content/docs/zh-tw/guides/desktop-app.md` | `docs-site/src/content/docs/zh-tw/guides/macos-menu-bar.md` | `docs-site/src/content/docs/zh-tw/guides/web-dashboard.md` |

In each desktop guide, translate the exact new English semantics in place: the desktop button opens the bundled app page; check/install/retry/return use the signed native updater; Linux needs no tray; browser dashboards retain package updates. In each macOS guide translate the one-sentence tray/page equivalence. In each web-dashboard Maintenance table translate only the desktop exception. Do not copy English into localized prose and do not change existing package-update instructions. All 21 sibling paths are MODIFY; no new locale files are created.

## Field/value chains (PLAN-FIELD-CHAIN-01)

| New field/route/state | Creation | Serialization | Deserialization | Every consumer |
| --- | --- | --- | --- | --- |
| `PageUpdateStatus.current_version` → `currentVersion` | `desktop/src-tauri/src/updater.rs::page_status`, from `CARGO_PKG_VERSION` | Tauri `serde` camelCase command reply in `lib.rs` | `desktop/ui/update.html::call` JSON object | `render` installed-version copy; no persistence |
| `latest_version` → `latestVersion`, `available` | `PendingUpdate` under its mutex in `updater.rs::page_status` inside `CheckGeneration::inspect` | same Tauri reply | same page | page pending copy and install-button enabled state |
| `installing` | `TrayState.installing` CAS in `CheckGeneration::claim_install` | same Tauri reply | same page | page busy copy/buttons; tray's existing `is_installing` check and menu state; commit-2 snapshot/icon publication |
| `checking` | `DesktopUpdateState` phase read in `updater.rs::page_status` under `CheckGeneration::inspect` | `PageUpdateStatus.checking` becomes camelCase `checking` in Tauri reply | `desktop/ui/update.html::call` JSON object | `render` shows Checking, schedules 1 s `update_status` polls, and clears the timer after a settled phase; a superseded page command cannot render up to date while a newer check runs |
| native check generation and UI revision (commit 2, reused here) | `updater.rs::CheckGeneration::begin_if_not_installing` in `check_and_show`, for background, tray, and page calls; accepted model transitions queue a revisioned UI projection | N/A, process-local atomics and watch channel | N/A | `CheckGeneration::apply_if_current` wraps pending/tray model/snapshot writes; `inspect` gives the page a consistent status; the serialized UI worker rechecks revision and applies setters outside the gate |
| `install_epoch` | `CheckGeneration::default` starts at 0; successful gate-owned `claim_install` increments it under the same mutex as check application | N/A, process-local atomic | N/A | `check_and_show` drops a result older than the most recent claim; forced-interleaving Rust claim test |
| `desktop_session` query key (commit 2, unchanged here) | `desktop/src-tauri/src/startup.rs` dashboard URL from `DesktopUpdateState.session_id` | URL search parameter to embedded dashboard; commit-2 badge GET `session` query through `updateBadgeUrl` | commit-2 `desktopSession` in `gui/src/lib/desktop-shell.ts`; server badge query | `SidebarGithubRow` polling key and `/api/update/badge?surface=desktop`; absent value gives unknown, not package fallback |
| `update_status`, `update_check`, `update_install`, `return_to_dashboard` commands | `generate_handler!` in `desktop/src-tauri/src/lib.rs` | Tauri invoke command names and serde reply | bundled page `call` | status/check/install/return buttons; no HTTP route and no browser consumer |
| app-origin URLs | `desktopUpdatePageUrl` from existing OS detector | `window.location.assign` main WebView navigation | `window::navigation_allowed` and `require_update_page` | bundled update page; no session token in URL |
| `sidebar.desktopUpdate` | ten GUI catalogs | existing i18n `t` lookup | `SidebarGithubRow` | desktop button accessible name/title only; N/A native page because it is English-only like bootstrap |

## Conditional activation and visible proof (C-ACTIVATION-GROUNDING-01)

| Guard/fallback/error | Test activation scenario | Observable effect |
| --- | --- | --- |
| Browser vs desktop branch | GUI test with ordinary, macOS/Linux, and Windows user agents | Browser keeps `#dashboard/update` and package badge; desktop chooses exact app URL |
| Desktop session absent/expired | GUI helper test with missing key; commit-2 badge test with expired snapshot | Sidebar has no installable dot; button still opens native page; no package fallback |
| Wrong origin/path/window command request | Rust pure URL tests, plus source-oracle command guard test | Fixed `update page unavailable`; no updater work |
| No native bridge | `tests/clients/desktop-update-surface.test.ts`: `a page outside Tauri disables updater actions` | Check/install/return disabled; text says open from app |
| IPC handshake timeout (5 s) | Same file: `a silent native status call becomes a visible retryable error` with a never-settling promise | Inline alert text and enabled Check retry; no silent spinner |
| Native check timeout (60 s) | `tests/clients/desktop-update-surface.test.ts`: `a silent native check reports its 60 second deadline` | Inline check error; the native check may still finish, so reopening the page reads fresh native status |
| Native install timeout (10 min) | Same file: `an install timeout re-reads a still-held native claim` | Inline install error; status is re-read and a still-held native claim keeps Install disabled |
| Check failure | Fake updater check failure in Rust test or packaged test with unavailable endpoint | Page shows retryable failure; pending state is not falsely cleared |
| Page check starts, tray check starts later and completes last | Rust `page_check_started_before_tray_check_cannot_override_it_in_either_completion_order`; bundled-page `a page check superseded by a tray check stays checking until the tray result settles` | Page's old `None` cannot clear pending, tray menu, or snapshot; its command returns `checking: true` while the tray check runs, then the poll renders the tray's settled `Some`. The inverse completion order is also tested |
| Two concurrent installs | Rust `install_claim_has_one_winner_and_can_retry_after_failure` | Exactly one CAS succeeds; second call fails before taking `PendingUpdate` |
| Install claim attempted after a check's guard but before its pending/tray write | Rust `install_claim_cannot_land_between_check_guard_and_pending_tray_write` uses a second thread and channel at the application closure | Claim cannot finish until the check's pending/tray model is written and the gate unlocks; epoch then changes. Commit-2 `checking_publication_rechecks_install_claim_inside_the_gate` covers the initial publication |
| Status IPC arrives while a check's menu/icon projection waits on AppKit | Rust `status_read_completes_while_check_ui_setter_is_blocked` holds a fake setter until a concurrent gated status read returns; source-oracle test requires `async fn update_status` | The read returns within the deadline with the setter still blocked; Tauri executes the async command away from the AppKit thread, and no projection worker holds the gate while applying UI |
| A queued menu/icon projection is superseded before its setter begins | Rust `superseded_ui_projection_never_enters_its_setter` runs the production atomic revision check against two queued projections | The older setter is skipped; the latest revision remains eligible for the serialized worker |
| Check completes after a failed install | Rust claim/epoch test plus updater source-oracle assertion; integration check deliberately delayed past failure | Old check result is discarded; restored `PendingUpdate` stays available |
| Pending missing | Rust install-claim state test with empty pending | `no update is ready to install`; claim released and check remains usable |
| Download/signature or drain failure | Desktop integration fixture/packaged failure; source-oracle restoration assertion | Original `PendingUpdate` restored, badge/tray reenabled, error shown on page |
| Dashboard not Ready or navigation refused | Rust return-navigation helper test | Page stays visible with error and enabled Back retry; no guessed port |
| Linux no tray host | Packaged Linux smoke with unavailable AppIndicator host | Dashboard button opens page and installs from `TrayState` claim without a rendered icon |

## Ratchet and validation

At this HEAD, `tests/fixtures/file-size-baseline.json:1-30` exempts the ten planned i18n files; every other planned scanned file lacks a per-file baseline and therefore has the 2,000-line threshold (`scripts/file-size-ratchet.ts:4-20,114-125`). New `tests/clients/desktop-update-surface.test.ts` starts at 0/2000; new `desktop/ui/update.html` starts at 0/N/A because HTML is not scanned. The following counts are current after commits 1-2 and before wp3:

| Paths, in the order named | Current lines / cap |
| --- | --- |
| `gui/src/App.tsx`; `gui/src/components/sidebar-github-row.tsx`; `gui/src/pages/use-dashboard-data.ts`; `gui/src/lib/desktop-shell.ts`; `gui/tests/desktop-shell.test.ts` | 527/2000; 163/2000; 951/2000; 46/2000; 51/2000 |
| `scripts/test-layout/layout.json`; `tests/fixtures/test-layout-expected.json` | 1817/2000; 1623/2000 |
| `structure/desktop-shell.md`; `structure/gui-and-management-api.md` | 390/2000; 395/2000 |
| English `docs-site/src/content/docs/guides/{desktop-app,macos-menu-bar,web-dashboard}.md` | 126/2000; 56/2000; 380/2000 |
| fr guide paths in the locale table above, left to right | 83/2000; 56/2000; 238/2000 |
| ja guide paths, left to right | 83/2000; 56/2000; 199/2000 |
| ko guide paths, left to right | 83/2000; 56/2000; 251/2000 |
| ru guide paths, left to right | 128/2000; 56/2000; 211/2000 |
| tr guide paths, left to right | 83/2000; 56/2000; 309/2000 |
| zh-cn guide paths, left to right | 83/2000; 56/2000; 186/2000 |
| zh-tw guide paths, left to right | 83/2000; 56/2000; 187/2000 |
| `gui/src/i18n/{en,de,fr,ja,ko,ru,tr,vi,zh,zh-TW}.ts` | 3226, 3190, 3179, 3212, 3212, 3213, 3213, 3182, 3211, 3176 / exempt |
| `desktop/src-tauri/src/{lib,updater,tray,window,startup}.rs` | 294, 505, 666, 226, 2167 / N/A (Rust not scanned) |

Recounted after commits 1-2 and before B. No proposed scanned file is at its cap; the tightest current planned files are `scripts/test-layout/layout.json` at 1817/2000 (183 lines) and `tests/fixtures/test-layout-expected.json` at 1623/2000 (377 lines). No growth is planned in `gui/src/styles.css` (2958/2958). If a preceding commit ratchets a proposed file to cap, move the new GUI helper/test into a sibling module and register any new Bun test in both layout JSONs; never raise a cap.

Fresh commands run on this docs-only source baseline; none of the code gates can prove the proposed page or Rust implementation because those files have not been changed:

```sh
bun test ./gui/tests/desktop-shell.test.ts ./tests/clients/desktop-startup-surface.test.ts
bun run typecheck
bun run structure:check
bun run privacy:scan
cd gui && bun run lint:i18n
cd gui && bun run lint
cd gui && bun run build
```

| Fresh baseline verifier | Exit | Evidence and scope |
| --- | --- | --- |
| `bun test ./gui/tests/desktop-shell.test.ts ./tests/clients/desktop-startup-surface.test.ts` | 0 | 25 pass, 0 fail, 140 assertions; existing shell/startup behavior only |
| `bun run typecheck` | 0 | `bun x tsc --noEmit`; current TypeScript only |
| `bun run structure:check` | 0 | `structure/ SSOT checks passed`; current source/docs only |
| `bun run privacy:scan` | 0 | `Privacy scan passed`; this tracked plan is included in the tracked-file walk |
| `cd gui && bun run lint:i18n` | 0 | existing GUI copy passes |
| `cd gui && bun run lint` | 0 | existing GUI source passes |
| `cd gui && bun run build` | 0 | Vite built 355 modules; existing GUI bundle only |

After B, run `bun test ./gui/tests/desktop-shell.test.ts ./tests/clients/desktop-startup-surface.test.ts ./tests/clients/desktop-update-surface.test.ts`, `bun run typecheck`, `cd gui && bun run lint:i18n`, `cd gui && bun run lint`, `cd gui && bun run build`, `cargo test --manifest-path desktop/src-tauri/Cargo.toml`, `bun run structure:check`, `bun run privacy:scan`, and `cd docs-site && bun install --frozen-lockfile && bun run build`. The new Bun test and implemented Rust behavior do not exist today. Cargo's `externalBin` placeholder at `desktop/src-tauri/binaries/` is absent, and `docs-site/node_modules` is absent; this docs-only leaf does not create either prerequisite. These unrun gates remain post-B obligations, not passing claims. Package navigation and installation must then be checked on macOS; Windows/Linux app-origin navigation and trayless Linux are exact-head CI or NEEDS_HUMAN per `000_plan.md`.

The focused baseline tests do not read this document or the proposed page, so their result establishes only current conventions.

The docs-only target was checked directly with `bun -e 'import { readFileSync } from "node:fs"; import { scanText } from "./scripts/privacy-scan.ts"; const path = "devlog/_plan/260924_update_indicator/030_phase3_desktop_update_page.md"; const findings = scanText(path, readFileSync(path, "utf8")); console.log(`target privacy findings: ${findings.length}`); if (findings.length) process.exit(1)'`: exit 0, zero findings. This command reads this file. Repeat `bun run privacy:scan` after main stages the plan so the tracked-file walk includes it.

The proposed page script was parsed directly from this document with `bun -e 'import { readFileSync } from "node:fs"; import { Script } from "node:vm"; const text = readFileSync("devlog/_plan/260924_update_indicator/030_phase3_desktop_update_page.md", "utf8"); const html = text.match(/### NEW `desktop\/ui\/update\.html`[^]*?```html\n([^]*?)\n```/)?.[1]; if (!html) throw new Error("page block missing"); const script = html.match(/<script nonce="__TAURI_SCRIPT_NONCE__">([^]*?)<\/script>/)?.[1]; if (!script) throw new Error("script missing"); new Script(script); console.log("planned page script parses")'`: exit 0, `planned page script parses`. It reads this document, but does not execute the page or Rust commands.

The complete `check_and_show` replacement and both new Rust test functions were each passed to `rustfmt --edition 2021 --emit stdout` on stdin: exit 0 for both snippets. This proves Rust syntax parsing, not type correctness or updater behavior; the post-B Cargo test remains required.

## Risk and rollback

The main risk is origin crossing: if navigation fails, the desktop page never appears; if a remote dashboard can invoke a command, it could request a signed install. The Rust origin/path guard and unchanged remote zoom capability fence the latter, while packaged navigation smoke checks the former. A second risk is check ordering and AppKit deadlock: the page, tray, and background loop share `CheckGeneration` through `check_and_show`; its mutex orders install claims against pure check state writes, and its epoch rejects checks spanning installation. Revisioned UI projections run through one worker after the mutex is released. `update_status` is async, and menu callbacks reach gate reads only in spawned tasks. The delayed-order Rust test covers a page `None` against a later-started tray `Some`, the forced-interleaving test covers the claim race, the blocked-setter test covers concurrent status reads, and the page test covers checking until a tray result settles. A third risk is a failed drain leaving the app and proxy in mixed state; restore pending and report failure, preserving the existing `exit::prepare_restart` behavior. Roll back commit 3 as a unit: the prior tray install path and package dashboard dialog return, while commits 1-2's badge and tray indicators remain. No persisted schema or updater key changes need migration.

No unresolved product decision contradicts `000_plan.md`. Main should revalidate these source anchors after commits 1-2 and ensure the installed Tauri capability schema keeps all four commands restricted to the bundled app page; if it requires an explicit capability, it must have no `remote.urls` entry. Packaged Windows/Linux page transitions and trayless Linux installation remain human/CI proof obligations, not claims of this docs-only pass.

## wp3 P revalidation

Revalidated against current HEAD `9ffa2261ba63158190768be00d338149e95e4de6` after commit 2:

- The original 030 anchors described pre-commit-2 line ranges and an old `claim_install(&installing) -> bool` call site. Lines 9, 147, 178, 255, 305, and 455-507 now name the current `CheckGeneration`, `UiProjection`, `DesktopUpdateState`, `PendingUpdate`, `TrayState`, `queue_ui`, `inspect`, `epoch_is_current`, `begin_if_not_installing`, and `apply_if_current` locations and signatures. The design is unchanged.
- The carried wp2 High is confirmed: current `tray.rs:225-250` takes `PendingUpdate` at `228-233` before any claim. Lines 455-493 now show the exact current Before arm and the explicit After arm that routes both tray and page through `install_pending` and its three-way gated claim. The old setter calls are accounted for at `tray.rs:338-360`; lines 495-507 remove their flag/snapshot ownership and make `show_installing` setter-only.
- The three commit-2 `#[allow(dead_code)]` markers are accounted for: `claim_install`, `epoch_is_current`, and `inspect` at current `updater.rs:65,82,98` are removed when commit 3 wires them. The unrelated `popup_nonmac_test` marker at `updater.rs:242` remains.
- The updater transport details were checked against the implemented code: `start_snapshot_publisher` uses `tokio::time::timeout` at `updater.rs:228-230`, not `select!`; `DesktopUpdateState::wake()` uses `send_modify` at `updater.rs:197-204` without replacing the snapshot; and the popup keeps its validated `/usage` or `/usage/companion` fragment at `popup.rs:288-323,397-408`. No design decision changed.
- The current GUI poll is 60 seconds for desktop and `BADGE_POLL_MS` is 10 minutes for browser at `sidebar-github-row.tsx:38,76`; the plan now states both. All ten planned i18n catalogs contain the existing `sidebar.checkUpdate` anchor and remain exempt from the ratchet; the new `sidebar.desktopUpdate` key still fits each catalog's existing shape.
- The headroom table at lines 928-940 was recounted from the current tree. The smallest planned scanned-file margins are 183 lines for `scripts/test-layout/layout.json` and 377 lines for `tests/fixtures/test-layout-expected.json`; `gui/src/styles.css` remains at its existing 2958/2958 cap with no planned growth. Rust files are recorded for reference and are outside the ratchet scan.

No design-decision change.
