# 001 — Host baseline and change-log protocol (2026-10-10)

Captured read-only before any probe mutation. Later rows in 030 compare against this.

## lidge (Ubuntu 24.04.4, kernel 7.0.0-30, x86_64)

- `dpkg -l open-codex` → `ii open-codex 2.61.0 amd64 OpenCodex desktop shell`; `dpkg -S /usr/bin/ocx` → `open-codex`;
  `ocx --version` → `opencodex 2.61.0`. Desktop not running; `~/.opencodex-desktop` absent.
- Shell `/bin/bash`; `~/.bashrc` and `~/.profile` exist, `~/.bash_profile` and `~/.zshrc` do not; no fish, zsh,
  docker or Xvfb. `unshare` and `setpriv` present; passwordless sudo.
- Bun `/usr/local/bin/bun` 1.3.14 (the launcher pins 1.4.2); Node `/usr/bin/node`; cargo/rustc 1.95 under
  `~/.cargo/bin` (not on the non-interactive SSH PATH); webkit2gtk-4.1 / javascriptcoregtk-4.1 2.52.6, libsoup-3.0 3.4.4.
- GNOME session for `<user>` on seat0/tty2.

## mini (Windows 11 build 26200, the interactive user)

- OpenCodex Desktop 2.77.0, per-machine MSI, `C:\Program Files\OpenCodex\`, running in console session 1
  (`opencodex-desktop` PID 22680, `ocx` sidecar PID 33476); `~\.opencodex-desktop` absent.
- npm `ocx` 2.58.0 via nvm4w: `C:\nvm4w\nodejs\ocx{,.cmd,.ps1}`; `C:\nvm4w\nodejs` is in both Machine Path and
  User Path; HKCU Path is `REG_EXPAND_SZ`.
- Bun `%USERPROFILE%\.bun\bin\bun.exe`; cargo/rustc stable `x86_64-pc-windows-msvc` (links despite `vswhere -latest`
  listing nothing); Windows Terminal `wt.exe`; PowerShell 7 in Path.

## Temp clones

Both hosts carry a clone of `d17a9f2239` with CI's empty sidecar/resource stubs (ci.yml:1567-1573):
`/tmp/ocx-probe-261010/repo` (lidge) and `%TEMP%\ocx-probe-261010\repo` (mini).

## Change-log protocol

Every remote mutation is appended to the worktree scratch file `.tmp/host-changes.md` (gitignored) BEFORE it is
made: time (KST), host, exact command, exact revert command, and the check that proves the revert. 040's closeout
copies the final table with each row marked reverted or kept (with reason). Secrets, tokens and request bodies never
enter the log.

## First evidence

- lidge `cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_command`: run 1 `45 passed; 1 failed; 2 ignored`
  (`final_save_before_journal_deletion_is_cleaned_on_reopen`, `Err("lock-busy")` at `cli_command_record.rs:1114`);
  runs 2-4 `46 passed; 0 failed; 2 ignored`; isolated test 5/5 pass.
- mini, same command: `27 passed; 0 failed; 0 ignored`.
