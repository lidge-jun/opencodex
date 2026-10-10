# Desktop-owned terminal command

How OpenCodex Desktop puts its bundled `ocx` first on the user's PATH, how it records what it owns, and
what it refuses to touch. The shell surrounding this feature (startup sequence, tray, update page) is
described in [Desktop shell](desktop-shell.md); design history is in
`devlog/_plan/261009_desktop_owned_path_cli/`.

`desktop/src-tauri/src/cli_command.rs` schedules one blocking reconcile after launch-origin
adoption, independently of proxy startup. Stable macOS apps, Windows installs and Linux deb
installs configure the command by default; off survives launch and removal. AppImage,
temporary, translocated, debug and unpackaged launches do not install it.

`desktop/src-tauri/src/cli_command_record.rs` owns the private `.opencodex-desktop/cli.json`
record (64 KiB cap), OS-backed lock and external pending journals with before/after digests.
The record grants generated-file ownership only, never runtime, service or shutdown authority.
An enabled record carries a validated host-platform bundle even on its first pending save;
disabled intent wins over pending work. Invalid records and journal conflicts block mutation;
unreferenced journals are deleted only under the lock after a valid (or absent) record read.
Every private path must be user-owned without extended ACLs (macOS/Linux) or carry a protected
user/SYSTEM/Administrators DACL (Windows root; children inherit it), otherwise nothing is written.

`desktop/src-tauri/src/cli_command_posix.rs` generates a fail-closed shim, shared PATH helper
and final managed zsh/bash/fish blocks. Reconcile separates desired rc targets from recorded
ownership; remove walks the recorded list and preserves modified blocks and unsafe files.
An rc file with an ACL is never rewritten (`rc-acl-present`). The shim captures exported
Anthropic slot names with an argv-bound random proof before dotenv; failure keeps stripping.

`desktop/src-tauri/src/cli_command_windows.rs` preserves raw HKCU Path text/type, changes only
the owned entry and broadcasts Environment; a top-level `notifyPending` debt survives crashes and
removal until a broadcast succeeds. Machine-Path conflicts are partial; open shells unobserved.

The tray and desktop-only dashboard entry beside Desktop update open `desktop/ui/cli.html`;
`desktop/ui/cli.js` renders only the newest status or action response and never sends a path.
`gui/src/lib/desktop-shell.ts` selects the platform's exact app origin. Four path-free commands
are guarded by the main window's local CLI page; Back uses `return_to_dashboard`, guarded for
the update and CLI pages, falling back to the startup page when no dashboard is ready. Removal
saves off first. Configuration cannot enforce selection against aliases or later PATH edits.
