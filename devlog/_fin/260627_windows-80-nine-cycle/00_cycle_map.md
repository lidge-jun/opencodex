# 260627 Windows 80 Nine-Cycle PABCD Map

## Objective

Execute at least nine small, independently verifiable PABCD work-phases on `dev` to turn the Windows 80 stability plan into shippable hardening patches. Each cycle must produce documentation evidence, implementation evidence, and verification evidence. Source-changing cycles must commit atomically.

## Current Baseline

- Branch: `dev`
- Current local status at planning time: ahead of `origin/dev` with existing hotfix/docs commits.
- Existing plan source: `devlog/80_windows-codex-path-hardening/15_final_gpt_pro_plan.md`
- Existing phase docs: `20_data_plane_lifetime_pabcd.md` through `70_cli_currentization_pabcd.md`
- Known constraints:
  - Do not resurrect Cursor provider work in this goal.
  - Preserve ChatGPT forward/pool auth behavior.
  - Keep Windows changes testable from macOS/Linux through static and unit tests.
  - Do not push/reset/force without explicit user approval.

## Nine Work-Phase Slices

### Cycle 0 — Durable Slice Map and Baseline Audit

Purpose: establish this map and verify the repository baseline before code changes.

Expected files:

- NEW `devlog/_plan/260627_windows-80-nine-cycle/00_cycle_map.md`
- Optional NEW `devlog/_plan/260627_windows-80-nine-cycle/01_baseline_audit.md`

Verification:

```bash
git status --short --branch
bun test tests/oauth-status-privacy.test.ts tests/cli-help.test.ts tests/config.test.ts
bun x tsc --noEmit
```

Commit: no source commit required if devlog stays ignored; record `cli-jaw goal update` evidence.

### Cycle 1 — Responses Request Timeout Disable Hook

Purpose: make `/v1/responses` POST explicitly disable Bun request timeout without affecting `/api/*`, `/healthz`, static GUI, or `/v1/models`.

Expected files:

- MODIFY `src/server.ts`
- ADD/MODIFY focused tests, likely `tests/server-auth.test.ts` or new `tests/responses-timeout.test.ts`

Implementation notes:

- Use the Bun request-scoped server object if available in `fetch(req, server)`.
- Apply timeout override only when `url.pathname === "/v1/responses"` and request is not WebSocket upgrade.
- Wrap API usage so unsupported runtimes fail closed without throwing.

Verification:

```bash
bun test tests/server-auth.test.ts tests/bridge-lifecycle.test.ts
bun x tsc --noEmit
```

Suggested commit: `fix(windows): disable responses request timeout`

### Cycle 2 — Passthrough Native Relay Wrapper Guard

Purpose: prevent native ChatGPT/OpenAI Responses passthrough from being rewrapped by async-pull lifetime streams on the Windows hot path.

Expected files:

- MODIFY `src/server.ts`
- MODIFY `tests/passthrough-abort.test.ts` or ADD `tests/passthrough-relay-shape.test.ts`

Implementation notes:

- Audit the current `trackStreamLifetime(nativeBody, turnAc)` call on passthrough response bodies.
- Prefer direct native relay for passthrough when possible; retain abort linkage and active-turn cleanup through cancel/terminal hooks.
- Keep non-passthrough bridge streams tracked.

Verification:

```bash
bun test tests/passthrough-abort.test.ts tests/shutdown-drain.test.ts tests/server-auth.test.ts
bun x tsc --noEmit
```

Suggested commit: `fix(windows): preserve native responses passthrough relay`

### Cycle 3 — Transport Close Logging

Purpose: add token-safe lifecycle evidence for `/v1/responses` streams so Windows interruption reports can identify where the close happened.

Expected files:

- MODIFY `src/server.ts`
- MODIFY `src/bridge.ts` only if bridge terminal reporting needs richer reason propagation
- ADD/MODIFY `tests/request-log.test.ts` or new lifecycle logging test

Implementation notes:

- Log request id, provider, model, stream start, first upstream byte if available, terminal status, client abort, upstream abort, and close classification.
- Do not log prompt content, tool arguments, API keys, tokens, or Authorization headers.

Verification:

```bash
bun test tests/request-log.test.ts tests/bridge-lifecycle.test.ts tests/passthrough-abort.test.ts
bun x tsc --noEmit
```

Suggested commit: `fix(windows): log responses transport lifecycle`

### Cycle 4 — Windows Service Log Path and Wrapper Start Evidence

Purpose: make Task Scheduler service launches leave durable start/runtime identity logs.

Expected files:

- MODIFY `src/service.ts`
- MODIFY `tests/service.test.ts`

Implementation notes:

- Add deterministic Windows service log path helper.
- Generated wrapper logs timestamp, Bun path, CLI path, config dir, CODEX_HOME, and child command before launch.
- Keep output token-safe.

Verification:

