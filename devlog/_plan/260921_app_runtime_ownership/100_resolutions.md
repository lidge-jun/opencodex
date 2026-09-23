# Resolutions

A final scan over the decided set returned sixteen items. Most were the unit's own premise restated
— "the code does not do this yet" is not a contradiction between decisions. Six were real, and each
is resolved here so no lane has to guess.

## R1 — no tray and login autostart (D6 against D7)

D6 shows the window where there is no usable tray; D7 starts hidden when the launch came from login
autostart. A no-tray login launch satisfies both rules and they disagree.

**Resolved: tray availability wins over launch origin.** With no usable tray there is nowhere to
hide, so the window is shown even on a login launch. The hidden start is a property of *having a
place to be hidden in*, not of how the process was started.

## R2 — update restart against tray-only quit (D2 against D8)

D2 says only the tray Quit ends the app. An update installs and restarts.

**Resolved: an update restart is a coordinated restart, not a quit.** It runs the same graceful
drain as tray Quit, then comes back. What D2 forbids is an *uncoordinated* exit — the current
`app.restart()` straight into the hard kill — not the existence of a restart. The exit path must
be able to tell a coordinated restart from a user quit gesture, which is already in D2's blast
radius.

## R3 — AppImage update verification (D8 against D9)

D8 makes both Linux formats update in place. D9 accepted deferring AppImage update behaviour as
follow-up. Those cannot both hold.

**Resolved: D8 wins and D9's deferral is withdrawn.** If both formats carry an update contract,
the gate has to exercise both, so update verification for AppImage and `.deb` moves into lane F's
scope rather than after it. A gate that cannot see one of the two promised paths is not a gate.

## R4 — ownership writes against the external stopper (D3 against D4)

D3 wants compare-and-swap ownership fields. D4 has the app drive an external `ocx stop`, and the
service-state writers today reconstruct the whole record and overwrite it, so a concurrent repair,
update or stop would drop the ownership fields entirely.

**Resolved, and it fixes the lane order.** Lane C lands **before** lane B wires the stop shell-out.
C's scope explicitly includes converting every writer in `orchestration.ts`, `launchd.ts`,
`systemd.ts`, `windows-ops.ts`, `windows-scheduler.ts` and `repair.ts` from
reconstruct-and-replace to preserve-and-swap, with a revision check, before any new writer exists.
A preserved field is not optional politeness here; it is the only thing that makes consent durable.

## R5 — the dialog guard must ban the call, not the word (D1)

A lexical ban on `confirm`, `alert` and `prompt` would reject legitimate code: an admin-token
helper, a `confirm()` method on a session object, and an executable sample string that contains
the word.

**Resolved: the guard matches the global call form**, not the identifier. `window.confirm(` and a
bare `confirm(` at call position are banned; a method call on a receiver, a property name and a
string literal are not. The guard has to be driven red against a real global call and green against
each of those three legitimate shapes before it counts.

## R6 — two constraints every lane inherits

**Security review.** Lane E and lane F change GitHub Actions and release automation, which the
repository requires to have explicit security review. That is a gate on those lanes landing, not a
thing to discover at merge time.

**The size ratchet.** `gui/src/pages/Models.tsx` has one line of headroom against its cap, and
lane D has to touch it. Additive dialog code there fails CI for that branch and for every branch cut
from `dev` afterwards. Lane D extracts to a sibling file and registers it in both test-layout maps
rather than adding a line.

## Remaining open assumptions

1. Registering self-hosted runners for the installed-artifact gate is a maintainer action outside
   any diff; lane F delivers the workflow and the drivers and stops there.
2. The Linux verification machine has no `ocx` installed, so the npm side of the coexistence
   scenario has to be staged before the handover can be exercised there.

