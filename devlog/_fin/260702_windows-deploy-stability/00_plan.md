# Windows/Linux Deploy Stability — Loop 1 Plan (P)

- **Date:** 2026-07-02
- **Branch:** cursor-fixes
- **Class:** C3 (cross-module platform hardening; no public API change)
- **Driver:** User reports: proxy generally flaky/breaking on Windows; Linux not fully stable.
  macOS is fine. Suspected: paths, shell/PowerShell, lifecycle.
- **Evidence base:** first-hand code review (this doc); parallel Codex audits (Windows RCA,
  macOS lifecycle) fold into Loop 2.

## Findings (ranked)

| # | Severity | OS | Defect | Evidence |
|---|----------|----|--------|----------|
| F1 | high | win | `spawnSync("npm.cmd")` without `shell:true` → EINVAL on Node ≥18.20/20.12 (CVE-2024-27980 hardening). `ocx update` dies for npm installs. | `bin/ocx.mjs:73,87` |
| F2 | high | win | `.cmd` wrappers written UTF-8; cmd.exe parses batch in OEM codepage (CP949/GBK). Non-ASCII profile paths (Korean/Chinese usernames) → mojibake → shim/service silently broken. `.ps1` shim without BOM → same misread in Windows PowerShell 5.1. | `src/codex-shim.ts:217-229`, `src/service.ts:381` |
| F3 | high | win | No graceful stop path: `killProxy` goes straight to `taskkill /F`; launcher signal "forwarding" is a hard TerminateProcess. Drain/cleanup (`cli.ts:159-199`) never runs → stale pid/runtime-port, injected config left behind on service restart/console close. `/api/stop` (graceful drain + restore, `server.ts:1904-1914`) exists but is unused by CLI stop. | `src/process-control.ts:22-36`, `bin/ocx.mjs:170-203` |
| F4 | med-high | win | Injected `base_url = http://localhost:<port>/v1` vs server binding IPv4 `127.0.0.1` only. Windows resolves `localhost` → `::1` first → refusal/latency depending on stack. Reverse bug too: configured `::1` collapses to `localhost`. | `src/codex-inject.ts:33-38,51` vs `src/server.ts:1562,1960` |
| F5 | med | win | `timeout /t 5 /nobreak` in service wrapper fails without console stdin ("Input redirection is not supported") → hot restart loop. | `src/service.ts:298` |
| F6 | high | linux | `openUrl` spawn has no `error` listener → ENOENT (`xdg-open` missing on headless) = unhandled 'error' event → process crash during OAuth login/GUI open. | `src/open-url.ts:20` |
| F7 | med | win | `src/update.ts` `spawnSync("npm")` — bare name fails on Windows (npm is `npm.cmd`). | `src/update.ts:35,78` |
| F8 | low-med | win | Git-Bash `codex` (extensionless sh launcher) not shimmed → autostart silently absent for Git-Bash users. **Deferred to Loop 2.** | `src/codex-shim.ts:82-111` |
| F9 | low | linux | systemd detection via `systemctl --user show-environment` fails in SSH sessions without DBUS. **Deferred to Loop 2.** | `src/service.ts:441-444` |

## Loop 1 scope: F1–F7 (F8/F9 + Codex-audit findings → Loop 2)

### Part 2 — diff-level changes

**MODIFY `bin/ocx.mjs`** (F1)
- `runNpmSelfUpdate()`: both `spawnSync(npm, ...)` calls gain
  `shell: process.platform === "win32"`.
- `updateTag()` (`bin/ocx.mjs:43-47`): raw `--tag` argv value flows unvalidated into the
  spawn args (audit item 9) — allowlist to `preview`/`latest` (mirror `src/update.ts:26-30`)
  BEFORE it reaches any shell-joined spawn.

**MODIFY `src/service.ts`** (F2, F5)
- `buildWindowsServiceScript()`: insert `chcp 65001 >nul` after `@echo off`/`setlocal`
  (wrapper runs in its own hidden console — no codepage leak to user shells); replace
  `timeout /t 5 /nobreak >nul` with `ping -n 6 127.0.0.1 >nul`.
- New helper `windowsEnvIndirectPath(path)`: replace leading `%LOCALAPPDATA%`,
  `%APPDATA%`, `%USERPROFILE%` prefixes (longest match, case-insensitive compare of
  resolved values from `process.env`) with the literal env token so cmd expands the
  non-ASCII profile prefix natively at runtime. Apply to embedded values
  (`OCX_BUN`, `OCX_CLI`, `OCX_API_TOKEN_FILE`, `OCX_SERVICE_LOG`, `CODEX_HOME`,
  `OPENCODEX_HOME`) in the batch builder. Batch expansion of `set "X=%APPDATA%\..."`
  happens at parse time in the correct codepage — defense in depth alongside chcp.

**MODIFY `src/codex-shim.ts`** (F2)
- `buildWindowsCodexShim()`: apply the same env-indirection to `OCX_REAL_CODEX`,
  `OCX_BUN`, `OCX_CLI`, `OCX_API_TOKEN_FILE` (import helper from service.ts or a small
  shared module `src/win-paths.ts` — NEW, ~30 lines, to avoid a service.ts↔codex-shim.ts
  cycle). No `chcp` in the codex.cmd shim (it runs in the USER's console; changing the
  codepage there would leak).
- `writeShim()`: write `.ps1` shim with UTF-8 **BOM** (`"﻿" + content`) so Windows
  PowerShell 5.1 decodes it as UTF-8.

