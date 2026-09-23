---
title: Native main login profiles
description: Manage stored native Codex login profiles separately from OpenCodex Pool routing.
---

## Native login is not Pool selection

In **Codex Set → Multi-auth**, open **Manage main login** in the separate
**Native main login** panel immediately below the main account card. The same
panel appears beside the main card in the Providers account workspace. It
manages the physical Codex login, not the account selected for the next Pool
request. It does not add an Integrations tab or replace existing Pool controls.

The displayed **Effective CODEX_HOME** belongs to the OpenCodex server. When
using a remote dashboard, this may be a different computer from the browser.
**Registered active profile** is the encrypted profile store's recorded owner;
the server verifies the physical login before switching. A login changed outside
OpenCodex can therefore produce an ownership-mismatch error rather than being
silently overwritten.

## Save and switch

Use **Save current as profile** to register the existing app login. For an
already registered active login this updates its label; it does not enroll a new
account. Profile switching requires the supported file credential store and an
available operating-system key store. Diagnostic codes explain why controls are
unavailable; do not work around a key-store or ownership error by copying Pool
credentials into the native login file. The panel is disabled while the main
card's existing native device-reauthentication operation is active.

Choose **Switch** beside a stored inactive profile. Review the target label and
server-side home, stop native Codex using that home, then check the stopped
confirmation and submit. No credential mutation is sent before confirmation.
The panel rereads the current home, active owner and recovery state immediately
before submitting. If that state changed, review the new state and confirm again.
The existing backend remains authoritative for locks, process checks, draining
in-flight requests, activation and rollback.

After success, follow the displayed restart requirement and reopen native Codex
with that home. The panel rereads profile state and refreshes the existing account
controller. It does not call Pool selection/configuration mutations or edit
provider keys, tasks or history. The existing backend still reconciles the native
`__main__` identity, just as it does for the CLI workflow.

## Recovery and previous profiles

These are different operations:

- **Recover interrupted change** reconciles an unfinished backend transaction.
  **Restore pending transaction** requests rollback of that transaction. Both
  require a separate stopped confirmation. These controls remain available when
  a damaged profile list cannot be read but diagnostics report pending recovery.
- **Return to previously displayed** after a successful switch selects the profile
  shown before your switch using the normal, confirmed switch workflow. This
  shortcut is held only in page memory, scoped to the home and expected active
  owner, and disappears when the page reloads or the proxy/owner changes. The API
  does not return the transaction source, so this is not a server-verified undo
  log: another operator could have changed the login between the preflight read
  and your switch. After reloading, select the desired saved profile directly.

A network error does not establish that a write failed or rolled back. The panel
rereads server state after a dispatched mutation, including a lost response, and
never automatically retries it. If refresh fails, a successful change is not
reported as undone. Refresh and inspect diagnostics before another operation.
The existing `ocx account main doctor` command provides server-side diagnostics.

## Scope of this phase

This panel lists, registers, switches and recovers existing profiles using the
existing `/api/native-main-profiles` boundary. It does not launch login processes
or expose staging writer tokens. Adding another native login remains in the
existing `ocx account main add` CLI workflow; browser enrollment is a separate
follow-up to issue #3417. Existing device reauthentication of the current main
slot is a different workflow and is not replaced by this panel.

Profile data is not written to browser storage. The client projects only public
fields, displays allowlisted error codes rather than raw server messages, and
uses the application's existing authenticated fetch wrapper. The backend's
management authentication, GUI-session/CSRF and route-admission checks are
unchanged.
