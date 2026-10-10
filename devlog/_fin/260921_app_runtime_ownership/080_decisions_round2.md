# Decisions, round 2

## D6 — Linux without a tray

**Detect real tray availability and branch.** Where there is no usable tray the window is shown on
launch, close really closes and quits through the graceful drain, and hide-to-tray is simply not
used. Where there is a tray, D2 applies unchanged.

The decider found why construction success is not enough: the pinned Linux backend creates an
`AppIndicator` and returns success without checking for a StatusNotifier watcher, so
`tray::install` succeeding proves nothing about whether an icon is reachable. **Cost accepted:**
Linux behaviour becomes session-dependent, so both modes have to be supported and verified, and D2
gains an explicit no-tray exception.

## D7 — the startup surface

**The window is created and shown first, always.** Resolve, liveness, takeover consent, start,
permission registration and the Start at Login decision all run inside it as named states under one
overall deadline, with a retry, the child's exit code and a copyable diagnostic. A launch that came
from login autostart starts hidden; that is the only difference.

The retry surface already exists in `desktop/ui` — it is just created hidden and never promoted
into a real state machine. **Cost accepted:** an ordinary manual launch now shows a window even
when everything succeeds immediately.

## D8 — the Linux update contract

**Both formats update in place.** The pinned updater already branches between AppImage and
`.deb`, detects dpkg ownership, validates the payload and installs through package-manager
elevation, and Tauri exposes the bundle type embedded at packaging time, so the app can select the
right manifest entry rather than guess. The current mismatch is that both artifacts are collected
but only the AppImage is published as a Linux updater target.

**Cost accepted:** Linux release and verification become a two-format matrix, and a `.deb` update
asks for package-manager authorization — which is consistent with the elevation rule, because the
prompt comes only after the user chooses Install.

## D9 — what gates a desktop release

**Fix the three pipeline defects, and add one installed-artifact smoke gate** that runs on a
machine per platform: install the real artifact, launch it, prove which runtime it connected to,
exercise takeover, quit, and confirm the runtime survived or drained as specified. Publication
waits for packaging and for that smoke.

The release contract becomes package, then install-smoke on all three platforms, then publish and
attach, with a missing platform result blocking publication. **Cost accepted:** publication now
depends on three stateful GUI machines, each run needs strict rollback and cleanup, and AppImage
update behaviour, full uninstall coverage and the zero-sidecar PR job stay follow-up.

## The observable contract this produces

Every decision above was required to state what a test or a screenshot must show. Collected:

- A staged npm runtime on a non-default port is drained, its registration is still present
  afterwards, the desktop install id is recorded as owner with exactly one consent-generation
  increment, and `/healthz` reports the bundled sidecar's pid and version on the preserved home
  and port.
- Window close and the platform quit gesture each leave both pids alive with the window reopenable
  from the tray; tray Quit during an in-flight request lets that request finish and then ends both.
- A second launch does not ask for consent again.
- On a Linux session with no usable tray: the dashboard appears on first launch, no tray icon is
  claimed, and closing the window drains and exits rather than hiding.
- An older AppImage updates without elevation and keeps its path; an older dpkg install asks for
  authorization only after Install is chosen, and cancelling leaves the old version in place.

