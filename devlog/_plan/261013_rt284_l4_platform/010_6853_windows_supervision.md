# 010 — #6853 Windows Desktop supervision proof

## Problem

`inspectDesktopSupervision()` returns `{ kind: "unsupported" }` on win32
(`src/service/desktop-supervision.mjs:75`), `desktopStartupOwnership()` excludes win32
(`src/service/desktop-startup.ts:53`) and `diagnoseDesktopStartup()` dispatches only Linux or macOS
(`src/service/desktop-startup.ts:267-268`). On Windows every consumer behaves as if no Desktop runs:
status/doctor recommend `ocx service repair|restart`, `ocx service install` may clear managers, `ocx stop`
omits the Desktop notice and `ocx update` gets no live veto.

## Proof standard (from the issue and its triage)

Desktop is proven only when all hold, twice, with identical snapshots:

1. `ocx.pid`, `runtime-port.json` and an optional `targetPid` agree (existing `capture()`).
2. The runtime process exists; its parent PID is > 0 and names a live process.
3. The parent image basename is `opencodex-desktop.exe` (case-insensitive).
4. The runtime image equals `<dirname(parent image)>\ocx.exe` (case-insensitive, `path.win32` normalized).
5. Parent and child share a session id.
6. Parent creation time strictly precedes child creation time (PID-reuse guard).

Anything unreadable is `unknown` (`probe-failed` or a specific reason), never `desktop` and never `none`.
A parent that is readable and is not Desktop is `none`.

## Acquisition (Node-safe)

One bounded call per snapshot: `powershell.exe -NoProfile -NoLogo -NonInteractive -Command <script>` with
`timeout: 5000`, `windowsHide: true`, reading `Win32_Process` for the runtime PID and then its
`ParentProcessId`, emitting compact JSON
`{"child":{pid,parent,exe,session,created}|null,"parent":{...}|null}` where `created` is the UTC tick count as a
string (exceeds 2^53). PowerShell is resolved as
`<SystemRoot|windir, absolute, else C:\Windows>\System32\WindowsPowerShell\v1.0\powershell.exe`, mirroring
`src/update/npm-invocation.mjs:99-101` (plain ESM cannot reach the FFI resolver in
`src/lib/windows-elevation.ts`). The PID is a validated safe integer interpolated into a numeric filter only.

Seam: `deps.windowsProcesses(pid) => { child, parent }` for tests; default `windowsProcessPair(pid, run)`.

## Diff

### MODIFY `src/service/desktop-supervision.mjs`

- import `win32` from `node:path`.
- NEW `windowsPowerShellPath(env)`, `windowsProcessPair(pid, execute, env)` (exported) that runs the script above
  through `execute` with the Windows timeout and parses/validates rows (`pid`, `parent` safe integers,
  `session` integer, `created` decimal string, `exe` string or null).
- `inspectDesktopSupervision`: accept `win32`; `seen()` accepts `opencodex-desktop.exe` case-insensitively;
  `capture()` calls a NEW `windowsCapture(snapshot)` on win32 that applies checks 2-6 and returns the same
  `{ ...snapshot, kind }` / `{ error }` shape (`proxy-mismatch`, `session-mismatch`, `creation-order`).
  POSIX path unchanged. Result for desktop: `{ kind, runtimePid, supervisorPid, app, proxy }`.
- `run()` gains `windowsHide: true` and an optional timeout argument.

### MODIFY `src/service/desktop-supervision.d.mts`

Add `WindowsProcessRow`, `WindowsProcessPair`, `windowsProcesses?` and `env?` deps, and export
`windowsProcessPair`.

### MODIFY `src/service/desktop-startup.ts`

- `desktopStartupOwnership`: include `win32` (ownership-only, still no probes).
- NEW `diagnoseWindowsDesktopStartup(deps)`:
  - owner `none` → `diagnoseSupervisedStartup(deps, revision, () => ({ loginEnabled: false }))` — the live
    supervisor is reported, Start at Login is not verified on Windows and is never credited.
  - owner desktop → read `%APPDATA%\com.opencodex.desktop\install-id` (Tauri `app_config_dir`,
    `desktop/src-tauri/tauri.conf.json:5`, `desktop/src-tauri/src/identity.rs:22-26`); mismatch → not running;
    otherwise `running` only if `inspectDesktopSupervision` proves Desktop and ownership is unchanged after the
    probe. `loginEnabled: false`.
  - other owners → `undefined`.
