# 110 — Dynamic system-wide env injection for Claude Code

When `ocx start` runs, inject `ANTHROPIC_BASE_URL`, `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`,
and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` into the macOS user domain via `launchctl setenv`.
New terminal windows / GUI-launched processes inherit them automatically — `claude` routes
through the proxy without `ocx claude`.

On `ocx stop`, Ctrl+C, SIGTERM, or process exit: revert via `launchctl unsetenv`.

## Plan

### File change map

| File | Change |
|------|--------|
| `src/server/system-env.ts` | NEW — `injectSystemEnv(port)`, `revertSystemEnv()`, `cleanStaleSystemEnv()` |
| `src/cli/index.ts` | Wire inject after server start, revert in `syncCleanup` |
| `src/types.ts` | Add `claudeCode.systemEnv?: boolean` to `OcxConfig` |
| `tests/system-env.test.ts` | NEW — unit tests for inject/revert/stale/toggle |
| `gui/src/…` | Claude tab: systemEnv toggle |
| `docs/…` | en/ko/zh-cn system-env section |

### Architecture

```
ocx start
  └─ startServer(port)
  └─ injectSystemEnv(port, config)   ← NEW
       ├─ cleanStaleSystemEnv()      ← health-check existing value
       └─ launchctl setenv × 3
  └─ …existing lifecycle…

shutdown / Ctrl+C / SIGTERM
  └─ syncCleanup()
       └─ revertSystemEnv()          ← NEW
            └─ launchctl unsetenv × 3
```

### Scope boundary

- IN: macOS `launchctl setenv`/`unsetenv`, config toggle, tests, GUI, docs
- OUT: Windows registry, Linux /etc/environment, shell-hook (.zshrc injection)

### Implementation details

1. **`src/server/system-env.ts`**
   - `injectSystemEnv(port: number, config: OcxConfig)`:
     - Guard: `process.platform !== "darwin"` → no-op with log
     - Guard: `config.claudeCode?.systemEnv === false` → no-op
     - Guard: `config.claudeCode?.enabled === false` → no-op
     - `cleanStaleSystemEnv()` first
     - `execSync("launchctl setenv ANTHROPIC_BASE_URL http://127.0.0.1:{port}")`
     - `execSync("launchctl setenv _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL 1")`
     - `execSync("launchctl setenv CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY 1")`
   - `revertSystemEnv()`:
     - Guard: `process.platform !== "darwin"` → no-op
     - `execSync("launchctl unsetenv ANTHROPIC_BASE_URL")`
     - `execSync("launchctl unsetenv _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL")`
     - `execSync("launchctl unsetenv CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY")`
     - All wrapped in try/catch (best-effort on crash path)
   - `cleanStaleSystemEnv()`:
     - Read current `launchctl getenv ANTHROPIC_BASE_URL`
     - If it points to `http://127.0.0.1:*`, check that port is alive
     - If dead → `launchctl unsetenv` all 3

2. **`src/cli/index.ts` integration**
   - After `startServer(port)` succeeds: call `injectSystemEnv(port, config)`
   - In `syncCleanup()`: call `revertSystemEnv()` before removePid
   - In `handleStop()`: call `revertSystemEnv()` after stopProxy

3. **Config toggle** — `claudeCode.systemEnv` defaults to true when `claudeCode.enabled`
   is not false. GUI Claude tab gets a toggle row.

4. **Tests** — mock `execSync` to verify correct launchctl commands without side effects.

### Accept criteria

- C1: New terminals inherit env vars after `ocx start`
- C2: Env vars gone after `ocx stop` / Ctrl+C
- C3: Stale value cleaned on startup
- C4: `claudeCode.systemEnv: false` skips injection
- C5: Tests pass
- C6: All gates clean (tsc, test, gui build, docs build)

## Verification

NEEDS_HUMAN: manual `ocx start` + new terminal + `launchctl getenv` check

## Audit Round 1 — FAIL (6 blockers)

Reviewer: Hegel (sol). Evidence: `.codexclaw/evidence/260711-system-env-plan-audit.md`.

### Blocker synthesis + amendments

1. **Terminal inheritance caveat**: `launchctl setenv` only applies to NEW launchd children.
   Already-open terminals don't pick it up. New Terminal.app windows/tabs DO because
   Terminal.app spawns a new login shell per window which inherits from launchd.
   **Amendment**: C1 text changed to "new terminal windows/tabs" with caveat documented.

2. **Pre-existing value overwrite**: If user already has `ANTHROPIC_BASE_URL` (Bedrock, etc),
   we'd clobber it and then delete it on stop.
   **Amendment**: ownership-checked inject/revert:
   - `injectSystemEnv` reads current `launchctl getenv` value first. If non-empty and
     doesn't match our pattern (`http://127.0.0.1:<port>`), skip with a log warning.
   - `revertSystemEnv` only unsets if current value matches the port we injected.
   - Track injected port in a file: `~/.opencodex/system-env-port` (written on inject,
     deleted on revert).

3. **Concurrent instance conflict**: Two `ocx start` on different ports.
   **Amendment**: `system-env-port` file includes PID. Only the owning PID reverts.
   On inject, if another instance already owns it, skip with warning.

4. **Authenticated proxy admission**: When `config.apiKeys` has entries, plain `claude`
   needs `ANTHROPIC_AUTH_TOKEN` too.
   **Amendment**: conditionally inject `ANTHROPIC_AUTH_TOKEN` when apiKeys configured.
   Revert it on stop.

5. **Management API boundary**: `systemEnv` toggle missing from `/api/claude-code` endpoints.
   **Amendment**: add `systemEnv` to management-api.ts GET/PUT + corresponding test.
   Added to file change map.

6. **Injection timing**: inject before signal handlers = crash leaves stale state.
   **Amendment**: move `injectSystemEnv()` call AFTER `process.on("SIGINT/SIGTERM/…")`
   and `process.on("exit", syncCleanup)` registration.

### Amended file change map

| File | Change |
|------|--------|
| `src/server/system-env.ts` | NEW — inject/revert/clean with ownership tracking |
| `src/cli/index.ts` | Wire inject AFTER signal handlers, revert in syncCleanup + handleStop |
| `src/types.ts` | Add `claudeCode.systemEnv?: boolean` |
| `src/server/management-api.ts` | Expose systemEnv in GET/PUT `/api/claude-code` |
| `tests/system-env.test.ts` | NEW — inject/revert/stale/toggle/ownership tests |
| `tests/claude-management-api.test.ts` | Add systemEnv round-trip test |
| `gui/src/pages/ClaudeCode.tsx` | systemEnv toggle row |
| `docs/…` | en/ko/zh-cn system-env section with caveats |
