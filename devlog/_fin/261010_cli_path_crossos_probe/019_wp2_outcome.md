# 019 — wp2 outcome: Linux on lidge

Source `d17a9f2239` (package 2.82.0). Three Sol lanes ran in parallel under 011; every host mutation was logged and
reverted. Raw evidence stays in the worktree scratch `.tmp/evidence/lidge-{a,b,c,shared}/` (not committed).

| Row | Result | Evidence |
|---|---|---|
| L1 Rust `cli_command` tests | **works** — 60/60 runs `46 passed; 0 failed; 2 ignored` (30 parallel, 30 `--test-threads=1`, load 0.04-0.66) | lane C `results.txt` |
| F1 first-run `lock-busy` | **unverified** — not reproduced in 60 runs; the single first-run failure (`final_save_before_journal_deletion_is_cleaned_on_reopen`, 001) stays unexplained; no fix PR per the 011 stop rule | lane C |
| L2 ignored real-shell test | **broken (test)** — exit 101, `bash: expected exactly two stdout lines`. Ubuntu's `/etc/bash.bashrc:44-53` prints the sudo hint to stdout for a sudo-group user without `~/.hushlogin`; the shell itself resolved `/usr/bin/ocx` then `npm-ocx` correctly. Test assumption at `cli_command_posix.rs:1063-1066` → F5 | lane C `l2-real-shell.log`, `bash-diagnostic.log` |
| L3 dev deb build | **works** — pinned Bun 1.4.2 `build:gui` → `prepare-sidecar` → `tauri build --bundles deb` produced `OpenCodex_2.82.0_amd64.deb`, whose sha256 was recorded when it was staged and matched at install | lane A `02_build.sh`, `07_gate_deb.log`, `08_install.log`; the raw build log was deleted with the clone before it was copied, so `02_build_observed_tail.md` is a transcription |
| L5/L6 deb install + reconcile | **works** — inside the overlay `dpkg -i` → 2.82.0 (host stayed 2.61.0); Desktop under `dbus-run-session -- xvfb-run -a` wrote an enabled `cli.json` with a bundle (the `kind` value itself was not printed; on Linux only `posix::stable_bundle` accepting a `/usr/bin` launch produces one, and it records `linux-deb`), `status --json` `cliCommand.configured: true`, shim 0700, `path.sh` 0600, and managed blocks in `.bashrc`, `.profile`, `.zshrc`, `.zlogin`, `.config/fish/config.fish` matching the generated text exactly | lane A `08_install.log`, `10_reconcile_readout.log`, `13b_diagnostics.log`, `15_rc_exact.log` |
| L7 real login shells (release QA: fish) | **works** — real fish login via `script -qec 'su - ocxprobe'`: login 0, interactive 0, `command -v ocx` → `~/.opencodex-desktop/bin/ocx`; `fish -l -i -c` same; clean-PATH `fish -l -c` interactive 1 → `/usr/bin/ocx` (**by design**, `if status is-interactive` guard); bash interactive login and `bash -lc` → shim | lane A `11_fish_matrix.log`, `12_bash_matrix.log` |
| L8 package launcher handoff | **works** — npm-global (`npm_config_prefix`), `bun link` and a linuxbrew-shaped symlink all hand off to the record target with a ready record; `OCX_NO_DESKTOP_HANDOFF=1` runs the package (`opencodex 2.82.0`); unsafe mode, symlinked record, pending and oversize records are refused with explicit errors | lane B `matrix.log` |
| L9 diagnostics | **works** — without Desktop: `status`/`--json` name the npm launcher first, `.cliCommand.desktopFirstOnPath=false` with `path-first-not-desktop`, doctor shows it, `resolve --json` `runtime-absent`; with the dev Desktop live in the overlay: Desktop first on PATH, `startupSource: live`, `resolve --json` `supervisor.kind: "desktop"` | lane B `matrix.log`; lane A `13b_diagnostics.log` |
| L10 refuse-to-compete (#6809) | **works** — with `supervisor.kind=desktop`: `ocx start` refuses, `ocx service install` refuses and leaves supervision intact; `ocx stop` stops the child and warns the Desktop may restart it (**by design**, `src/cli/desktop-runtime-guidance.ts:27`, `tests/cli/cli-stop-json.test.ts:279`; 010's "refuse" expectation was wrong). Focused tests: 517 pass / 4 skip / 0 fail across the 11 files | lane A `14b_guards.log`, `24_service_guard.log`; lane B `tests-final.log` |
| L11 PATH-Bun fallback (#6807) | **works** — bundled Bun and installer removed, Bun 1.4.2 first on PATH: `opencodex: using PATH Bun 1.4.2.` and `opencodex 2.82.0`; with only 1.3.14: `Bun binary missing after install attempt.` (exit 1) | lane B `fallback.log` |
| F4 Linux failure text names no Desktop CLI | **by design today** — `findDesktopCli()` is macOS-only (`src/lib/bun-path-runtime.mjs:80`), so a broken package launcher on a deb host does not point at `/usr/bin/ocx`; naming it safely needs a check that `/usr/bin/ocx` is the deb's binary and not an npm `--prefix /usr` symlink, so it is a follow-up, not a fix here | lane B |
| L12 opt-out | **unverified** — the CLI page's Remove/disable action is not reachable without a GUI operator; cleanup of the probe itself verified | lane A |
| Packaged CLI page click-through | **unverified** — same reason | — |

Host state after wp2 (coordinator check): `/var/tmp/ocx-probe*`, `/tmp/ocx-probe-261010`, `~/.opencodex-desktop` absent;
no `ocxprobe*` netns; no `ocxprobe` user; `open-codex` 2.61.0; user proxy PID 3280942 still on `127.0.0.1:10100`.

Process note: the first dispatch of lanes A and B was tagged as reviewers by codexclaw's keyword role inference
(packet text contained "audit"/"verify") and refused to execute; they were redispatched with a `CXC-ROLE: explorer`
header.
