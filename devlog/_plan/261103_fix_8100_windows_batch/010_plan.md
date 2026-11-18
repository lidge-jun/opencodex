# Fix the red dev batch: #8100 Windows containment exit and sync fan-out fixture (C3)

Batch run https://github.com/lidge-jun/opencodex/actions/runs/41462914814 at `09b558580` failed two Windows shards. The tree before #8100 (`be51cb817`, run 41455278872) was green on every platform, and both failures trace to #8100 (`4948c04d9`).

## Failure 1 — product regression: an uncontainable Windows ocx exits 1 instead of 126

`tests/clients/link-ssh-argv-discovery.test.ts` "a Windows ocx that cannot be contained in a kill-on-close job is refused before it runs" expects `WINDOWS_CONTAINMENT_EXIT` (126) and received 1 (windows 10/11).

Cause. #8100 moved `windowsNativeArgv`, `windowsOcxArgv` and the new `windowsPinnedSyncArgv` onto `packedPowerShellArgv`. Its wrapper inflates the whole script with `[IO.MemoryStream]::new`, `[IO.Compression.DeflateStream]::new` and `[IO.StreamReader]::new`, then `Invoke-Expression`s it. That stage runs before the inflated script defines `Fail` (`exit 126`), outside any `try`, with the default `Continue` error preference. Constrained Language Mode (the AppLocker/WDAC case `structure/remote-link.md` names) blocks construction of those non-core types, so the inflate errors, `Invoke-Expression` receives `$null`, and `powershell.exe` ends with 1. Before #8100 only the helper source was deflated, and its inflation sat inside `try{Add-Type ...}catch{Fail}`, so the same session exited 126.

Why it matters. 126 is the documented contract "the remote ocx could not be contained; nothing ran", and the Home classifies it as `child-ocx-not-contained` (`src/cli/sync-fanout.ts` `classifySyncResult`). An exit of 1 reads as an ordinary ocx failure (`child-sync-failed` for fan-out, a generic failure for link commands). Nothing runs uncontained, but the refusal is misreported.

Change (`src/link/remote-windows.ts`, `packedPowerShellArgv` only):

```text
$ocxPacked='<chars>'
$ErrorActionPreference='Stop';try{$b=...;$r=[IO.StreamReader]::new(...);$s=$r.ReadToEnd()}catch{try{[Console]::Error.WriteLine('Refusing to run ocx.exe outside a kill-on-close job.')}catch{$null=$_};exit 126};Invoke-Expression $s
```

- Only the inflate is inside the `try`. `Invoke-Expression` stays outside, so an error or exit code from the inflated script is never relabelled 126. CI already shows an inner `exit 23` propagating through `Invoke-Expression` ("Windows native execution preserves ... stdin bytes").
- `$ErrorActionPreference='Stop'` makes every inflate failure terminating, so the `catch` sees it. The inflated `NATIVE_PROCESS` sets `Stop` on its first line already, so the inner script runs under the same preference as today.
- The message write is itself guarded because Constrained Language Mode also blocks `[Console]`, which matches the existing `Fail`.
- Encoded size, measured with realistic inputs: native 5,320 → 5,736, ocx 5,820 → 6,240, pinned sync 6,924 → 7,344 (measured on `09b558580` and on the fix), all under `POWERSHELL_ENCODED_MAX` (8,000). The existing `powershellArgv` throw still guards longer inputs.
- `unpackPowerShell`, `windowsScriptData` and `windowsScriptHelperSource` find `$ocxPacked='...'` by pattern and are unaffected.

