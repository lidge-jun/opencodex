# 020 — wp3: Windows probe on `ssh mini`

Source under test: a temp clone of `d17a9f2239` at `%TEMP%\ocx-probe-261010\repo` on mini. The live Desktop 2.77.0
(per-machine MSI, `C:\Program Files\OpenCodex`, PID 22680, session 1) and nvm4w npm `ocx` 2.58.0 are user tools and
are not reinstalled, stopped or upgraded.

## Code facts (read 2026-10-10)

- `cli_command_windows.rs:693` `stable_bundle` rejects debug launches and paths containing `target`, `temp`, `tmp`;
  needs a regular non-symlink sibling `ocx.exe`. Any install root qualifies, including Program Files.
- `prepend` (600) puts the install directory first in `HKCU\Environment\Path`, preserving raw text and REG_SZ vs
  REG_EXPAND_SZ; `machine_conflict` (805) flags any Machine Path dir holding `ocx.exe/.com/.cmd/.bat`; `broadcast`
  (848) sends `WM_SETTINGCHANGE`/`Environment` with a 1 s per-recipient timeout; `notifyPending` persists failure.
- No test writes the real HKCU; the Windows Path tests are pure transforms or use an in-memory registry seam.
- `src/lib/desktop-cli-handoff.mjs:19` returns `windows-path-only`; `src/service/desktop-supervision.mjs:75` returns
  `unsupported` for anything but darwin/linux, so #6802 authority and #6809 refusals never engage on Windows.

## Probe steps

