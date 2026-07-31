# 80.10 — Windows Stability Hypothesis After macOS Baseline

## Premise

macOS has been stable under the same opencodex usage pattern, while Windows users report frequent interruptions during use. That strongly suggests the fault is not ordinary provider routing logic or config injection alone. The likely boundary is where Windows differs from macOS:

- Bun runtime behavior on Windows;
- long-lived SSE/WebSocket connection lifetime under Bun;
- Task Scheduler service semantics versus launchd;
- Windows process/PID inspection and cleanup;
- missing Windows service logs that make all failures look like "the proxy stopped".

## Why the previous 929d756 patch is not enough

Commit `929d756` fixes explicit service lifecycle cleanup:

```text
ocx service stop/uninstall
  -> stop Task Scheduler wrapper
  -> kill tracked proxy PID via taskkill /T /F
  -> restore/delete
```

That is necessary for uninstall/stop correctness, but it only runs when the user explicitly stops or uninstalls the service. It does not affect spontaneous runtime interruptions while a request is streaming or while Codex is connected.

## Current strongest theory

The most plausible Windows-only failure model is a stack of three issues:

1. Long-lived `/v1/responses` SSE/WebSocket sessions can go quiet and hit Bun/server idle behavior.
2. Bun 1.3.x Windows has enough stream/runtime crash risk to treat native termination as credible.
3. Task Scheduler is configured as a simple logon task, not a hardened always-on service, so process exits are not logged or recovered in a way users can distinguish.

In other words:

```text
macOS launchd + stable Bun behavior
  -> proxy appears stable

Windows Bun/stream timeout/crash + weak Task Scheduler observability/restart
  -> user sees frequent "proxy stopped" or disconnected sessions
```

## Evidence gathered

- GPT Pro review `01KW43HHFMK6MC8N31M0E6GDAJ` concluded `929d756` is necessary but not sufficient.
- `src/server.ts` sets Bun `idleTimeout: 255` and has WebSocket upgrade paths without explicit WebSocket idle policy.
- `src/service.ts` Windows service generation is a `.cmd` loop plus bare `schtasks /create` flags.
- `src/config.ts` PID validation depends on command-line inspection that can be brittle on Windows.
- Windows service wrapper lacks timestamped child start/exit/restart logs, so runtime crash, timeout disconnect, Task Scheduler stop, and explicit stop are hard to separate.

## Investigation target for 80.10+

Do not treat this as a single bug. Split the next work into patchable, testable layers:

1. Data-plane lifetime: prevent quiet SSE/WebSocket sessions from being closed by server idle policy.
2. Service hardening: make Task Scheduler behave like an always-on service and produce logs.
3. Runtime diagnostics: record Bun path/version and allow a Windows runtime override.
4. PID cleanup robustness: separate strict identity checks from explicit best-effort stop/uninstall cleanup.
5. Dev UX: make clone/dev GUI behavior explicit so `/` confusion does not mask real proxy health.
