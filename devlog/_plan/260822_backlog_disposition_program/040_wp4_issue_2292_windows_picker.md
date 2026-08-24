# WP4 — Reimplement #2292: Windows model picker stale after ocx sync --restart-codex

> Source: read-only research lane `res-2292` (model `openrouter/stealth-ox-alpha`), dispatched at work-phase 0 against `dev@ced9a85c5`.
> Every file:line pointer below was independently spot-checked by the main agent before the roadmap was locked; verification notes are appended at the end of this document.

All pointers verified against `dev@ced9a85c5`. The triage comment is accurate; PR #2293 landed only the standalone PowerShell helper, and the CLI integration it promised is still missing. Here is the diff-level implementation doc.

---

# #2292 — Windows model picker stays stale after `ocx sync --restart-codex`

## 1. ROOT CAUSE

**Chain: `ocx sync` → app-server-only kill → Electron shell (`ChatGPT.exe`) never signaled → renderer cache survives → doctor prints false OK.**

1. [src/cli/dispatch.ts:205](/Users/jun/Developer/new/700_projects/opencodex/src/cli/dispatch.ts:205) parses only one flag:
   ```ts
   const restartCodex = deps.args.slice(1).includes("--restart-codex");
   ```
   and at [src/cli/dispatch.ts:230-232](/Users/jun/Developer/new/700_projects/opencodex/src/cli/dispatch.ts:230):
   ```ts
   if (synced.catalogWritten || synced.cacheSynced) {
     afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
   }
   ```
   `sync-cache` repeats this verbatim at [src/cli/dispatch.ts:261-273](/Users/jun/Developer/new/700_projects/opencodex/src/cli/dispatch.ts:261).

2. [src/codex/app-server-processes.ts:1072-1101](/Users/jun/Developer/new/700_projects/opencodex/src/codex/app-server-processes.ts:1072) — `afterCatalogWriteHandleAppServers` operates only on `listCodexAppServerProcesses(...)` output, i.e. matches of `isCodexAppServerCommandLine` ([src/codex/app-server-processes.ts:247-274](/Users/jun/Developer/new/700_projects/opencodex/src/codex/app-server-processes.ts:247)). That matcher requires token[0] to be a `codex`/`codex.exe`/`codex.cmd`/target-triple executable **and** subcommand `app-server`, or a `codex-code-mode-host` token. `ChatGPT.exe` (the Electron desktop shell) matches neither — its command line contains no `codex` executable token, so it is never listed, never killed, never relaunched. The registry contract even advertises this narrowness: [src/cli/registry.ts:95](/Users/jun/Developer/new/700_projects/opencodex/src/cli/registry.ts:95): `"--restart-codex sends SIGTERM only to matching app-server / code-mode-host processes"`.

3. Why the picker stays stale: the desktop renderer caches `model/list` + `config/read` (TanStack Query over stdio JSON-RPC) and invalidates only on a `codex-app-server-initialized` event; on Windows MSIX, externally `taskkill`ing the `codex.exe` child does not reliably re-emit that event in the surviving shell (devlog research, `devlog/_plan/260821_260821-windows-picker-full-restart/000_plan.md:24-31`). macOS recovers because the respawned app-server triggers the event; Windows does not.

4. The false-OK path: `collectCodexAppServerCatalogState` ([src/codex/app-server-processes.ts:774-824](/Users/jun/Developer/new/700_projects/opencodex/src/codex/app-server-processes.ts:774)) compares **app-server start time vs catalog mtime**. The freshly respawned `codex.exe` postdates the catalog, so state = `fresh`, and [src/cli/doctor.ts:1153-1154](/Users/jun/Developer/new/700_projects/opencodex/src/cli/doctor.ts:1153) prints `[OK] Codex app-server model catalog is current with the on-disk catalog.` — while the Electron shell still shows the old picker. All three user-facing hints point at the flag that doesn't fix Windows: `STALE_CODEX_APP_SERVER_HINT` ([src/codex/app-server-processes.ts:19-20](/Users/jun/Developer/new/700_projects/opencodex/src/codex/app-server-processes.ts:19)), `formatStaleCodexAppServerWarning`, and doctor's WARN text (`ocx sync --restart-codex`).

