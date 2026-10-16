# 010 — wp2: Linux probe on `ssh lidge`

Source under test: a temp clone of `d17a9f2239` at `/tmp/ocx-probe-261010/repo` on lidge. Every host mutation is
appended to the worktree's `.tmp/host-changes.md` with its revert before it is made.

## Code facts the probe relies on (read 2026-10-10)

- Install kind: `desktop/src-tauri/src/cli_command_posix.rs:147` rejects debug builds (`development-launch`),
  AppImage env or `/tmp/.mount_` paths (`temporary-bundle`) and any executable whose canonical parent is not
  `/usr/bin` (`unpackaged-launch`); a qualifying launch needs an executable `/usr/bin/ocx` and records `linux-deb`.
  dpkg is never consulted.
- Owned paths: `~/.opencodex-desktop/{bin/ocx (0700), path.sh (0600), cli.json, cli.lock, journal/, backups/}`.
- Managed blocks (`# >>> OpenCodex Desktop ocx PATH v1 >>>`): `.bashrc` plus the FIRST existing of
  `.bash_profile`/`.bash_login`/`.profile` (none created; absent → `login-file-absent`, partial); `.zshrc` and
  `.zlogin` under `ZDOTDIR` or HOME; `${XDG_CONFIG_HOME:-~/.config}/fish/config.fish` wrapped in
  `if status is-interactive` (`cli_command_posix.rs:97-132`).
- The ignored `real_shell_selects_desktop_shim_on_temp_home` test covers bash and zsh only, never fish.
- Launcher handoff (`src/lib/desktop-cli-handoff.mjs`): escape hatch and recursion guard `OCX_NO_DESKTOP_HANDOFF=1`;
  update/uninstall/remove/internal commands are excluded; record must be 0700 dir / 0600 file owned by the euid.
- PATH-Bun fallback (`src/lib/bun-path-runtime.mjs`) needs Bun ≥ the pinned 1.4.2; lidge's `/usr/local/bin/bun`
  is 1.3.14 and must be rejected.

## Probe steps