**NEW `src/win-paths.ts`** — `windowsEnvIndirectPath()` + unit-testable pure helpers
(explicit env map parameter for tests).

**MODIFY `src/process-control.ts` + `src/cli.ts` + `src/service.ts`** (F3)
- New async `stopProxyGracefully(pid, opts)` (in `process-control.ts`): resolve port via
  `readRuntimePort(pid)` (port is guaranteed recoverable; hostname is NOT — always POST to
  `http://127.0.0.1:<port>/api/stop`, timeout ~2s); include
  `x-opencodex-api-key: $OPENCODEX_API_AUTH_TOKEN` header when the env var is set (non-
  loopback binds require management auth — `server.ts:1456-1479`); on 200,
  `waitForExit(pid, shutdownTimeout+2000)`. Return boolean. Fallback: existing
  `killProxy(pid)`.
- Audited call graph (corrections from A):
  - `handleStop()` is sync at `cli.ts:245`, called without await at `cli.ts:388` → make
    async, `await handleStop()` in the dispatch case.
  - `serviceCommand(args[1])` called at `cli.ts:461`, sync at `service.ts:584` → make
    async + await at call site.
  - `handleUninstall` does NOT go through `handleStop`; it has its own
    `killProxy(pid)` runStep at `cli.ts:285-290` → extend `runStep` to accept
    `() => void | boolean | Promise<void | boolean>` (handleUninstall is already async)
    and use graceful-first there too.
  - `stopTrackedProxyIfRunning()` (`service.ts:492`) becomes async; propagate through
    `stopTrackedProxyForServiceCommand` and `serviceCommand`.
- `/api/stop` handler already restores + drains + exits; `restoreNativeCodex()` retries
  after are idempotent (verified: `cli.ts:264`, `serviceCommand stop`). Loopback CLI POST
  passes `isTrustedLocalRequest` origin checks (`server.ts:1370-1470`).

**MODIFY `src/codex-inject.ts`** (F4)
- `providerBaseHost()`: loopback/unspecified → `"127.0.0.1"`; exactly `::1`/`[::1]` →
  `"[::1]"`; `0.0.0.0`/`::` (wildcard binds) → `"127.0.0.1"`. Non-loopback unchanged.

**MODIFY `src/open-url.ts`** (F6)
- Attach `child.on("error", () => {})` before `unref()`.

**MODIFY `src/update.ts`** (F7)
- `latestVersion()`/`runUpdate()`: on win32 use `npm.cmd` + `shell:true` (shared tiny
  helper `npmInvocation()` in update.ts).

### Tests (all runnable on macOS via bun test)

- `tests/service.test.ts` (extend): windows script contains `chcp 65001`, no `timeout /t`,
  has `ping -n 6`; env-indirection applied when env vars set (inject fake
  `APPDATA`/`USERPROFILE` via helper's env param).
- `tests/codex-shim.test.ts` (extend): cmd shim uses `%USERPROFILE%`-style prefixes for
  profile-relative paths; ps1 content BOM-prefixed at write.
- `tests/codex-inject.test.ts` (update): `base_url` expectations `localhost` →
  `127.0.0.1` at `:32-36` (wildcard binds), `:114-120` (fallback profiles), `:144-151`
  (fixture); new `::1` case. Codex-side risk cleared: `docs/codex-path-investigation.md:328-330`
  shows a working `127.0.0.1` base_url; no in-repo evidence of localhost-only validation.
- `tests/service.test.ts:293-305` (source-scan of service.ts): update for async
  `stopTrackedProxyIfRunning` signature + graceful-first call.
- `tests/uninstall.test.ts:38-49`: update `killProxy(pid);` assertion to the new
  graceful-first call while KEEPING the ordering assertions (stop < remove < restore).
- Existing exact-string builder assertions (`tests/service.test.ts:184-221`,
  `tests/codex-shim.test.ts:21-44`) use non-profile fixture paths and macOS lacks
  `APPDATA`/`USERPROFILE`, so env-indirection no-ops there — verify unchanged in C; the
  helper takes an explicit env map so new tests inject fake prefixes deterministically.
- NEW `tests/win-paths.test.ts`: longest-prefix selection, case-insensitive drive/letter
  compare, non-matching paths pass through, no partial-component match
  (`C:\Users\junk` ≠ `C:\Users\jun`).
- NEW `tests/process-control-graceful.test.ts`: `stopProxyGracefully` with injected fetch +
  runtime-port reader (dependency-injected); asserts API-first ordering and fallback.
- NEW `tests/ocx-launcher-source.test.ts`: source-scan regression — npm spawnSync sites in
  `bin/ocx.mjs` carry `shell:`; guards F1 from regressing (launcher is not importable).

### Verification gate (C)
`bun x tsc --noEmit` + full `bun test ./tests/` (baseline: 1237 pass / 0 fail).

### Risks / audit questions (A)
1. Does Codex accept `http://127.0.0.1:<port>/v1` base_url (any localhost-only special-casing
   in Codex config validation)? (F4)
2. `chcp 65001` + UTF-8 batch: confirmed-safe pattern for ASCII-labeled scripts; verify no
   `%DATE%`-related parsing edge. (F2)
3. `shell:true` on Windows joins args — verify no user-controlled values enter those argv
   arrays (`--tag` value is argv-forwarded: validate/allowlist before join). (F1/F7)
4. handleStop async conversion: confirm all call sites await it. (F3)