5. The GUI restart route has the same hole: `performCodexRestart` ([src/codex/app-server-restart-service.ts:78-79](/Users/jun/Developer/new/700_projects/opencodex/src/codex/app-server-restart-service.ts:78)) uses the same `collectCodexAppServerCatalogState` + `restartCodexAppServers`, so a dashboard click also restarts only the app-server.

6. Windows kill semantics are **not** the cause: `defaultKillCodexAppServer` ([src/codex/app-server-processes.ts:976-998](/Users/jun/Developer/new/700_projects/opencodex/src/codex/app-server-processes.ts:976)) uses `taskkill /PID <pid> /T /F`; `/T` covers only that PID's descendants. The Electron shell is the *parent*, so it is intentionally untouched. This asymmetry must be preserved (Unix SIGTERM stays graceful, no SIGKILL escalation — comment at :962-971).

7. Existing state: `scripts/restart-codex-desktop-app.ps1` exists (from #2293) with package-bound targeting, self-kill guard, `CloseMainWindow` → bounded `taskkill /T /F` → AUMID relaunch — but it is **unreachable from the product**: `package.json` `files` = `['bin','src','gui/dist','assets/...','README.md','AGENTS_INSTALL.md','LICENSE']` — no `scripts/`, and nothing in `src/` references it (`rg 'restart-codex-desktop-app'` hits only the devlog). Also note its constants are hardcoded (`$PackageFamily = "OpenAI.Codex_2p2nqsd0c76g0"`), which the maintainer triage explicitly rejects for the integrated path (AUMID changes per beta build).

## 2. FILE CHANGE MAP

Design constraints from the maintainer triage (verified consistent with the code): `--restart-codex` must keep app-server-only matching; the new capability is an opt-in Windows-only `--restart-desktop-app`, run only after an actual write; discovery must be runtime (no hardcoded AUMID); fail closed with an actionable message; Unix/macOS untouched.

### 2.1 NEW `src/codex/desktop-app-restart.ts`

New module (keeps `app-server-processes.ts` untouched — the triage warns against rebasing over a moved file).

```ts
export interface DesktopAppRestartIo {
  platform?: NodeJS.Platform;
  execFile?: (file: string, args: readonly string[]) => Promise<{ stdout: string }>;
  isAlive?: (pid: number) => boolean;
  waitExit?: (pid: number, timeoutMs: number) => boolean;
  log?: Pick<Console, "log" | "error"> | null;
}

export interface DesktopAppRestartResult {
  attempted: boolean;
  stopped: number[];
  surviving: number[];
  relaunch: "started" | "skipped";
  reason?: string;   // set when attempted === false or relaunch === "skipped"
}

export async function restartCodexDesktopApp(io: DesktopAppRestartIo = {}): Promise<DesktopAppRestartResult>
```

Implementation contract (all via `resolveTrustedWindowsPowerShellExe()` / `resolveTrustedWindowsTaskkillExe()` from `src/lib/windows-elevation.ts:192` — never PATH):

1. `if ((io.platform ?? process.platform) !== "win32") return { attempted: false, stopped: [], surviving: [], relaunch: "skipped", reason: "windows_only" };`
2. Discover the package at runtime with a single PowerShell probe (one `execFile` call, `timeout: 10_000`, `windowsHide: true`):
   ```powershell
   $p = Get-AppxPackage -Name OpenAI.Codex; if (-not $p) { $p = Get-AppxPackage -Name OpenAI.CodexBeta }
   if (-not $p -or -not $p.InstallLocation) { 'MISS' } else {
     '{0}`n{1}`n{2}' -f $p.PackageFamilyName, $p.InstallLocation, "$($p.PackageFamilyName)!App"
   }
   ```
   Parse `family`, `installLocation`, `aumid`. On `MISS` or unparseable output: return `{ attempted: false, ..., reason: "package_discovery_failed" }` — **do not kill anything** (fail closed per triage).
3. Enumerate candidate roots:
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
     Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installLocation, 'OrdinalIgnoreCase') }
   ```
   Case-insensitive `StartsWith` handles Windows path casing. Roots = processes whose `ParentProcessId` is not itself a package-tree process (mirrors the .ps1 root logic at `scripts/restart-codex-desktop-app.ps1:33-36`).
4. Self-kill guard: walk `process.ppid` ancestry (or a PowerShell-side ancestry walk like the .ps1 at :44-56); if any root is an ancestor, abort with `reason: "self_ancestry"` and kill nothing.
5. Graceful pass per root: `execFile(powershell, ['-NoProfile','-Command', ` (Get-Process -Id <pid>).CloseMainWindow() `])`, then poll `io.waitExit(pid, 1000)` up to 15 s. If still alive → forced pass: `execFile(resolveTrustedWindowsTaskkillExe(), ['/PID', String(pid), '/T', '/F'])` (same trusted-resolution discipline as `defaultKillCodexAppServer`), then wait up to 5 s. Record `stopped` / `surviving`.
6. Relaunch only if every verified target stopped: `execFile(powershell, ['-NoProfile','-Command', `Start-Process 'shell:AppsFolder\<aumid>'`])`. If any survivor, skip relaunch and set `reason: "targets_survived"`.
7. Export a test-only seam type so every branch is injectable (`execFile`, `isAlive`, `waitExit`, `platform`), following the `CodexAppServerProcessIo` pattern at [src/codex/app-server-processes.ts:70-91](/Users/jun/Developer/new/700_projects/opencodex/src/codex/app-server-processes.ts:70).

### 2.2 MODIFY `src/cli/dispatch.ts`

Symbol: `sync` handler.

**Before** ([src/cli/dispatch.ts:205](/Users/jun/Developer/new/700_projects/opencodex/src/cli/dispatch.ts:205)):
```ts
    const restartCodex = deps.args.slice(1).includes("--restart-codex");