| # | Step | Command sketch | Expected |
|---|---|---|---|
| L1 | Rust unit tests | `cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_command` with CI's empty sidecar/resource stubs (ci.yml:1567-1573), repeated ×5 | all pass (first run: 1 `lock-busy` flake, see F1) |
| L2 | Ignored real-shell test | `... cli_command_posix::tests::real_shell_selects_desktop_shim_on_temp_home -- --ignored --exact --nocapture` | bash passes; zsh skipped (absent) |
| L3 | Build dev deb | `bun install` (root, gui, desktop) → `bun run build:gui` → `bun desktop/scripts/prepare-sidecar.ts --target x86_64-unknown-linux-gnu` → in `desktop/`: `bunx tauri build --ci --bundles deb --config '{"bundle":{"createUpdaterArtifacts":false}}'` | `.deb` under `src-tauri/target/release/bundle/deb/` |
| L4 | Throwaway user | `sudo useradd -m -s /opt/ocx-probe/fish/bin/fish ocxprobe` after unpacking `fish-4.9.3-linux-x86_64.tar.xz` into `/opt/ocx-probe/fish`; give it `.bashrc` and `.profile` copied from `/etc/skel` | user exists, `getent passwd ocxprobe` shows fish |
| L5 | Install dev deb | download v2.61.0 deb for revert first; `sudo apt install ./OpenCodex-*.deb` | `/usr/bin/opencodex-desktop` + `/usr/bin/ocx` from dev |
| L6 | Desktop reconcile as ocxprobe | run `/usr/bin/opencodex-desktop` as ocxprobe under a virtual display (`xvfb-run` installed and logged, or the user's Wayland/X session if Xvfb is refused) long enough for `reconcile_on_launch`, then stop it | `~ocxprobe/.opencodex-desktop/cli.json` enabled, kind `linux-deb`; blocks in `.bashrc`, `.profile`, `.zshrc`, `.zlogin`, `config.fish` |
| L7 | Real login shells | `sudo -iu ocxprobe` (fish login, interactive via `script -qc`), `fish -l -c 'command -v ocx'`, `bash -l -i -c`, `bash -lc`, `env -i ... bash --login`, `ssh ocxprobe@localhost` if keys allow | interactive fish/bash → `~/.opencodex-desktop/bin/ocx`; non-interactive fish → `/usr/bin/ocx` (guard) |
| L8 | Package launcher handoff | as ocxprobe: `npm i -g` of a `npm pack` tarball into `~/.npm-global`, `bun link` from the clone, and a linuxbrew-style `~/.linuxbrew/bin/ocx` symlink; run each `--version`/`status`; repeat with `OCX_NO_DESKTOP_HANDOFF=1` | handoff to the record target; escape hatch runs the package |
| L9 | Diagnostics | `ocx status`, `status --json`, `doctor`, `resolve --json` with and without the Desktop running | `ocx command:` line names Desktop first/not first; supervisor line only with Desktop live |
| L10 | #6809 guards | with dev Desktop running as ocxprobe: package `ocx start`, `stop`, `service install`, `update --check`-style dry paths | refusals naming Desktop |
| L11 | Bun fallback | temp package copy with bundled Bun removed; PATH first = Bun 1.4.2 in a temp dir; then 1.3.14 | 1.4.2: `using PATH Bun` notice; 1.3.14 rejected with Desktop CLI named |
| L12 | Opt-out and revert | Desktop "Remove" / disabled reconcile as ocxprobe; then `sudo userdel -r ocxprobe`, `sudo apt install ./OpenCodex-2.61.0-linux-amd64.deb` (allow downgrade), remove `/opt/ocx-probe`, `/tmp/ocx-probe-261010` | blocks removed except user-modified ones; host back at 2.61.0 |

## Outcomes

Each row is recorded in 030's matrix as works / broken / by design / unverified with the command and output tail.

## Reflection (same architect, Dewey 01a1225a-9e23): MISALIGNED → dispositions

These replace the matching rows above.

- **L1/F1:** the first-run `lock-busy` failure stays recorded as evidence. The forked-child cause is a hypothesis.
  Before any fix, B reproduces under a loop (`for i in $(seq 30)`), captures `RUST_BACKTRACE=1` and the errno from
  `flock`, and identifies the holder with `/proc/locks` plus `ls -l /proc/*/fd` matching the lock inode during a
  failure (an instrumented copy of the test may sleep on failure to allow the snapshot). The fix shape is chosen
  only from that evidence.
- **L7:** positive fish case is `fish -l -i -c 'command -v ocx'` and an interactive login via `script -qc 'sudo -iu ocxprobe' /dev/null`;
  the negative case is `env -i HOME=/home/ocxprobe PATH=/usr/bin:/bin /opt/ocx-probe/fish/bin/fish -l -c 'command -v ocx'`.
  Bash: `env -i HOME=/home/ocxprobe PATH=/usr/bin:/bin bash --login -c 'command -v ocx'` and with `-i`.
- **L10:** no live `update`. The guard probe runs `start`, `stop` and `service install` from the package as ocxprobe
  only while the dev Desktop runs as ocxprobe with ocxprobe's own `~/.opencodex`, and the focused existing tests
  (`tests/update/update-desktop-owner.test.ts`, `tests/service/service-ownership-handover.test.ts`,
  `tests/cli/cli-stop-json.test.ts`) run on lidge for `update`.
- **L11:** set `OCX_NO_DESKTOP_HANDOFF=1`; remove the bundled Bun and the installer from the temp package copy; the
  1.3.14 expectation is "rejected, no Desktop CLI named" because `findDesktopCli` returns null off macOS (candidate
  finding F4).
- **L8/L12:** npm-global uses `npm_config_prefix=/home/ocxprobe/.npm-global`. Before L5, download the v2.61.0 deb to
  `/opt/ocx-probe/revert/`, verify it against its `.sha256`, and record `dpkg-deb -f <deb> Package Version`; L12
  restores with `sudo apt install --allow-downgrades /opt/ocx-probe/revert/OpenCodex-2.61.0-linux-amd64.deb`.

See the audit dispositions at the end of 020_windows_probe.md; items 1 and 5 replace L4, L5, L7 and L12 host steps.
