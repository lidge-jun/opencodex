---
title: Advisor
description: Independent expert consultation with manual, preflight and evidence-based adaptive policies.
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

On the dashboard **Advisor** page (under the **Subagents** sidebar row), choose the expert model from the catalog selector. It saves the exact catalog identifier, including native, provider, account-qualified, custom and combo selectors. Disabled models and models awaiting initial selection are not offered as new choices. A saved identifier missing from the selectable catalog remains visible with a warning and is preserved until you choose another model or clear it. Catalog loading failures preserve the selection and provide Retry. Choose a model that can return text advice: the catalog does not guarantee consultation compatibility. The CLI and API continue to accept router-supported model strings.

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
| `policy?` | `"manual" \| "preflight" \| "adaptive"` | `"manual"` | When the advisor is consulted. |
| `maxConsultationsPerTask?` | `integer` | `3` | Adaptive task allowance (1–3 attempts), including manual calls. |
| `timeoutMs?` | `number` | `120000` | Loopback consultation timeout. |
| `contextSharingConsent?` | `"v1"` | absent | Operator consent to send task context to the configured Advisor provider. Only `"v1"` is current. Absent, stale, or any other value means no task context is sent. |

Manage it from the dashboard **Advisor** page (the context-sharing checkbox starts unchecked) or
with `ocx advisor status`, `ocx advisor on --ack-context-sharing`, `ocx advisor consent`,
`ocx advisor consent --revoke`, `ocx advisor off`, and
`ocx advisor set --model <model> --effort <effort> --policy <manual|preflight|adaptive>`.
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
- **`adaptive`** — adds failed-repair consultations to the initial preflight attempt. The proxy
  must observe a completed failing validation, a subsequent successful file-edit tool result,
  and a new execution of the **same command in the same working directory** failing again.
  A passing validation clears its failure state. A check started before the edit cannot count
  as a retry after the edit. The initial and failed-repair stages have separate dedup claims.
  Only clients with a stable conversation identity receive automatic adaptive consultations.

### Adaptive budget and evidence

```sh
ocx advisor set --policy adaptive --max-consultations 2
ocx advisor activity --json
```

The adaptive task budget counts manual and automatic **attempts**, across requests and worker
model changes. The server reserves an attempt before dispatch in a private
`advisor-budget.sqlite` file in `OPENCODEX_HOME`; proxy restarts do not reset it. A task is
identified by a digest of conversation identity and the latest user-task boundary. Reservations
expire 24 hours after the first attempt, so this is a bounded task-lifetime approximation,
not a permanent session or daily monetary budget. Only digests, counts and expiry times are
stored. There is room for 512 live tasks; a full, unavailable or locked budget skips the expert
call while the worker continues. Failed or disconnected dispatched calls retain their reservation
because they may have incurred usage. Revoked consent before dispatch spends no allowance.
Clients without a stable identity keep manual, request-bounded access but receive no automatic
adaptive consultation. Legacy `manual` and `preflight` retain their previous task-dedup behavior.

The collector recognizes paired shell calls with explicit numeric exit status, including
`exec_command`, `shell_command`, `shell`, `Bash`, and terminal `write_stdin` polls. Supported
commands include common Bun/npm/pnpm/yarn test, typecheck, lint, check and build commands,
`pytest`, `python -m pytest`, `tsc`, `eslint`, `cargo test/check/clippy/build` and `go test/vet`.
File edits use successful `apply_patch`, `Write`, `Edit`, `write_file` or `edit_file` results.
Single Code Mode helpers with literal JSON arguments (bare keys accepted) are recognized;
arbitrary JavaScript, batches, shell pipelines/substitutions, shell-based edits, ambiguous
output and error prose alone provide no trigger. At most the latest 512 messages since the
latest user task are examined. Failed-repair context includes the validation, bounded first
and repeated failure excerpts, and source message references before the general transcript.

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

Consultations obey both the caller's captured API-key model scope, paid-combo consent and device
fallback limits, and the host limits of Advisor's own admission key: `OPENCODEX_API_AUTH_TOKEN` or the service token file when set and accepted by this proxy, otherwise the first configured API key. Only in that last case does key
order matter: put a key that can reach the Advisor model first, or every consultation is unavailable.
When an environment or service token is set, that token controls the consultation instead. These rules also apply to combo choices, nested
decision models and retries. A consultation that cannot satisfy them returns an unavailable
notice to the worker.

For example, a `laptop` key with `allowMeteredComboTargets: false` cannot spend on
metered combo targets through Advisor, and `fallback.devices.laptop.provider: false`
also blocks Advisor's provider fallback hops. An unkeyed loopback caller still needs
the combo's `allowMeteredTargets: true` opt-in. When both keys set `allowMeteredComboTargets: true` and the combo sets `allowMeteredTargets: true`, Advisor can use its metered targets, also through the loopback listener of a public bind. The server captures caller policy when it
authenticates the request, before waiting for body capacity or reading the body; later key or fallback edits cannot broaden that consultation.
This also covers routed vision helpers, compact requests and their decision models, and every
candidate retry within a WebSocket turn. Each new WebSocket turn captures its own policy.

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

Each request allows at most three consultations, including automatic attempts, and four Advisor-owned worker continuations.
After consultation exhaustion the `advisor` tool is removed. A repeated call receives one final
paired limit result; if the worker calls it again, typed 502 `advisor_continuation_limit` ends the
request without another hidden worker call. The bound is shared with empty-completion retries.

Fetch-based web-search turns support the same manual consultation path. The search loop intercepts
`web_search` and `advisor` calls in worker order, so enabling hosted search does not hide the
advisor tool. Search and Advisor iterations have separate allowances, and a real client tool call
still returns control to the client. Run-turn and image/video sidecar turns remain subject to their existing limitations.
Usage accounting includes each worker turn once, including the leg rejected by the Advisor continuation limit.

Suppression does not read Advisor strings. Automatic dedup is the server-owned ledger. A
developer message, including one that copies the transport text, does not suppress preflight.

## Cost and accounting

Every consultation is a real additional model call. It appears in usage under the **advisor
model** — never merged into the worker's token counts — and each consultation writes an
`[advisor]` log line with trigger, duration, status, and usage, so an advisor call is always
provable from the logs.

The **Recent advisor activity** section and `GET /api/advisor/activity` show the latest 100
consultation metadata records from this process, retained for up to 24 hours. The dashboard
refreshes them every five seconds while visible. Records include trigger, status, worker and
expert models, duration, reported input/output tokens, requested effort and adapter-mapped
effort. A budget refusal is shown as blocked. Records contain no task text, commands, advice,
thread identifiers or provider error bodies and are cleared on proxy restart.

Mapped effort describes what the adapter serialized, not a guarantee about the provider's
hidden reasoning. Unreported effort or usage stays unknown; it is never presented as zero
usage or confirmed reasoning support. No advice-adoption score or exact monetary cost is inferred.

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

## Limitations

- Native OpenAI passthrough turns (ChatGPT-pool workers) do not get the synthetic tool; advisor
  support covers routed (translated) providers. Preflight consultation applies to run-turn
  adapters; the tool does not.
- No semantic stuck detection, completion review, escalation tiers, multiple advisors or voting.
  Adaptive consultation requires the structured validation/edit/retry evidence described above.
- The preflight dedup ledger is process-local; after a proxy restart, a task in progress may
  receive one more preflight attempt.