```
**After**:
```ts
    const syncArgs = deps.args.slice(1);
    const restartCodex = syncArgs.includes("--restart-codex");
    const restartDesktopApp = syncArgs.includes("--restart-desktop-app");
```

**Before** ([src/cli/dispatch.ts:230-232](/Users/jun/Developer/new/700_projects/opencodex/src/cli/dispatch.ts:230)):
```ts
    if (synced.catalogWritten || synced.cacheSynced) {
      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
    }
```
**After**:
```ts
    if (synced.catalogWritten || synced.cacheSynced) {
      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
      if (restartDesktopApp) {
        const { restartCodexDesktopApp } = await import("../codex/desktop-app-restart");
        const desktop = await restartCodexDesktopApp({ log: console });
        if (desktop.reason === "windows_only") {
          console.error("--restart-desktop-app is supported on Windows only; nothing was stopped.");
        } else if (desktop.reason === "package_discovery_failed") {
          console.error("Could not identify the OpenAI Codex desktop package; quit and relaunch the desktop app manually to refresh the model picker.");
        } else if (desktop.reason === "targets_survived") {
          console.error(`Desktop app PID(s) ${desktop.surviving.join(", ")} did not exit; quit the desktop app manually to refresh the model picker.`);
        } else if (desktop.relaunch === "started") {
          console.log("Codex desktop app restarted; the model picker will re-read the catalog.");
        }
      }
    }
```

Symbol: `sync-cache` handler — identical two edits at [src/cli/dispatch.ts:261](/Users/jun/Developer/new/700_projects/opencodex/src/cli/dispatch.ts:261) (`const restartCodex = ...` line) and [src/cli/dispatch.ts:270-272](/Users/jun/Developer/new/700_projects/opencodex/src/cli/dispatch.ts:270) (same `if (invalidated.kind === "completed" && invalidated.value)` block, same appended desktop block).

### 2.3 MODIFY `src/cli/registry.ts`

Symbols: `sync` and `sync-cache` entries.

**Before** ([src/cli/registry.ts:91](/Users/jun/Developer/new/700_projects/opencodex/src/cli/registry.ts:91)):
```ts
    usage: "ocx sync [--restart-codex]",