| # | Step | Expected |
|---|---|---|
| W1 | `cargo test --manifest-path desktop\src-tauri\Cargo.toml cli_command` with CI stubs, ×3 | pass (first run 27/27) |
| W2 | Baseline: `reg query HKCU\Environment /v Path` (type), `reg export HKCU\Environment <backup>.reg /y`, `Get-Command ocx -All`, `where ocx` | backup file recorded in host log |
| W3 | Real HKCU write through the real module: a throwaway `#[ignore]` test added only in the temp clone that runs the Windows `plan` → `apply_change` → `notify` path for a staging dir `%USERPROFILE%\ocx-probe-desktop\` (no temp/tmp in path) holding a copy of `C:\Program Files\OpenCodex\ocx.exe` | HKCU Path gains the staging dir first, type preserved; issues include `machine-path-conflict` |
| W4 | New terminal pickup: (a) scheduled task `/IT` in session 1 running `cmd /c "echo %PATH% & where ocx" > out.txt`; (b) `explorer.exe <probe.cmd>` launched via an /IT task so Explorer's refreshed environment is used; (c) `wt new-tab --reloadEnvironment` | staging dir present in PATH of each new process; `where ocx` still lists `C:\nvm4w\nodejs\ocx.cmd` first (machine conflict) |
| W5 | Counter-probe without the machine conflict: same harness, but compute selection with a PATH where Machine entries lack ocx (simulated by the module's own selection on a copy, not by editing Machine Path) | Desktop dir would win; documents that the conflict is the only blocker |
| W6 | Revert W3 through the module's removal path, then compare `reg query` with the backup | HKCU Path byte-identical to baseline; otherwise `reg import` after checking for unrelated edits |
| W7 | Diagnostics with new code: from the clone, `bun src\cli\index.ts status --json`, `doctor`, `resolve --json` against the live Desktop runtime (read-only), with and without a hand-made 0600-equivalent `cli.json` record in a temp USERPROFILE | `desktopSupervision: unsupported`; status recommends service actions despite Desktop supervising (gap); `packageHandoff=disabled-on-windows`; `path-first-not-desktop` |
| W8 | #6809 guards in isolation: `OPENCODEX_HOME`, `CODEX_HOME` in temp, free port; start a runtime from the Desktop's `ocx.exe` copy as a fake "Desktop child", then package `start`/`stop` from the clone against that isolated home | no refusal on Windows (gap evidence); never against the live home |
| W9 | #6812 Bun preflight: focused tests `tests/lib/bun-runtime-preflight.test.ts`, `tests/service/service-runtime-preflight.test.ts`, `tests/codex-integration/codex-shim-runtime-preflight.test.ts` on mini; plus `OPENCODEX_BUN_PATH` pointing at a non-Bun exe in temp with an isolated home | tests pass; bogus Bun rejected before baking |
| W10 | Launcher Bun fallback (#6807) on Windows: temp package copy, bundled Bun absent, PATH Bun 1.4.2 vs the user's `~\.bun\bin\bun.exe` version | 1.4.2 accepted with notice |

Do not run against the live install: package `ocx start`, `stop`, `service install/repair/start/restart/stop`,
`update`, `doctor --reclaim`.

## Reflection (same architect, Boyle 01a1225a-9ed0): MISALIGNED → dispositions

These replace the matching rows above.

- **W3/W6 contract:** the harness proves the real registry write, the broadcast and the persisted debt, so it goes
  through the same entry the Desktop uses: `Store::transact` with the Windows plan for a bundle produced by
  `stable_bundle` on the staging directory (copied `opencodex-desktop.exe` + sibling `ocx.exe`), with HOME/USERPROFILE
  pointed at a temp record root for the store. If `stable_bundle` refuses the staging copy, that refusal is recorded
  and the bundle is built by hand for the write probe only. Restoration runs in a `finally`-style guard (Drop) that
  calls the removal path; W6 compares raw bytes and value type from `RegQueryValueExW`
  (`Get-Item HKCU:\Environment` `.GetValue('Path',$null,'DoNotExpandEnvironmentNames')` + `GetValueKind`) against
  the values saved in W2, and falls back to setting the saved raw value and type, never `reg import` of the whole key.
- **W4:** the scheduled task runs a pre-written `probe.cmd` (PATH evaluated at run time, not creation), writing
  `%PATH%`, `where ocx` and its own parent PID/image/session (via PowerShell `Get-CimInstance Win32_Process`).
  The Explorer variant launches `explorer.exe probe.cmd` from an /IT task and records the parent chain; `wt new-tab
  --reloadEnvironment` runs from an /IT task in session 1. SSH `cmd` is reported only as the stale control.
- **W5:** labelled simulated: a pure PATH-order computation over Machine then User entries after the write.
- **W7:** expectations use real fields: `status --json` `startupSource` and `cliCommand`; `resolve --json`
  `supervisor.kind="unsupported"` when live. A hand-made record is labelled synthetic. Service-action
  recommendations are recorded only if status reports the runtime unhealthy.
- **W8:** no copied sidecar. Evidence is the direct inspector result on win32 (`inspectDesktopSupervision()` →
  `unsupported` while the real Desktop child is live) and the focused guard tests on mini; any lifecycle simulation is
  isolated from client homes too. F2 separates the supervision gap from the deliberate PATH-only handoff choice.
- **W9:** the shim test is `tests/codex-integration/codex-shim-runtime-preflight.test.ts`. W10 first reads the pinned
  Bun policy in `src/lib/bun-path-runtime.mjs:67`.


## Audit (independent Sol, 01a12262-abb4): FAIL → dispositions

These supersede the earlier rows and the reflection dispositions where they conflict.

1. **Disposable Linux root (replaces L4, L5, L12 host steps).** The dev deb is never installed on lidge's real root.
   B builds a private overlay of `/` and does everything that needs `/usr/bin` inside it:
   `sudo unshare --mount --pid --fork --propagation private` → `mount -t overlay overlay -o lowerdir=/,upperdir=/var/tmp/ocx-probe/upper,workdir=/var/tmp/ocx-probe/work /var/tmp/ocx-probe/merged`
   → mount fresh `proc`, bind `/dev`, `/dev/pts`, `/sys`, a tmpfs `/tmp`, and copy `/etc/resolv.conf` → `chroot`.
   Inside: `dpkg -i` the dev deb (replacing 2.61.0 only in the overlay), `apt-get install -y xvfb dbus-x11` if needed,
   unpack portable fish 4.9.3 to `/opt/fish`, `useradd -m -s /opt/fish/bin/fish ocxprobe` with `/etc/skel` files.
   The host dpkg database, `/usr/bin/ocx`, `/etc/passwd` and real HOMEs are never written. Revert: exit the
   namespace (its mounts vanish with it) and `sudo rm -rf /var/tmp/ocx-probe`. Verification of the revert:
   `dpkg -s open-codex | grep Version` = 2.61.0, `getent passwd ocxprobe` empty, `mount | grep ocx-probe` empty.
   If the overlay cannot run the Desktop (WebKit, dbus, display), the deb row is recorded as unverified with the
   error and the install-kind evidence falls back to the overlay's `dpkg -i` plus a direct call of
   `stable_bundle` through the Desktop's `ocx` path checks.
2. **Windows integrated launch.** The Desktop uses `tauri-plugin-single-instance` (`desktop/src-tauri/src/lib.rs:298`),
   so a second dev Desktop on mini would hand its arguments to the live 2.77.0 instance; launching one is not safe or
   meaningful. The Windows matrix therefore states "packaged Desktop launch: unverified (single instance with the
   user's live Desktop)" and records module-level evidence: the throwaway harness calls `perform_in`
   (`cli_command.rs:165`), the same core `perform` and `reconcile_on_launch` use, with `observe = stable_bundle(<staged
   opencodex-desktop.exe>, false, <version>)`, a `Store` under a temp USERPROFILE-like root, and `Action::Reconcile`.
   Only `reconcile_on_launch`'s Tauri scheduling and `perform`'s home lookup stay outside the harness.
3. **Windows Terminal observation inside the tab.** The /IT task runs
   `wt.exe -w new new-tab --reloadEnvironment cmd /c %USERPROFILE%\ocx-probe-desktop\probe.cmd wt`; `probe.cmd`
   writes `%PATH%`, `where ocx` and a PowerShell dump of its own process, parent and grandparent (name, PID,
   SessionId) to `probe-wt.txt`, then exits. Controls, each with its own output file: `explorer.exe probe.cmd` from
   an /IT task (parent must be the logon explorer.exe), a plain /IT task running `probe.cmd` (Task Scheduler builds a
   fresh environment), and SSH `cmd` (stale). Before the write, the same four probes run once as the baseline.
4. **Windows revert contract.** Order: (a) W2 saves the raw Path value and kind via
   `.GetValue('Path',$null,'DoNotExpandEnvironmentNames')`/`GetValueKind('Path')` to a file, plus `reg export` as a
   second copy; (b) after the probes the harness calls `perform_in(..., Action::Remove, ...)`, which saves the record
   off before removal (`cli_command.rs:179-201`) and broadcasts; (c) read the value again: identical raw text and
   kind → done; otherwise diff it against (a) and, if the only difference is the owned entry, set the saved raw value
   with the saved kind and broadcast `WM_SETTINGCHANGE` (PowerShell `SendMessageTimeout` P/Invoke); any other
   difference is left for the user and reported. Cleanup list: each scheduled task gets a unique logged name
   (`ocx-probe-261010-<probe>-<n>`) removed with `schtasks /Delete /TN <exact name> /F`, close no user
   windows (each probe exits itself), delete `%USERPROFILE%\ocx-probe-desktop`, the temp record root and
   `%TEMP%\ocx-probe-261010`.
5. **Fish real login inside the session.** `printf 'status is-login; and echo LOGIN; status is-interactive; and echo INTERACTIVE; command -v ocx; echo $PATH; exit\n' | script -qec 'su - ocxprobe' /dev/null`
   inside the overlay chroot; the same for bash by switching the probe user's shell (`usermod -s /bin/bash`) and
   re-running; `fish -l -i -c` stays as a separate control and the clean-PATH `fish -l -c` as the negative control.

Non-blocking folded: F1's first row is a hypothesis until wp2 evidence (reflection dispositions); F3 depends on the
observed W3/W4 order; F4 depends on L11's failure text.