- `diagnoseDesktopStartup`: dispatch `win32` to it.

`src/codex/autostart-health.ts:94` stays darwin/linux-only: Windows can report the supervisor and drop the
`ocx service` advice (`autostart-health.ts:110,122-125,224`) but cannot read as protected until Windows Start at
Login is verified. Recorded as residual.

### Consumers (no code change expected; covered by tests)

`desktop-command-guard.ts` (install/repair/start/restart refusal), `desktop-runtime-guidance.ts` (stop notice,
duplicate start), `bin/ocx.mjs:339-340` and `src/update/index.ts:489,658` (update veto), `doctor.ts`,
`hub-disable.ts`, `status.ts:317-334` local-supervision override.

## Tests

NEW `tests/service/service-desktop-supervision-windows.test.ts` (domain `service`; register in
`layout.json` by appending to an existing `service` line and in `test-layout-expected.json`):

- proves Desktop for matching pid files, sibling `ocx.exe`, same session and older parent (case-insensitive paths)
- a non-Desktop readable parent is positive `none`
- runtime image outside the Desktop directory → `unknown/proxy-mismatch`, desktopSeen true
- session mismatch, equal or newer parent creation → `unknown`
- unreadable parent image, malformed JSON, thrown PowerShell → `unknown/probe-failed`, desktopSeen false
- changed second snapshot → `unknown/snapshot-changed`
- default reader builds the PowerShell argv under SystemRoot with a numeric filter and parses tick strings
- `desktopServiceCommandRefusal("install")`, `desktopStopNotice`, latch, with win32 evidence
- `diagnoseDesktopStartup` on win32: unowned supervisor → `supervisor` set, `loginEnabled:false`, health has no
  `ocx service` command; owned with matching install-id → `owned:true, running:true`; mismatched id → not running
- `desktopStartupOwnership` on win32 → owned projection without probes

MODIFY `tests/service/service-desktop-startup.test.ts`: the "unsupported platforms never probe" case drops
`win32` from its platform list (keeps `freebsd`).


## Amendments after architect reflection (Huygens, MISALIGNED → folded)

| Finding | Disposition |
|---|---|
| P1 owned projection vs legacy status override (`src/cli/status.ts:326`, `tests/cli/cli-status-startup-health.test.ts:284`) | **Rejected for this lane, residual recorded.** The `owned === false` requirement is shared macOS/Linux policy pinned by a test; changing it is a cross-platform policy change. The gap is transitional: a runtime carrying this change reports Windows ownership through `desktopStartupOwnership`, so only an *older* Windows runtime with a durable Desktop claim keeps its live service advice. The owned Windows diagnostic mirrors macOS (no `supervisor` field). |
| P1 both PID records required | **Accepted.** On win32, `desktop` requires `ocx.pid` and `runtime-port.json` both present, valid and equal (and equal to `targetPid` when given); either missing → `unknown/pid-record-missing`. Returned `child.pid` must equal the runtime PID and `parent.pid` must equal `child.parent`, else `probe-failed`. |
| P1 partial observation loses the veto | **Accepted.** The reader calls `seen()` as soon as a parent `exe` string is present, before validating any other field, so a Desktop image with unreadable session/creation evidence yields `unknown` with `desktopSeen: true`. |
| P2 startup seam | **Accepted.** `DesktopStartupDeps` gains `windowsProcesses` and `readWindowsInstallId`; they are forwarded to `inspectDesktopSupervision`; tests never read a real profile. |
| P2 aggregate deadline | **Accepted.** Each `inspectDesktopSupervision` call on win32 gets a 6,000 ms budget shared by its two acquisitions (each `min(3000, remaining)`, at least 250 ms or the snapshot is `probe-failed`), so `diagnoseSupervisedStartup`'s two inspections stay under 12 s, inside the 15 s Windows probe budget (`src/codex/autostart-health.ts:14`). A test drives slow successful acquisitions with an injected clock. |
| ticks compared numerically | **Accepted.** `BigInt` comparison of decimal tick strings. |
| missing child/parent evidence | **Accepted.** On win32 a missing child row is `unknown/process-missing` and a missing parent row `unknown/parent-missing` (not POSIX `none`). A readable non-Desktop parent stays positive `none`. |
| broader consumer tests | **Accepted.** Tests cover install/repair/start/restart refusal, duplicate-start guidance, stop notice, update veto through `resolveRuntimeOwnership`-style supervision input, and status selection for an older live verdict with an unowned supervisor. |
| update claim correction | **Accepted.** Durable non-CLI ownership already vetoes update replacement (`src/update/runtime-ownership.mjs:70`); the gap is the *live supervision* veto. |
| live Windows qualification | Outstanding; recorded as residual for the coordinator/issue. |