```
**After**:
```ts
    usage: "ocx sync [--restart-codex] [--restart-desktop-app]",
```
and add to `details` after the existing `--restart-codex` line:
```ts
      "--restart-desktop-app (Windows only, opt-in) fully restarts the Codex desktop app so its model picker re-reads the catalog; never implied by --restart-codex.",
```
Same for `sync-cache` at [src/cli/registry.ts:100](/Users/jun/Developer/new/700_projects/opencodex/src/cli/registry.ts:100).

### 2.4 MODIFY `src/cli/doctor.ts`

Symbol: the `#857` catalog-state block.

**Before** ([src/cli/doctor.ts:1153-1154](/Users/jun/Developer/new/700_projects/opencodex/src/cli/doctor.ts:1153)):
```ts
  } else if (catalogState.state === "fresh") {
    console.log("  [OK] Codex app-server model catalog is current with the on-disk catalog.");
```
**After** (suppress false OK on Windows when the desktop shell predates the catalog — the shell, not the app-server, owns the picker):
```ts
  } else if (catalogState.state === "fresh") {
    if (process.platform === "win32" && desktopShellPredatesCatalog()) {
      console.log("  [WARN] The Codex desktop app started before the on-disk catalog changed; its model picker may still show the old list. Action: quit and relaunch the desktop app (or run 'ocx sync --restart-desktop-app')");
    } else {
      console.log("  [OK] Codex app-server model catalog is current with the on-disk catalog.");
    }
```
Supporting helper (same file or in `desktop-app-restart.ts`, exported for tests): reuse the existing PowerShell CIM machinery pattern — enumerate `ChatGPT.exe` processes under the discovered package `InstallLocation` (runtime discovery identical to §2.1 step 2), take the earliest `CreationDate`, compare against `defaultCatalogMtimeMs()` (the same mtime source `collectCodexAppServerCatalogState` uses at [src/codex/app-server-processes.ts:806](/Users/jun/Developer/new/700_projects/opencodex/src/codex/app-server-processes.ts:806)). On any discovery/read failure return `false` (never manufacture a WARN from guesswork — matches the `unknown`-not-stale doctrine at [src/codex/app-server-processes.ts:789-795](/Users/jun/Developer/new/700_projects/opencodex/src/codex/app-server-processes.ts:789)).

### 2.5 MODIFY `src/codex/app-server-processes.ts` (one line, hint text only)

**Before** ([src/codex/app-server-processes.ts:19-20](/Users/jun/Developer/new/700_projects/opencodex/src/codex/app-server-processes.ts:19)):
```ts
export const STALE_CODEX_APP_SERVER_HINT =
  "If Codex still shows an older model list, restart its long-lived app-server process after sync (ocx sync --restart-codex).";
```
**After**:
```ts
export const STALE_CODEX_APP_SERVER_HINT =
  "If Codex still shows an older model list, restart its long-lived app-server process after sync (ocx sync --restart-codex); on Windows the desktop app may also need a full restart (ocx sync --restart-desktop-app).";
```
This propagates automatically to `formatStaleCodexAppServerWarning`, `attachStaleAppServerHint`, and the dashboard hint — all read this constant.

### 2.6 OPTIONAL (defer unless trivial): package the helper

`package.json` `files` currently omits `scripts/`, so `scripts/restart-codex-desktop-app.ps1` never ships. The CLI-integrated path above does not depend on the .ps1 file (it inlines the same logic via trusted PowerShell), so packaging is not a blocker; if the team wants the standalone script shipped too, add `"scripts"` to `files` — but flag that as a separate decision since it changes the npm payload.

## 3. TEST PLAN

### 3.1 NEW `tests/desktop-app-restart.test.ts`

Inject everything through `DesktopAppRestartIo` — no real processes, no Windows required.

