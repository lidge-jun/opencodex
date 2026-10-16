# 021 — wp3 execution: two Windows lanes on mini

Re-verified against `origin/dev` 93ed1a40b4 (no tested file changed since `d17a9f2239`). Architect proposal (Boyle,
01a1225a-9ed0) D1-D6 accepted. This doc supersedes 020 rows W3, W4, W6, W7, W8 and audit item 2's harness wording;
020's other rows and audit items 3-5 stay in force.

## Decisions

| ID | Decision |
|---|---|
| D1 | Harness = three `#[ignore]` tests added only to mini's temp clone `%TEMP%\ocx-probe-261010\repo` in a `#[cfg(all(test, windows))]` module of `desktop/src-tauri/src/cli_command.rs` (private fns are reachable there): `probe_bundle_program_files` calls only `windows::stable_bundle(C:\Program Files\OpenCodex\opencodex-desktop.exe, false, "2.77.0")`; `probe_plan_only` calls `windows::plan(&Record::fresh(bundle), bundle, false)` without `transact` (no write; prints would-be HKCU text and issues); `probe_install` runs `record::check(&home, true)` then `perform_selected(<home>\.opencodex-desktop, &home, Action::Reconcile, Some(fresh record with install_id), \|\| windows::stable_bundle(%USERPROFILE%\ocx-probe-desktop\opencodex-desktop.exe, false, "2.82.0-probe"), \|_\| {})`; `probe_remove` runs `perform_selected(..., Action::Remove, None, ...)`. `<home>` = `%TEMP%\ocx-probe-261010\home` (exists before the call). Each prints its Status as JSON plus the raw HKCU Path text/kind before and after, and its own process SessionId. The staging dir holds copies of the installed `opencodex-desktop.exe` and `ocx.exe`; neither copy is ever executed. Not exercised: Tauri scheduling and home lookup, `identity::install_id` minting, `current_exe`/`package_info`, UI state publication and the CLI page's Repair/Off/Remove, and a packaged launch (single instance). |
| D2 | `probe_install` and `probe_remove` run as the compiled test binary from `/IT` scheduled tasks in session 1 (where Explorer and the real Desktop live), never from SSH; one SSH-launched run of `probe_plan_only` is the no-write control. |
| D3 | Lanes: **W-a** (the only writer: W2 baseline, D1 tests, W4 probes before and after, remove, compare/restore) and **W-b** (read-only against the live runtime plus focused tests and a temp package copy). They share no paths, ports or registry keys. |
| D4 | Live-session limits: the HKCU window (install → remove) stays under 10 minutes; exactly two broadcasts (install, remove); restore runs even after a failure; every task has a unique logged name and is deleted by exact name; each probe window exits itself; Desktop 2.77.0 predates #6816 and cannot read the temp record. |
| D5 | F3 evidence without a write: `probe_plan_only` output (would-be text + `machine-path-conflict`) plus the observed `Get-Command ocx -All` order; W5 is labelled simulated (Machine then User PATH composition). |
| D6 | W6 is module-level removal; UI Remove stays unverified (as Linux L12). The doctor reclaim flag to avoid is `--reclaim-response-temps`. PID 22680 is re-checked at start. |

## Lane W-a (writer)

1. `whoami`, `query session`, `Get-Process opencodex-desktop,ocx | select Id,SessionId,Path`; save raw HKCU Path
   (`(Get-Item HKCU:\Environment).GetValue('Path',$null,'DoNotExpandEnvironmentNames')`) and `GetValueKind('Path')` to
   `%USERPROFILE%\ocx-probe-desktop\path-before.json` plus `reg export HKCU\Environment ...\env-before.reg /y`.
2. Add the four tests to the clone (patch file kept in the lane evidence dir), build with
   `cargo test --manifest-path desktop\src-tauri\Cargo.toml --no-run`, locate the test exe; run
   `probe_bundle_program_files` and `probe_plan_only` over SSH (`-- --ignored --exact --nocapture`).
3. Write `probe.cmd` (PATH evaluated at run time, `where ocx`, PowerShell dump of self/parent/grandparent name, PID,
   SessionId, output to a per-run file, then exit). Baseline the four probes: /IT task `cmd /c probe.cmd`, /IT task
   running `explorer.exe probe.cmd`, /IT task `wt.exe -w new new-tab --reloadEnvironment cmd /c probe.cmd`, SSH `cmd`.
4. /IT task runs the test exe `probe_install` (output to file); wait for completion; verify HKCU now starts with the
   staging dir and kind unchanged; rerun the four probes.
5. /IT task runs `probe_remove`; compare raw value and kind with step 1; if only the owned entry differs, set the saved
   raw value with the saved kind and broadcast; any other difference stops and is reported.
6. Delete tasks by exact name, `%USERPROFILE%\ocx-probe-desktop`, the temp home; keep the clone for W-b until both lanes end.

