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
    "policy": "preflight",
    "contextSharingConsent": "v1"
  }
}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | Master switch. Disabled means zero advisor behavior on the request path. Enabling does not record consent. |
| `model?` | `string` | — | The expert model. Any model string the router accepts: a bare native model (`gpt-6-astra`), an explicit `provider/model` (`anthropic/claude-sonnet-4-6`, `xai/grok-...`), or an account-qualified native model. Cross-provider is fully supported: the worker and the advisor do not need to share a provider. |
| `effort?` | `string` | `"max"` | Reasoning effort for the advisor call (`low` through `ultra`). |
| `policy?` | `"manual" \| "preflight"` | `"manual"` | When the advisor is consulted. |
| `timeoutMs?` | `number` | `120000` | Loopback consultation timeout. |
| `contextSharingConsent?` | `"v1"` | absent | Operator consent to send task context to the configured Advisor provider. Only `"v1"` is current. Absent, stale, or any other value means no task context is sent. |

Manage it from the dashboard **Advisor** page (the context-sharing checkbox starts unchecked) or
with `ocx advisor status`, `ocx advisor on --ack-context-sharing`, `ocx advisor consent`,
`ocx advisor consent --revoke`, `ocx advisor off`, and
`ocx advisor set --model <model> --effort <effort> --policy <manual|preflight>`.
`ocx advisor on` without `--ack-context-sharing` does not enable cross-provider sharing when
consent is missing: it prints this disclosure and stops. `ocx advisor set` does not grant consent.

## Policies

- **`manual`** — only an explicit worker call to the synthetic `advisor` tool consults. The call
  is intercepted by the proxy, never shown to the client, and never executed as a local tool.
- **`preflight`** — OpenCodex additionally attempts one consultation per task automatically.
  When the worker has produced its first orientation evidence (an assistant tool call OR a tool
  result after the latest user message), the proxy consults the advisor and injects the advice
  before the worker's next turn — even if the worker never calls the tool. The trigger is a
  deterministic, documented approximation, not a semantic "model is stuck" detector. An
  attempted consultation that FAILS is not silently treated as advice: the task retries after
  the failure's ledger entry expires, so a temporary advisor outage does not permanently
  silence the policy.

## Consent

Task context is not sent until the operator records context-sharing consent `v1`. Consent is
versioned so a later, wider disclosure can require `v2` instead of reusing this grant. The
runtime enforces it. A missing or stale value leaves the advisor unrunnable
(`advisor_context_sharing_consent_required`) without failing the coding request. Neither model,
and no string in the task, can grant consent.

## What the advisor sees

A consultation may send:

- the latest user task
- user, assistant, and developer text visible in the parsed conversation
- tool calls and tool arguments
- tool results
- the worker tool catalog and descriptions
- the worker identity and the configured Advisor model
- an optional focus question when the worker calls `advisor()`

The configured Advisor provider may differ from the worker provider.

OpenCodex does not insert provider API keys, authorization headers, OAuth tokens, backend-only
config secrets, process environment, or hidden chain-of-thought into that prompt. It does not
decrypt or forward encrypted provider-private reasoning. **Task content is not secret-redacted.**
A key pasted into the task, a secret in a file the tools read, or a token printed by a tool or
log can be sent. OpenCodex does not run general DLP.

## Authority

Manual advice is a tool result for the `advisor` call the worker made. The result is a JSON
object. Its `advice` field is the Advisor model's text. Its `status` is set by the runtime.

Automatic preflight keeps the fixed runtime transport instruction in a developer message and
puts the quoted JSON advice in a separate **user-role advisory message**. Advisor-generated text
never enters developer/system content, including when translated OpenAI Chat maps developer
policy to system. Anthropic can carry that advisory without an invented tool call. JSON escaping
prevents structural breakout and forged fields; it cannot guarantee prompt-injection isolation.
A dedicated consultation-result protocol could distinguish advice from ordinary user input more
strongly.

Each request allows at most three consultations and four Advisor-owned worker continuations.
After consultation exhaustion the `advisor` tool is removed. A repeated call receives one final
paired limit result; if the worker calls it again, typed 502 `advisor_continuation_limit` ends the
request without another hidden worker call. The bound is shared with empty-completion retries.

Suppression does not read Advisor strings. Automatic dedup is the server-owned ledger. A
developer message, including one that copies the transport text, does not suppress preflight.

## Cost and accounting

Every consultation is a real additional model call. It appears in usage under the **advisor
model** — never merged into the worker's token counts — and each consultation writes an
`[advisor]` log line with trigger, duration, status, and usage, so an advisor call is always
provable from the logs.

## Failure behavior

The advisor fails open. A DISPATCHED consultation that fails (unavailable model, misconfigured
provider, timeout) gives the worker a short, non-misleading "advisor unavailable" notice — a
`<opencodex_advisor_unavailable>` message for preflight, an error tool result for manual — and
the task continues; only a CANCELLED consultation injects nothing, because the caller is gone.
A plan that never dispatches (advisor disabled, enabled without a model, or enabled without
current context-sharing consent) sends no preflight notice, because no consultation started.
A manual `advisor()` call without current consent returns a consent-required tool result and
sends nothing. An advisor failure never fails the coding request, and a
consultation never switches the session's main model.

## PR1 limitations

- Native OpenAI passthrough turns (ChatGPT-pool workers) do not get the synthetic tool; advisor
  support covers routed (translated) providers. Preflight consultation applies to run-turn
  adapters; the tool does not.
- No adaptive trigger: no stuck detection, repeated-failure analysis, escalation tiers, multiple
  advisors, or advisor voting. `manual` and `preflight` are the only policies.
- The preflight dedup ledger is process-local; after a proxy restart, a task in progress may
  receive one more preflight attempt.