- `"is a no-op off Windows"` — `platform: "linux"` → `{ attempted: false, relaunch: "skipped", reason: "windows_only" }`, `execFile` never called.
- `"fails closed when package discovery returns nothing"` — `execFile` returns `{ stdout: "MISS" }` → `attempted: false`, no kill call ever issued.
- `"kills only package-tree roots, gracefully first, forced after timeout"` — fake `execFile` script returns package info for discovery and records `taskkill` calls; `isAlive` returns true for 3 polls then false → assert exactly one `CloseMainWindow`-shaped PowerShell call per root, no `taskkill`; then with `waitExit` always false → assert `taskkill /PID <root> /T /F` and **no kill of a ChatGPT.exe whose ExecutablePath is outside the install location** (include an out-of-package decoy process in the CIM fixture output).
- `"refuses to kill its own ancestry"` — CIM fixture lists a root PID present in the injected ancestry chain → `reason: "self_ancestry"`, zero kill calls.
- `"relaunches via the discovered AUMID only after every target stopped"` — all stop → assert `Start-Process 'shell:AppsFolder\<discovered aumid>'` call and `relaunch: "started"`; one survivor → no relaunch call, `reason: "targets_survived"`.
- `"does not hardcode the beta AUMID"` — discovery fixture returns `OpenAI.Codex_9.9.9.0_hzzzzzzz0!App` → relaunch command contains that exact string.

### 3.2 MODIFY `tests/codex-app-server-processes.test.ts`

In the existing `"rejects unrelated processes..."` block ([tests/codex-app-server-processes.test.ts:433-437](/Users/jun/Developer/new/700_projects/opencodex/tests/codex-app-server-processes.test.ts:433)) add the regression the triage demands:

```ts
expect(isCodexAppServerCommandLine(
  '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_2p2nqsd0c76g0\\ChatGPT.exe" --msix'))
  .toBe(false);
```

**Fails before**: currently `true`? No — it already returns `false` (no `codex` token). This is a **lock-in test**, not a red/green test; the red/green tests are in 3.3/3.4. State that explicitly in the PR.

### 3.3 MODIFY `tests/dispatch-sync.test.ts` (or the existing sync-arg test file — locate with `rg -l '"sync"' tests/ | head`)

- `"ocx sync --restart-desktop-app triggers the desktop restart only after a real write"` — inject a fake `syncModelsToCodex` returning `{ catalogWritten: false, cacheSynced: false }` → desktop restart import/mock not invoked; with `catalogWritten: true` → invoked exactly once with the console logger. Also assert `--restart-codex` alone does **not** invoke it (default-off contract).
- `"sync-cache --restart-desktop-app triggers after completed invalidation"` — `invalidated.kind !== "completed"` → not invoked; `completed && value` → invoked.

### 3.4 MODIFY doctor test (`rg -l 'model catalog is current' tests/`)

- `"doctor suppresses the fresh OK on Windows when the desktop shell predates the catalog"` — inject `platform: win32`, `desktopShellPredatesCatalog: true` → output contains `[WARN] The Codex desktop app started before` and does **not** contain `[OK] Codex app-server model catalog is current`. This is the precise false-OK regression from the issue: **fails before** the fix (prints OK), **passes after**.
- `"doctor keeps the fresh OK when shell discovery fails"` — helper returns `false` → OK line preserved.

## 4. VERIFIER COMMAND

```bash
bun test tests/desktop-app-restart.test.ts tests/codex-app-server-processes.test.ts
bun test tests/dispatch-sync.test.ts   # or the located sync-arg test file
bun x tsc --noEmit
```

Yes, all of these read the changed files: the new test file imports `src/codex/desktop-app-restart.ts` directly; the dispatch tests exercise `src/cli/dispatch.ts`'s `sync`/`sync-cache` handlers; the process-matcher test reads `src/codex/app-server-processes.ts`; tsc's `tsconfig` includes `src/`. Per repo policy this is a scoped change to CLI dispatch + a new isolated module, so focused checks are correct; run the full `bun run typecheck && bun run test` only before marking the PR review-ready.

## 5. ACTIVATION SCENARIO

