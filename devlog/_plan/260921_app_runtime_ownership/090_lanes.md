# Lanes

Nine decisions, split into work that can proceed in parallel. Each lane is one branch, ordered
commits, one pull request to `dev`. No native stacks, no child PR chains.

Lane order matters in two places only. **A** publishes the CLI resolve and stop contracts that **B**
consumes, and **C** must land before **B** wires the stop shell-out, because every service-state
writer has to become preserve-and-swap before a second writer exists at all (see R4 in
`100_resolutions.md`). Everything else is independent.

## A — the CLI contract the shell will consume (D5, D4)

A machine-readable resolve that returns the config home, the effective port and the liveness
verdict, and a stop invocation the shell can drive and read. Both are thin surfaces over
`src/config/paths.ts`, `src/server/proxy-liveness.ts` and the existing receipt-backed stop in
`src/cli/` — the point is to expose what already exists, not to reimplement it.

Owns: the new CLI verb and its schema, and the contract tests. Must not change the meaning of the
existing stop path.

## B — the shell: startup, quit, tray, consent plumbing (D7, D2, D6)

The window is created and shown first and startup runs inside it as named states with one deadline,
a retry, the child's exit code and a copyable diagnostic; login autostart starts hidden.
`ExitRequested` is intercepted so close and the quit gesture hide, and only tray Quit drains and
exits. Linux detects real tray availability and, where there is none, shows the window and lets
close mean close.

Owns: `desktop/src-tauri/src/` and `desktop/ui/`. Consumes A's contracts. Blocked on A only for
the resolve and stop call sites; the quit and tray work can start immediately.

## C — durable ownership (D3)

The service install state gains an owner, an install id and a consent generation, written
compare-and-swap and preserved by every writer; repair and update learn to respect it; the app
keeps its own install identity beside it.

Owns: `src/service/` and `src/update/`. This is the lane with the widest reader list, so it
lands early and alone.

## D — the dashboard consent surface (D1)

`confirm`, `alert` and `prompt` leave `gui/src` entirely, replaced with the in-page dialog
and feedback components already in the tree, with a source guard so they cannot return, and with
tests that assert the absence of platform dialogs rather than stubbing them in.

Owns: `gui/`. Independent of every other lane. This is also the lane that unblocks the takeover
consent prompt, since a `confirm`-based prompt would be auto-declined.

## E — the release pipeline (D9, part one)

The Windows shell override, the checksum path, and the dependency graph so publication cannot
precede packaging. Plus the service path filter that names one file while the implementation is
eleven, and the `.exe` the process predicate does not recognise.

Owns: `.github/workflows/` and `src/config/process-state.ts`. Touches release automation, so it
carries the explicit security review the repository requires.

## F — the installed-artifact gate (D9, part two) and the Linux update contract (D8)

The smoke that installs the real artifact on each platform, launches it, proves which runtime it
connected to, exercises takeover and quit, and reports. Plus publishing both AppImage and `.deb`
as distinct updater targets and selecting the right one from the bundle type.

Owns: `desktop/scripts/` and the new workflow. Registering self-hosted runners is a maintainer
action outside the diff; the lane delivers the workflow and the drivers.

## What every lane owes

- A focused regression test near the existing tests for that subsystem, driven red once.
- Any new test file registered in **both** `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json`.
- No new line in a file already at its size cap; move the case to a sibling file instead.
- Exact-head CI read at the SHA, with skipped and cancelled jobs named rather than counted green.
- English in every public artifact, and no host names, addresses, accounts or absolute user paths
  anywhere in the tree.

## Who is running each lane

C, B and D run on one model and A, E and F on another, deliberately split so a systematic blind
spot in either does not cover all six. The split as dispatched is not the one that was intended:
A, E and F went out on a third model by a dispatch error on my part. By the time it was caught,
all three had substantial work in flight — a dozen modified files between them and two commits on
F — so they were left alone rather than restarted. It is recorded here because a later reader
comparing lane quality should know the split was not what the plan says.