Regression tests (`tests/clients/link-ssh-argv-discovery.test.ts`, Windows-only, same file and seam as the failing case): run all three packed builders (`windowsNativeArgv` with the marker script, `windowsOcxArgv`, `windowsPinnedSyncArgv`) in a session that enters ConstrainedLanguage first, and expect 126 for each, with the native marker still absent. The two discovery builders run with `USERPROFILE`, `LOCALAPPDATA` and `ProgramFiles` pointed at an empty temp directory, and `PATH` set to `%SystemRoot%\System32` only. That directory holds no `ocx.exe`, and the session is launched by the absolute `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. No candidate exists, so a 126 can only be the refusal: a candidate cannot produce it, and an unguarded run would exit 1 or 127. The marker additionally proves "nothing ran" for the native builder. The failing case on `dev` is the before-fix evidence.

The success paths through the guarded wrapper are already covered on Windows and must stay green on the final dispatch: "Windows native execution preserves spaces quotes Unicode empty arguments and stdin bytes" (an inner `exit 23` and stdin bytes through `Invoke-Expression`), "Windows discovery selects Desktop before the managed current junction before a legacy executable" (`windowsOcxArgv`), "closing the SSH channel terminates the remote ocx and its PowerShell host" (Job kill-on-close), and `tests/clients/link-pinned-sync-argv.test.ts` "Windows bounds version probes and runs the selected pinned command". A portable assertion that the wrapper refuses before `Invoke-Expression` cannot be made behaviorally off Windows, so none is added. The size budget stays covered portably: the POSIX cases in `link-pinned-sync-argv.test.ts` build the Windows pinned command, and the builder throws above `POWERSHELL_ENCODED_MAX`. The guard costs a fixed 416–420 encoded characters, so the variable argument headroom for `windowsOcxArgv` shrinks by that amount. Its production arguments are short CLI flags and ids; the key travels on stdin.

Also correct the stale comment above `NATIVE_PROCESS` ("The helper travels deflated ... PowerShell inflates it and hands the text to Add-Type"). Since #8100 the whole script travels deflated, and the helper reaches `Add-Type` as a quoted literal.

Docs. `structure/remote-link.md` still says the helper is "carried deflated ... and inflated only into `Add-Type`", which has been stale since #8100. Update it: the whole script travels deflated, and a failed inflation exits 126 before anything runs.

## Failure 2 — the new test's fixture is wrong on Windows

`tests/cli/sync-command-fanout.test.ts` "local-only JSON does not invoke ssh" (added by #8100) timed out at 15,000 ms on windows 2/11 with empty stdout. The same case takes about 300 ms on macOS.

What the evidence establishes. The fixture is provably wrong on Windows (points 2 and 3). That the stall itself comes from the fixture, and not from product code, is a hypothesis supported by point 4: the log discards the child's stderr, so the blocking operation was not observed. The single Windows dispatch on the final head validates it. If the corrected case fails there, the outcome is unresolved, reported with the child stderr the new diagnostics capture, and nothing is weakened.

1. With `--local-only`, `runHomeFanout` returns before reading the store, the status API or any SSH runner (`src/cli/sync-fanout.ts`). Everything that runs is the Home sync #8100 moved from `dispatch.ts` into `sync-command.ts` (the runner body is unchanged apart from routing `console.log` to stderr under `--json`), plus the new flag parse in `root.ts`, which is pure.
2. The child gets only `{HOME, OPENCODEX_HOME, CODEX_HOME, PATH: "<temp>:/usr/bin:/bin"}`. On Windows that has no `SystemRoot`, `USERPROFILE` or `PATHEXT`, a POSIX `:` delimiter, and an extensionless `#!/bin/sh` "ssh" Windows cannot execute. So even a passing run proves nothing about ssh on Windows (fan-out spawns `ssh` by PATH lookup with the inherited environment, `src/link/ssh-runner.ts`).
3. The Home sync reaches Codex write admission, whose ownership probe runs the machine's real `schtasks.exe`/`sc.exe`, resolved from System32 by `GetSystemDirectoryW`. A targeted query answer other than the English not-found text falls through to a full listing with a 20 s budget (`SERVICE_PROBE_LISTING_TIMEOUT_MS`, #2914). The repository's convention for any subprocess test reaching admission on Windows is `claimOwnedServiceHome` + `withOwnedServiceHomePreload` (`tests/helpers/owned-service-home.ts`: "PATH fixtures cannot isolate it"). This test skips it.
4. The same scenario written to that convention — `ocx sync` as a subprocess, Codex on, inherited env with temp `HOME`/`USERPROFILE`, owned-service-home preload (`tests/cli/cli-restore-back.test.ts`) — passed on Windows in this same batch in 688–721 ms (windows 9/11).

The exact operation that blocked in the stripped environment is not observable from the log, because the test discards the child's stderr. No timeout is raised and no case is skipped.

Changes (`tests/cli/sync-command-fanout.test.ts`):