Stop: Path differs from baseline before install; harness `Err`, `lock-busy`, `journal-conflict`; a probe window open
after 60 s; any restore difference beyond the owned entry.

## Lane W-b (read-only)

1. `Get-Process opencodex-desktop,ocx`, listening port of the sidecar; `bun install --frozen-lockfile` in a second
   clone `%TEMP%\ocx-probe-261010\b` (avoid W-a's cargo tree).
2. With the real USERPROFILE: `bun src\cli\index.ts resolve --json`, `status`, `status --json` (`startupSource`,
   `cliCommand`), `doctor` (no flags); `node -e` import of `src/service/desktop-supervision.mjs` →
   `inspectDesktopSupervision()` result on win32 while the Desktop child is live.
3. Synthetic record diagnostics through a script calling `collectCliPathDiagnostics({home, env, recordRead})` with a
   ready win32 record whose CLI is `C:\Program Files\OpenCodex\ocx.exe` (labelled synthetic).
4. Focused tests with the pinned Bun: `tests/lib/bun-runtime-preflight.test.ts`, `tests/service/service-runtime-preflight.test.ts`,
   `tests/codex-integration/codex-shim-runtime-preflight.test.ts`, `tests/service/service-desktop-runtime-preflight.test.ts`,
   `tests/cli/ocx-launcher-desktop-handoff.test.ts`, `tests/cli/cli-path-diagnostics.test.ts`, `tests/update/update-desktop-owner.test.ts`,
   `tests/service/service-ownership-handover.test.ts`, `tests/cli/cli-stop-json.test.ts`, `tests/cli/ocx-launcher-runtime.test.ts`
   with HOME/USERPROFILE/OPENCODEX_HOME/CODEX_HOME in temp.
5. W10: temp package copy, bundled Bun and installer removed, Bun 1.4.2 (`bun-windows-x64.zip`) first on PATH →
   `using PATH Bun` notice; then with only the user's Bun; capture the failure text and whether it names the Desktop CLI.

Never run against the live install: `ocx start`, `stop`, `service install/repair/start/restart/stop`, `update`,
`doctor --reclaim-response-temps`. Stop if the Desktop PID or its port changes.

## Reflection (Boyle): ALIGNED with fixes → dispositions

1. D1 has four ignored tests (`probe_bundle_program_files`, `probe_plan_only`, `probe_install`, `probe_remove`).
2. Before step 6, W-a copies `path-before.json`, `env-before.reg`, every probe output and the harness outputs to the lane
   evidence directory (scp to the coordinator's `.tmp/evidence/mini-a/`).
3. The SSH-versus-session-1 broadcast difference is not observed (two-broadcast limit); it is recorded as unverified and
   the harness prints its own SessionId.
4. Task completion: the harness and `probe.cmd` write a `done` marker file last; W-a polls for it and for
   `schtasks /Query /TN <name> /V /FO LIST` not Running, with a 120 s timeout that is a stop condition.
5. Step 4 expectations: install Status `phase=partial` with `machine-path-conflict`; `cli.json` `notifyPending=false`
   after the broadcast; after `probe_remove`, `enabled=false` and `windows=null`.
6. W-b inspector import: `node --input-type=module -e "import('./src/service/desktop-supervision.mjs').then(async m=>console.log(JSON.stringify(await m.inspectDesktopSupervision())))"`.

## Audit (independent Sol, 01a12288-5370): FAIL → dispositions

1. **W-b doctor isolation.** `doctor` runs with `CODEX_HOME` and every other client home set to a temp directory (it
   takes a native-main claim that opens SQLite under `CODEX_HOME`, `src/codex/native-main-claim.ts:86`); the real
   `USERPROFILE` and `~/.opencodex` stay so it still sees the live runtime. `status`/`resolve` keep the real homes and
   their port probes are recorded as observations of the live runtime.
2. **External finally.** W-a wraps steps 4-5 in a PowerShell `try { ... } finally { ... }` driver (kept in the
   evidence dir) whose `finally` always: (a) waits for/kills only its own harness task by exact name; (b) runs
   `probe_remove` from an /IT task if the record exists (`perform_selected` with `Action::Remove` saves off first and
   `recover` rolls back a pending install journal, `cli_command.rs:179-206`); (c) compares raw Path text and kind
   with `path-before.json`; (d) if only the owned staging entry differs, writes the saved raw value with the saved
   kind and broadcasts once; (e) if anything else differs, leaves the value, preserves the temp record and journals,
   and reports. The broadcast limit becomes "install, remove, plus at most one notification retry and one fallback
   restoration broadcast".
3. **Exact test selection.** Every invocation is `<test-exe> cli_command::probe_tests::<name> --ignored --exact
   --nocapture --test-threads=1` (module `probe_tests`), and the driver requires the output line
   `test result: ok. 1 passed`, the done marker, and the expected transition (HKCU starts with the staging entry after
   install; raw value and kind equal the baseline after remove) before continuing.