```bash
bun test tests/service.test.ts
bun x tsc --noEmit
```

Suggested commit: `fix(windows): log service wrapper startup`

### Cycle 5 — Windows Child Exit and Status Diagnostics

Purpose: capture child exit/restart decisions and expose the service log path in `ocx service status` / `ocx status`.

Expected files:

- MODIFY `src/service.ts`
- MODIFY `src/cli.ts` if top-level status needs service log path
- MODIFY `tests/service.test.ts`
- MODIFY `tests/cli-help.test.ts` if status output changes

Implementation notes:

- Capture child stdout/stderr or append child exit code to the service log.
- `ocx service status` should show log path without requiring admin-only commands.

Verification:

```bash
bun test tests/service.test.ts tests/cli-help.test.ts
bun x tsc --noEmit
```

Suggested commit: `fix(windows): expose service diagnostics`

### Cycle 6 — Task Scheduler XML Settings Hardening

Purpose: replace bare scheduler flags with explicit Windows task settings for execution limit, restart, battery behavior, and instance policy.

Expected files:

- MODIFY `src/service.ts`
- MODIFY `tests/service.test.ts`

Implementation notes:

- Generate XML or a PowerShell task definition if less brittle than `schtasks /create` flags.
- Set `ExecutionTimeLimit` to `PT0S`.
- Set restart interval/count together.
- Preserve intentional `ocx service stop` semantics: stop must not immediately resurrect.

Verification:

```bash
bun test tests/service.test.ts
bun x tsc --noEmit
```

Suggested commit: `fix(windows): harden scheduled task settings`

### Cycle 7 — Bun Runtime Override and Identity

Purpose: let Windows users bypass a bad bundled Bun by setting a validated override path, while logging selected runtime identity.

Expected files:

- MODIFY `src/bun-runtime.ts`
- MODIFY `bin/ocx.mjs` if launcher override is needed before Bun starts
- MODIFY `src/service.ts`
- MODIFY `tests/bun-runtime.test.ts`
- MODIFY `tests/service.test.ts`

Implementation notes:

- Support `OPENCODEX_BUN_PATH` or a clearly named equivalent.
- Reject invalid override paths loudly.
- Log bundled vs override runtime selection.

Verification:

```bash
bun test tests/bun-runtime.test.ts tests/service.test.ts
bun x tsc --noEmit
```

Suggested commit: `fix(windows): support bun runtime override`

### Cycle 8 — PID Cleanup Robustness

Purpose: improve explicit stop/uninstall cleanup when PID identity inspection fails on Windows.

Expected files:

- MODIFY `src/process-control.ts`
- MODIFY `src/config.ts` only if PID read helpers need separation
- MODIFY `tests/process-control.test.ts`
- MODIFY `tests/service.test.ts` or `tests/uninstall.test.ts`

Implementation notes:

- Keep strict identity for status/reporting.
- For explicit stop/uninstall, if PID file exists but command-line inspection fails, attempt safe best-effort cleanup and log uncertainty.

Verification:

```bash
bun test tests/process-control.test.ts tests/service.test.ts tests/uninstall.test.ts
bun x tsc --noEmit
```

Suggested commit: `fix(windows): make explicit pid cleanup resilient`

### Cycle 9 — Clone GUI Dev Experience and CLI Currentization

Purpose: address user-facing confusion from `bun run dev` backend-only behavior and the missing/weak CLI version/status surface.

Expected files:

- MODIFY `package.json`
- MODIFY `src/cli.ts`
- MODIFY `src/server.ts` root fallback/banner helper if needed
- MODIFY `README.md`, `README.ko.md`, `README.zh-CN.md` only if public quickstart wording changes
- MODIFY `gui/README.md` if present and generic
- MODIFY `tests/cli-help.test.ts`
- ADD `tests/cli-version.test.ts` if cleaner
- ADD/MODIFY root fallback tests in `tests/server-auth.test.ts`

Implementation notes:

- Add `ocx -v`, `ocx --version`, `ocx version` with no config mutation.
- Split scripts/wording into backend proxy vs GUI dev/build.
- `GET /` without built GUI should give exact clone/dev guidance.
- Status should flag stale unsupported OAuth config safely, if not already enough after `c560b54`.

Verification:

```bash
bun test tests/cli-help.test.ts tests/server-auth.test.ts tests/oauth-status-privacy.test.ts
bun x tsc --noEmit
```

Suggested commits:

```bash
git commit -m "feat(cli): add version diagnostics"
git commit -m "docs(dev): clarify clone gui workflow"
```

## Stop Rules

After each source-changing cycle:

1. Run focused tests and typecheck.
2. Record `cli-jaw goal update` with docs, implementation, and verification evidence.
3. Commit atomically.
4. Re-enter P for the next cycle.

Do not push unless explicitly requested. Do not collapse multiple cycles into one broad commit.