A test triggers the new path by (a) passing `--restart-desktop-app` in the dispatch handler's `deps.args` (e.g. `["sync", "--restart-desktop-app"]`) with an injected `syncModelsToCodex` stub returning `catalogWritten: true`, and (b) injecting a fake `execFile` in `DesktopAppRestartIo` whose scripted outputs simulate: package discovery → CIM process list → graceful close → exit. The observable proof the conditional path ran is the recorded `execFile` call sequence (discover → close → taskkill only on timeout → `Start-Process shell:AppsFolder\...`) plus the returned `{ attempted: true, relaunch: "started" }` and the `"Codex desktop app restarted..."` console line captured by an injected logger. For doctor, the observable is the WARN line replacing the OK line in captured stdout. On a real Windows machine the end-to-end proof is: `ocx sync --restart-desktop-app` → all package-tree PIDs change (new `ChatGPT.exe` start time) → picker shows the 5 appended models.

## 6. RISK / BLOCKERS

- **Not implementable as "widen `--restart-codex`"** — explicitly forbidden by the triage (registry contract at [src/cli/registry.ts:95](/Users/jun/Developer/new/700_projects/opencodex/src/cli/registry.ts:95) advertises app-server-only, and killing the Electron shell interrupts whole conversations, a different consent). The doc above respects that.
- **PowerShell/Appx availability**: `Get-AppxPackage` exists in Windows PowerShell 5.1; pwsh 7 needs the `Appx` module import fallback (the .ps1 does `Import-Module Appx -ErrorAction SilentlyContinue` at :16). The TS path must tolerate discovery failure and fail closed — covered by test 3.1 case 2.
- **MSIX path casing**: handled with `OrdinalIgnoreCase` `StartsWith`; the `PackageFamilyName` is *not* a substring of `InstallLocation`, so match on `InstallLocation` only (the .ps1's approach).
- **`CloseMainWindow` close-to-tray**: the 15 s bounded wait plus forced fallback mirrors the .ps1; the WARN-then-force behavior is asserted in test 3.1 case 3.
- **The hardcoded AUMID in the shipped .ps1** (`scripts/restart-codex-desktop-app.ps1:19-20`) contradicts the triage ("AUMID는 베타 MSIX가 빌드마다 바뀜… 하드코드 금지"). The integrated TS path fixes this by runtime discovery; the standalone script remains a known deviation — worth a follow-up note in the PR, not a blocker for the CLI contract.
- **`desktopShellPredatesCatalog` adds a synchronous PowerShell probe to `ocx doctor` on Windows** — acceptable (doctor is already a cold diagnostics path and the app-server collector there is synchronous too), but keep it behind a short timeout and fail-open to the OK line.
- **No blockers to implementation as specified.** The devlog plan explicitly scoped runtime integration *out* of wp1 and deferred it to "a later unit" (`000_plan.md` OUT section) — this is that unit.


---

# AMENDMENT (A-phase round 1, blockers B5+B6)

**B5 — the named verifier does not exist.** `tests/dispatch-sync.test.ts` is not in the
tree. The real dispatch suite is `tests/cli-dispatch.test.ts`. Every mandatory new suite
gets an existence gate and its own invocation:

```bash
test -f tests/desktop-app-restart.test.ts || exit 1
bun test tests/desktop-app-restart.test.ts
test -f tests/cli-dispatch.test.ts || exit 1
bun test tests/cli-dispatch.test.ts
bun test tests/codex-app-server-processes.test.ts
```

Rationale: Bun exits 0 on a multi-file invocation when some listed files are missing, as
long as one exists. A single combined command would report green while the regression
that proves the fix never ran.

**B6 — the `execFile` seam cannot carry its mandated timeout.** The proposed type

```ts
execFile?: (file: string, args: readonly string[]) => Promise<{ stdout: string }>;
```

has no options parameter, yet the same document requires `timeout: 10_000` and
`windowsHide: true`. A hung `Get-AppxPackage` or CIM probe would wedge `ocx sync` and
`ocx doctor` with no bound. Amended seam:

```ts
execFile?: (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; windowsHide?: boolean; signal?: AbortSignal },
) => Promise<{ stdout: string }>;
```

Acceptance additions: a test proving the probe rejects on timeout and does not leave a
child process behind, and a test proving a timed-out discovery fails **closed** (kills
nothing, relaunches nothing).