## Amendments after independent audit round 1 (Arendt, FAIL → folded)

| Finding | Disposition |
|---|---|
| P1 legacy owned Windows status case | **Accepted (supersedes the earlier rejection).** Older Windows runtimes never reported a `desktop` diagnostic, so the owned case cannot have existed in a legacy live verdict before. The Windows owned diagnostic carries `supervisor: { supervisorPid, runtimePid, app }` when the live chain is proven (durable `owned: true` preserved). `selectStatusStartupHealth` (`src/cli/status.ts:326`) accepts `local.desktop.owned === true` **only when `local.platform === "win32"`**; the PID-pair binding, the missing-capability precondition and macOS/Linux policy are unchanged. Tests: win32 owned legacy override, win32 unowned legacy override, changed pair, inconclusive probe, modern live verdict authoritative, and the existing darwin/linux "owned" rejection still holds. |
| P2 image paths must be fully qualified | **Accepted.** A row `exe` is evidence only if it matches `^[A-Za-z]:\\` after `/`→`\` (drive-absolute). UNC (`\\server`), device (`\\?\`, `\\.\`), drive-relative (`C:foo`), rooted (`\foo`), relative and empty paths are `unknown/image-unqualified` and never yield `desktop` or positive `none`. Fixtures cover each form. |
| P2 partial-observation interface | **Accepted.** `windowsProcessPair(pid, execute, { onExecutable, timeoutMs, env })` calls `onExecutable(parent.exe)` for any string parent image **before** strict row validation; `inspectDesktopSupervision` passes `seen`. Injected `windowsProcesses(pid, { onExecutable, timeoutMs })` gets the same options. Tests feed malformed rows through the default reader with an injected `run` and assert `unknown` + `desktopSeen: true` plus a blocked latch. The per-acquisition timeout is `min(3000, remaining)` from the 6,000 ms inspection budget; the original 5,000 ms figure is withdrawn. |
| P2 test runner pin | **Accepted.** The lane branch is based on dev, whose `package.json` `testRunnerBun` is 1.4.0; tests use the global `~/.bun/bin/bun` 1.4.0 (the coordinator's 1.4.3 override applies only to the union with #6986). Verification also runs `tests/service/service-desktop-startup.test.ts`, `service-desktop-startup-linux.test.ts`, `tests/cli/cli-status-startup-health.test.ts`, and a Node (`node -e`) import smoke of `src/service/desktop-supervision.mjs` exercising `windowsProcessPair` with an injected `run`. |
| P2 docs sync | **Accepted.** Update `structure/desktop-shell.md` (§ runtime ownership, "Windows reports supervision as unsupported"), `structure/ops/service-and-sidecars.md:430`, `structure/runtime.md:546`, and `docs-site/src/content/docs/guides/desktop-app.md:101-143` plus its translated mirrors where they state the Windows limitation: Windows now proves live supervision; Windows Start at Login remains unverified, so Windows never reads as protected by Desktop. |


## Amendment after audit round 2 (NEAR-PASS, P3 folded)

Update the comments that describe supervision as exclusively unowned: `src/service/desktop-startup.ts:17`
(`supervisor` field) and `src/cli/status.ts:325` (selector) — live supervision stays independent of ownership; the
owned override is Windows-only because older Windows runtimes never reported a Desktop diagnostic.

