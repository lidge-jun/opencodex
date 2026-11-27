---
title: StepCode CLI (subscription)
description: Route Codex requests through the StepCode CLI with a Step Plan subscription.
---

OpenCodex can spend a Step Plan subscription through StepCode's own harness instead of calling
`api.stepfun.com/step_plan` directly. The `step-cli` preset runs the official StepCode CLI
(`step --sdk-stdio`) and declares your request's tools to it, so no tool ever executes inside
StepCode:

```json
{
  "providers": {
    "step-cli": {
      "adapter": "step-cli",
      "baseUrl": "https://api.stepfun.com/step_plan"
    }
  }
}
```

- **Prerequisites:** install the StepCode CLI (it self-installs to `~/.stepcode/bin/step`) and sign
  in once with `step login`. The CLI resolves its own credential from its `auth.json`.
- **No credential stored:** this row holds no Step API key, and OpenCodex never reads, copies or
  forwards a Step token. It is a keyless key row (`keyOptional`) for the same reason the
  `claude-cli` preset is. Use `stepfun` if you want direct API billing instead.
- **One sign-in serves the whole proxy:** the CLI reads the Step Plan login of the user OpenCodex
  runs as, so every request routed through this row spends that one account. Step Plan is
  prompt-metered with a five-hour and a weekly limit, and a Codex session's traffic spends the same
  quota your interactive `step` sessions do.
- **Tools stay with the client:** the request's tool catalog is declared to StepCode as SDK tools,
  and a call comes back over stdio as a reverse request the adapter captures. Approval and execution
  stay in your client; OpenCodex stages no MCP server and holds no tool results itself.
- **One process per conversation:** StepCode carries conversation context only inside its own
  process — its input channel reduces every message to text and images — so a conversation maps onto
  one long-lived process that OpenCodex keys to your authenticated caller identity, provider and
  thread. Keyless callers receive a separate process per request and cannot continue tool calls
  across requests. Keep the tool catalog unchanged when returning a held result. A process that dies is reported,
  not silently restarted, because tool results already delivered cannot be replayed through this
  route.
- **Graceful stop** waits for StepCode process cleanup within the proxy's shutdown window and
  reports a shutdown failure if it cannot confirm cleanup. On macOS and Linux, this can happen
  if the process group leader exits before group termination. Descendants may still be running.
  On POSIX, cleanup signals the group only while the original leader is observed alive. Bun 1.4.4
  can reap the child before JavaScript receives the exit event. On Linux, the native waiter thread
  is a fallback when pidfd monitoring is unavailable. A group signal between reap and exit
  notification could reach a reused PGID. Bun exposes no `pidfd` or other syscall-level ownership
  handle to JavaScript. Closing this window requires a native supervisor or a Bun change. The owner
  accepted this residual risk on 2026-11-19.
  On Windows, StepCode checks that the original wrapper is still alive before launching
  `taskkill /T /F`. The helper resolves the numeric PID after launch. If the wrapper exits and
  Windows reuses its PID between the liveness check and that lookup, the signal could reach an
  unrelated process tree. Closing this window requires establishing ownership at launch, for
  example with a kill-on-close Job Object, and terminating through that handle. The owner
  accepted this residual risk on 2026-11-19 alongside the POSIX reap-ordering risk.
  If the wrapper has already exited or cleanup is unconfirmed after the helper may have run,
  OpenCodex quarantines the session, logs a fixed warning and reports incomplete cleanup.
- **Conversation capacity:** A proxy can keep eight StepCode sessions per OpenCodex home. When all
  slots are occupied, existing conversations can continue. A new one receives `step_cli_pool_full`
  and can retry after a slot frees up. Idle sessions still count until
  cleanup after the ten-minute idle timeout completes.
- **Two documented limits:** a tool that takes longer than two minutes to come back exceeds the
  CLI's own tool-result window and the turn reports `step_cli_tool_result_too_late`; and the CLI's
  session system prompt cannot be replaced through this protocol, so your instructions are prepended
  to the turn rather than installed as the system prompt.
- **Tool-catalog ceiling:** this row shares the CLI family's **128-tool / 2 MiB** limit. A real Codex
  client can exceed it, because Codex flattens every MCP server's tools into the function catalog —
  measured on Codex 0.162.0 at 1749 tools / 2.5 MB. The turn is refused rather than silently trimmed
  (a tool the client thinks exists but that never reaches the model is worse), and the error names both
  numbers. A stock Codex install without MCP servers carries roughly ten built-in tools and works; if you
  hit the ceiling, disable or narrow MCP servers for this provider. `qoder`, `codebuddy` and
  `claude-cli` enforce the same bound.
- **Input media:** the row publishes text-only models. `step-5-preview` and `step-3.7-flash` accept
  images upstream, but no headless StepCode turn has been shown to hand image bytes to the model, so
  an image sent straight to this provider is refused (`unsupported_input_modality`). With the vision
  sidecar on the request path images are captioned into text first.
- **Verify:** `ocx provider test step-cli`.

> **Terms:** this preset spends your Step Plan subscription through StepCode's own CLI. Step's
> Step Plan documentation lists third-party coding tools against the same endpoints, and
> `--sdk-stdio` is StepCode's published, MIT-licensed external-client surface, but whether driving
> that harness from a proxy fits your plan's terms is a question between you and 阶跃星辰.
> OpenCodex does not convert the login into an API key.