- Subprocess case: build the env the way `cli-restore-back.test.ts` does. Create a temp home directory, call `claimOwnedServiceHome(codexHome, opencodexHome, home)`, and use `{...process.env, HOME: home, USERPROFILE: home, OPENCODEX_HOME, CODEX_HOME, ...owned.env, PATH}`. PATH is `[sentinelDir, owned.env.PATH ?? process.env.PATH].join(delimiter)`, so the helper's Linux `systemctl` fixture survives. The argv goes through `withOwnedServiceHomePreload`. Codex integration stays on and the Codex home stays absent, so the Home path under test is unchanged. The child gets a spawn timeout below the 15,000 ms test budget. If stdout is not one document, the case fails with the child's exit code and stderr, so a future stall names its stage.
- Platform-neutral ssh sentinel. Add `tests/helpers/ssh-spawn-sentinel-preload.ts`, a test-only Bun preload enabled by `OCX_TEST_SSH_SENTINEL=<marker path>`. It wraps exactly `Bun.spawn` and `Bun.spawnSync`, the APIs fan-out uses (`runFanoutProcess` calls `Bun.spawn` directly, and `fanoutSshRunner` delegates to it). An argv whose first element has basename `ssh` or `ssh.exe` (case-insensitive, either separator) appends one line `<api> <basename>` to the marker and throws, so it never runs. Every other call passes through unchanged. It does not touch `node:child_process`, so it composes with the Windows service preload, which mocks that module, without either replacing the other. Its claim is scoped to those two APIs in the CLI process. No production module reads the flag. The subprocess case loads it as `withOwnedServiceHomePreload(["run", "--preload", sentinel, cli, ...])`, the exact combination the controls use. It asserts the marker is absent and the expected document (`schema`, `home.exit === code`, `fanout: disabled`, `children: []`) is present, so a thrown sentinel error cannot pass as a valid run.
- Positive control (same file, same preload combination and env shape). A child runs a script that calls `Bun.spawn(["ssh", "-V"])` and then `Bun.spawnSync(["C:\\fixture\\SSH.EXE", "-V"])`, each in its own try (the sentinel records each attempt), then `Bun.spawnSync([process.execPath, "--version"])` and prints that exit code. On Windows it also calls `child_process.spawnSync("schtasks.exe", ["/query", "/tn", "opencodex-proxy", "/xml"], { encoding: "buffer" })` and prints its stderr. The case asserts two marker lines, `Bun.spawn ssh` and `Bun.spawnSync ssh.exe`, a pass-through exit of 0, and on Windows the `[OCX_TEST_SERVICE_HOME]` stderr, which shows the service fixture is still active beside the sentinel. The `#!/bin/sh` PATH sentinel stays as a second, POSIX-only check. Helpers need no test-layout registration (`tests/test-layout.test.ts` treats `helpers/` as support files).
- New in-process case, `sync --local-only --json` with a committed Home catalog and a connected hub-initiated link, using the file's existing spies. It asserts that `readHomeLinkStatus`, `fanoutSshRunner` and `runFanoutProcess` are never called, and that the document reports `fanout: {state: "disabled", reason: null}` with no children. This is the platform-neutral proof that local-only never reaches ssh, including on Windows, where the PATH sentinel cannot run.
- The "human sync reports a damaged link store" case uses the same stripped POSIX env and reaches the same admission probe; it gets the same env correction, without changing what it asserts.

Nothing in `src/` changes for failure 2.

## Out of scope

Workflows, timeouts, the Windows probe budgets, the slow pinned case (passes, 9.8 s on Windows), any refactor.

## Verification

- `bun test tests/clients/link-ssh-argv-discovery.test.ts tests/cli/sync-command-fanout.test.ts tests/clients/link-pinned-sync-argv.test.ts tests/cli/sync-fanout.test.ts tests/cli/sync-fanout-process.test.ts` (macOS: the Windows cases skip)
- `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`, `bun scripts/test.ts --changed=dev --parallel=1`
- Full `bun run test`: the PR carries `ci:full`, so the four full Ubuntu shards run on the PR head, and the one dispatch runs every platform. Locally, the focused files plus `test:changed` are the floor. The PR's Verification section records the exact commands and anything left to CI, per AGENTS.md's resource exception, because several concurrent worktrees share this host.
- The one authorized `gh workflow run ci.yml --ref <branch>` on the final head: windows 2/11 and 10/11 green, plus the new Windows CLM cases.
- Terra plan audit to PASS, a Terra security review of the containment change, and a Terra code review.



