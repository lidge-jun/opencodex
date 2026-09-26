---
title: Advisor
description: The OpenCodex-owned expert consultation sidecar — a configured expert model advises routed workers, with manual and preflight policies.
---

The advisor is an independent expert model that reviews the worker's task and returns advice.
OpenCodex owns the consultation end to end: the proxy injects a synthetic `advisor` tool into the
worker's turn, executes the consultation itself through the normal routing authority, and
reinjects the advice so the original worker continues. The worker never delegates, spawns
anything, or carries provider credentials.

This is distinct from the subagent surface (see
[Agent configuration](/reference/configuration/agents/)): subagents are worker-initiated
delegation through Codex's collaboration tools. The advisor is a proxy-side sidecar the client
never sees — even a worker that never spawns anything can be advised.

## Configuration

```json
{
  "advisor": {
    "enabled": true,
    "model": "gpt-6-astra",
    "effort": "max",
    "policy": "preflight"
  }
}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Master switch. Disabled means zero advisor behavior on the request path. |
| `model?` | `string` | — | The expert model. Any model string the router accepts: a bare native model (`gpt-6-astra`), an explicit `provider/model` (`anthropic/claude-sonnet-4-6`, `xai/grok-...`), or an account-qualified native model. Cross-provider is fully supported: the worker and the advisor do not need to share a provider. |
| `effort?` | `string` | `"max"` | Reasoning effort for the advisor call (`low` through `ultra`). |
| `policy?` | `"manual" \| "preflight"` | `"manual"` | When the advisor is consulted. |
| `timeoutMs?` | `number` | `120000` | Loopback consultation timeout. |

Manage it with the dashboard **Advisor** page or
`ocx advisor status|on|off|set --model <model> --effort <effort> --policy <manual|preflight>`.

## Policies

- **`manual`** — only an explicit worker call to the synthetic `advisor` tool consults. The call
  is intercepted by the proxy, never shown to the client, and never executed as a local tool.
- **`preflight`** — OpenCodex additionally guarantees at least one consultation per task. After
  the worker has produced its first orientation evidence (at least one tool result since the
  latest user message), the proxy consults the advisor and injects the advice before the worker's
  next turn — even if the worker never calls the tool. The trigger is a deterministic,
  documented approximation, not a semantic "model is stuck" detector.

## What the advisor sees

The consultation payload is built from the parsed conversation the worker model is already
allowed to see: the user task, the conversation, tool calls and their results, the worker's tool
catalog, and both model identities. The advisor returns prose advice, re-injected as identifiable
`<opencodex_advisor>`-wrapped content with no system authority. Chain-of-thought is never
transferred, encrypted provider content is never decrypted, and no credentials or environment
secrets ride the payload.

## Cost and accounting

Every consultation is a real additional model call. It appears in usage under the **advisor
model** — never merged into the worker's token counts — and each consultation writes an
`[advisor]` log line with trigger, duration, status, and usage, so an advisor call is always
provable from the logs.

## Failure behavior

The advisor fails open: if the expert model is unavailable, misconfigured, or times out, the
worker receives a short, non-misleading "advisor unavailable" context (or nothing, for preflight)
and continues the task. An advisor failure never fails the coding request, and a consultation
never switches the session's main model.

## PR1 limitations

- Native OpenAI passthrough turns (ChatGPT-pool workers) do not get the synthetic tool; advisor
  support covers routed (translated) providers. Preflight consultation applies to run-turn
  adapters; the tool does not.
- No adaptive trigger: no stuck detection, repeated-failure analysis, escalation tiers, multiple
  advisors, or advisor voting. `manual` and `preflight` are the only policies.
- The preflight dedup ledger is process-local; after a proxy restart, a task in progress may
  receive one more preflight consultation.
