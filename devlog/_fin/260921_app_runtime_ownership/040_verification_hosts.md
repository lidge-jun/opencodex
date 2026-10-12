# Verification hosts

Three machines cover the three platforms, all reachable over a private mesh. They are described
here by role only — the concrete names, addresses and accounts are operator detail and live in
scratch, not in this directory.

| platform | what it is | npm-installed ocx already present |
| --- | --- | --- |
| macOS | the development machine, macOS 27, with the signed app installed | yes, a global install on `PATH` |
| Windows | Windows 11 25H2, reached over a POSIX shell layer | yes, both the launcher and its `.cmd` form |
| Linux | Ubuntu 24.04 LTS with a live GNOME session | no — only `npm` and `node` |

## Why each one matters

**The Windows box is the coexistence case, not a spare runner.** It already carries an
npm-installed `ocx` on `PATH`, which is exactly the situation the takeover has to handle. It is
also where the `isOcxCommandLine` gap becomes real: the npm launcher there is `ocx.cmd`, which
the predicate *does* match, while the app's bundled sidecar is `ocx.exe`, which it does not. Both
shapes exist on the same machine, so the predicate can be shown to be wrong rather than argued
about.

**The Linux box has a real graphical session**, so the tray question can be answered rather than
assumed. It runs stock GNOME — both the Wayland and Xorg sessions are installed, and there is an
active seat — and stock GNOME ships **no tray** without an AppIndicator extension. That is
precisely the configuration the Windows/Linux review warned about: a window created hidden plus a
close handler that always hides leaves a running process with no way back in. `systemctl --user`
is running and FUSE is available, so the systemd user unit and the AppImage path are both testable
there.

That box has no `ocx` yet, so the npm side of the coexistence scenario has to be staged before
the handover can be exercised there.

## A note on what belongs here

The first draft of this file named the mesh hostnames, an address and the SSH accounts that are
and are not permitted, and it was committed locally before being caught. `devlog/` is a public
directory in a public repository, so that was operator detail heading for publication. It has been
removed from the working tree and from history — nothing was pushed.

Worth recording for its own sake: `bun run privacy:scan` passed on that draft. The scan covers
credentials and account identifiers, not mesh topology or login names, so passing it is not
evidence that a file is safe to publish.

