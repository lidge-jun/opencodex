# GPT Pro follow-up review for dev commit 3fe1286

Session: 01KW4RM1V6T5HRWYD27BAS1JQB
Conversation: https://chatgpt.com/c/6a3f8b7a-77dc-83e8-bb3e-2c030b486539?mweb_fallback=1
Submitted package: /tmp/opencodex-gptpro-review-20260627.zip
Branch pushed before review: dev
Commit reviewed: 3fe12867e350c181343447c10f6a458eeb718f44

## Verdict

Meaningful partial hardening, but do not close the Windows frequent proxy interruption report as fixed yet.

The `/v1/responses` timeout disable is a correct first fix. However, GPT Pro still classifies the series as incomplete because the passthrough SSE path is not truly native relay and the Windows Task Scheduler hardening still uses `schtasks` flags instead of XML/settings semantics.

## Release-blocking findings

### P0 - Passthrough SSE is still not truly native relay

GPT Pro says the client-facing passthrough SSE path still goes through `relaySseWithHeartbeat(nativeBody, ...)`, whose helper creates `new ReadableStream({ async pull(...) { await reader.read() ... } })`. It also says `responseWithDeferredRequestLog()` wraps `text/event-stream` responses through `trackSseForRequestLog(...)` after `handleResponses()` returns.

Risk: this remains a credible Windows Bun crash/abort root cause, especially with client aborts and reconnects.

Minimal next patch:
- Make OpenAI/ChatGPT passthrough SSE client-facing body avoid async-pull JS wrappers.
- Use a tee'd side-channel inspection branch for terminal/quota/request-log classification.
- Bypass `responseWithDeferredRequestLog()` body wrapping for a marked native passthrough response.
- Add shape/regression tests proving passthrough SSE does not pass through `relaySseWithHeartbeat`, `trackStreamLifetime`, or `trackSseForRequestLog` on the client-facing branch.

### P1 - Task Scheduler hardening did not meet the planned settings model

GPT Pro says `/du 9999:59` is the wrong mechanism for an ONLOGON task and does not implement the planned service-like scheduler semantics.

Minimal next patch:
- Generate Task Scheduler XML and create with `schtasks /create /xml <file> /tn <task> /f`.
- Include `ExecutionTimeLimit=PT0S`, explicit multiple-instance policy, battery behavior, and `RestartOnFailure` count/interval.
- Keep limited privilege if service works without elevation.
- Add static XML tests and Windows smoke guidance.

### P1 - WebSocket lifetime remains implicit

GPT Pro says Bun WebSockets default idle behavior can close quiet connections unless `websocket.idleTimeout` or heartbeat policy is explicit.

Minimal next patch:
- Set explicit WebSocket idle/heartbeat policy.
- Add a test for quiet WebSocket lifetime beyond the configured threshold.

### P1 - Bun runtime mitigation is only half done

GPT Pro says runtime path diagnostics help, but users still lack a supported `OPENCODEX_BUN_PATH` override to test canary/fixed Bun without editing generated service files.

Minimal next patch:
- Add validated `OPENCODEX_BUN_PATH` override shared by CLI launcher and service installation.
- Log `bun --version` and opencodex version in service log/status.

## P2 findings

- Service logging/status improved, but version identity is missing.
- PID cleanup is still strict when Windows process command-line inspection is inconclusive; explicit stop/uninstall should attempt logged best-effort cleanup when a pid file exists but identity check is inconclusive.
- Source checkout docs are mostly fixed, but startup banner still always advertises `GET / -> GUI dashboard`, package scripts lack `dev:proxy`/`dev:gui`, and `gui/README.md` is still generic Vite text.

## Recommended next sequence

1. Patch passthrough SSE stream shape first.
2. Patch Task Scheduler XML/settings second.
3. Patch WebSocket lifetime policy.
4. Patch Bun runtime override/version logging.
5. Patch docs/dev polish: conditional banner, `dev:proxy`/`dev:gui`, project-specific `gui/README.md`.
