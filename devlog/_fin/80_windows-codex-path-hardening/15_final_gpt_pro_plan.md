# 80.15 — Final GPT Pro / Web-Search-Backed Windows Plan

## Session

- Conversation: https://chatgpt.com/c/6a3f8b7a-77dc-83e8-bb3e-2c030b486539
- Final review session: `01KW4A08FZ4B5P9W7M5ECKBG6D`
- Input package: `/tmp/opencodex-windows-80-final-review-260627/opencodex-windows-80-final-review.zip`
- Review mode: ChatGPT Pro Extended, requested web search for Bun server timeout/WebSocket behavior, Bun Windows stream crash reports, and Microsoft Task Scheduler semantics.

## Bottom line

The 80.10 hypothesis is validated with one correction.

Validated:

- macOS stability makes provider routing/config injection less likely as the primary failure.
- Windows instability is plausibly a combination of:
  - Bun stream/runtime lifetime behavior;
  - long-lived SSE/WebSocket idle closure;
  - weak Windows service recovery/observability;
  - missing runtime/service logs.

Correction:

- Task Scheduler itself is probably not the primary cause of "very frequent" stops.
- Its default 72-hour execution limit is not a minute-scale interruption cause.
- Task Scheduler hardening remains release-blocking because it improves recovery and evidence, not because it is likely the initiating failure.

## Final root-cause stack

1. Data-plane idle/lifetime closure
   - `/v1/responses` SSE and WebSocket sessions can go quiet.
   - Current server has finite `idleTimeout: 255` and no evident per-request timeout override.
   - Bun docs support disabling per-request timeout for quiet SSE via `server.timeout(req, 0)`.

2. Bun 1.3.14 Windows stream/runtime crash risk
   - Current package pins Bun 1.3.14.
   - GPT Pro found a directly relevant Windows 11/opencodex Bun 1.3.14 native segfault report.
   - Related Bun stream issues involve async `ReadableStream` and abort/close races.

3. Weak Windows service wrapper/logging
   - `.cmd` wrapper + bare `schtasks /create /sc onlogon /rl highest /f` is not enough as a robust service contract.
   - Missing logs make users report every class of failure as "the proxy stopped".

## Important correction to the plan

80.11 must include a stream-wrapper audit.

Current code comments say passthrough SSE uses native relay to avoid a Bun Windows streaming crash class, but the response can still be wrapped by `trackStreamLifetime(...)`, which creates an async `ReadableStream` pull loop. GPT Pro flagged that this may undermine the intended native relay workaround.

Therefore 80.11 is not only timeout settings. It must also audit/avoid async-pull stream wrappers on Windows hot paths where native relay is intended.

## Final patch order

### Patch 1 — Windows data-plane lifetime hardening

Classification: release-blocking.

Implement:

- Change Bun server fetch wiring so `/v1/responses` can call a request timeout override before parsing/awaiting upstream.
- For `/v1/responses` POST, call `server.timeout(req, 0)` or the current Bun-supported equivalent.
- Do not rely on heartbeats alone for Bun idle protection.
- Configure WebSocket idle policy explicitly.
- Prefer tested application heartbeat/keepalive over assuming `idleTimeout: 0` is sufficient.
- Audit passthrough SSE native relay path and avoid async-pull `ReadableStream` wrappers where the native relay workaround is intended.
- Add request/transport close logging for `/v1/responses`: request id, stream start, first byte, heartbeat, client abort, upstream abort, terminal event, and close reason where available.

Tests:

- Slow SSE test where upstream sends a later chunk after a deliberately small timeout.
- WebSocket idle/heartbeat policy test.
- Static regression test that the passthrough native relay path is not wrapped in an async-pull `ReadableStream`.
- Existing websocket/passthrough/bridge/server-auth tests remain green.

### Patch 2 — Windows service logging + runtime identity

Classification: release-blocking.

Implement:

- Log service wrapper start.
- Log child start, child exit code, restart decision.
- Log Bun path, Bun version, opencodex version, CLI path, config dir, and `CODEX_HOME`.
- Surface service log path in `ocx service status`.
- Capture child stdout/stderr into the same service log or clearly linked log files.

Tests:

- Static wrapper-script test for required log lines.
- Runtime resolver test for Bun path/version fields.

### Patch 3 — Windows Task Scheduler hardening

Classification: release-blocking for Windows hotfix, but not the likely root cause.

Implement:

- Generate XML or PowerShell task definition instead of only bare `schtasks /create` flags.
- Set `ExecutionTimeLimit` to `PT0S`.
- Set restart interval/count together.
- Set battery behavior explicitly.
- Set multiple-instance policy explicitly.
- Preserve intentional stop semantics: `ocx service stop` must stop the wrapper first, then kill the tracked child, and must not immediately resurrect it.

Nuance:

- `StartWhenAvailable` is low-value for a pure logon task; include only if harmless, not as a core reliability guarantee.
- Scheduler restart restarts the scheduled task/wrapper, not necessarily the Bun child if the wrapper is still alive. Keep wrapper-level restart/logging.

Tests:

- Static XML/settings assertions.
- Manual Windows smoke: install, inspect task, kill only Bun child, confirm wrapper restart/log, then `ocx service stop` and verify no child remains.

### Patch 4 — Bun mitigation path

Classification: strongly recommended; include if possible.

Implement:

- Add validated `OPENCODEX_BUN_PATH` or equivalent config field.
- Log whether bundled Bun or override Bun is used.
- Reject invalid override paths loudly.
- Do not auto-switch all users to canary/stable without Windows smoke validation.

Tests:

- Valid override.
- Invalid override.
- Default bundled path.
- Service script uses selected Bun path.

### Patch 5 — PID cleanup robustness

Classification: strongly recommended.

Implement:

- Keep strict PID identity checks for status/reporting.
- For explicit stop/uninstall, if PID file exists but Windows command-line inspection fails, attempt safe best-effort cleanup and log the uncertainty.

Tests:

- PID file exists + inspection timeout still attempts cleanup.
- Dead PID remains harmless.
- Existing service/uninstall lifecycle tests stay green.

### Patch 6 — Clone GUI development experience

Classification: docs/dev-experience.

Implement:

- Keep `bun run dev` as backend proxy.
- Add `dev:proxy` and `dev:gui` aliases.
- Document three modes:
  - backend-only `/healthz`;
  - built dashboard via `bun run build:gui`;
  - live Vite GUI dev.
- Make startup banner conditional:
  - GUI built -> `GET / -> GUI dashboard`;
  - GUI missing -> setup/fallback guidance.
- Expand `rootFallbackPayload()` with exact clone commands.
- Replace generic `gui/README.md` with OpenCodex-specific instructions.

Tests:

- `GET /` without `gui/dist` returns setup JSON.
- Banner helper distinguishes built GUI vs missing GUI.
- README commands match root scripts.

## Execution recommendation

For the next hotfix branch, do Patch 1 first. In the same branch or immediately after, add Patch 2 minimum logging/runtime identity so every future Windows report contains usable evidence.

Then do Patch 3 task hardening. Patch 4 and 5 can follow if the hotfix budget allows, but Patch 4 should be included before making any claim that Bun runtime crashes are addressed.

Patch 6 is low-risk and can ship with the hotfix, but it should not be described as fixing Windows stopping.
