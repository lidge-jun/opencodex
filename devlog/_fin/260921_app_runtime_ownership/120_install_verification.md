# 120 — Installed-artifact verification on a real Linux desktop

First run of the D6/D8 surface against an actual GNOME desktop session rather than a
unit test. The machine is described by role only: a GNOME 24.04 workstation on an X11
session, with a user-level npm install of the proxy already listening on the default
port, and no desktop package installed before this run.

The tree under test is `dev` after lanes C, A, E, F and the runtime-ownership follow-up
landed. Lane B (desktop shell) and lane D (consent surface) were **not** in the tree, so
everything below is the pre-B baseline, not a verdict on them.

## The documented local build produces nothing on Linux

`desktop/README.md` tells a contributor to run `bun run build:local`. On Linux that asks
for `appimage,deb` in that order. AppImage bundling fails:

    Bundling OpenCodex_2.61.0_amd64.AppImage (...)
    failed to bundle project `failed to run linuxdeploy`
    Error failed to bundle project `failed to run linuxdeploy`

The failure is fatal for the whole invocation, and because AppImage is requested first,
the deb is never attempted. The bundle directory is empty afterwards. A contributor
following the README gets no installable artifact and an error that names a tool they
did not invoke. Installing `libfuse2t64` and setting `APPIMAGE_EXTRACT_AND_RUN=1` did not
change the outcome, and linuxdeploy's own diagnostics are swallowed by the bundler.

Requesting the deb on its own succeeds in 43 seconds and produces
`OpenCodex_2.61.0_amd64.deb`, which installs cleanly through `dpkg -i` and registers
`open-codex 2.61.0` with the desktop-file and icon triggers.

Two things follow. The local path should order the Linux bundles so that a failure in the
optional format cannot destroy the installable one, and it should surface the bundler's
stderr instead of a bare "failed to run" line. This is separate from D8: the release
workflow builds the AppImage on its own runner image and is not known to be affected.

## No tray host means no visible application at all

The session has no `StatusNotifierWatcher` on the session bus — stock GNOME with no
AppIndicator extension, which is the exact configuration D6 was written for. The
installed app was launched from that session's environment.

The process starts and stays alive. No window is mapped: an X client enumeration lists
the shell's own windows and the user's browser, and nothing belonging to the app. There
is no tray icon either, because there is nothing hosting one. The application is running
and completely unreachable — the user has no surface to click and no way to know it
started. That is the failure D6 describes, now observed rather than argued.

The only line the process wrote was an updater probe failure:

    updater check failed: Could not fetch a valid release JSON from the remote

which is accurate for a tree whose release channel has not published a manifest yet, but
it is also the only feedback a first-run user would get if they had a way to see it.

## Ownership was not taken, and nothing was disturbed

The pre-existing user-level runtime kept the port for the entire run: `/healthz` reported
the same pid and version before, during and after. The desktop app wrote no install-state
record into the config home. Stopping the app left the original runtime healthy and
untouched.

That is the correct outcome for this tree — the takeover path and its consent prompt are
lane B and lane D work — and it establishes the baseline those lanes have to change.

## Windows is blocked on code signing, not on this batch

The Windows verification machine runs with Smart App Control enabled and code-integrity
enforcement active. A local build fails when cargo executes its first unsigned build
script, with the OS reporting that an application-control policy blocked the file.

This is not a toolchain gap: the build tools and the Rust MSVC toolchain install fine.
It means a machine in that configuration cannot build the shell locally, and — because
the project does not sign Windows artifacts yet — probably cannot run an installer
produced anywhere else either. Windows verification therefore depends on either an
unprotected machine or on wiring Authenticode signing, and the choice belongs to the
maintainer rather than to a lane.

## Status

- Linux deb: built and installed. NOT VERIFIED beyond installation, because the
  behaviour under test lives in lanes that have not landed.
- Linux AppImage: NOT BUILT (bundler failure above).
- Windows: NOT BUILT (blocked by application-control policy).
- Local suites, typecheck and builds of the repository itself: NOT RUN, per the batch rule.
