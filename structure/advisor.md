# Advisor Sidecar

The advisor is an OpenCodex-owned expert consultation runtime. A routed worker can consult a
user-configured expert model WITHOUT any client-side delegation: the proxy injects a synthetic
`advisor` tool, executes the consultation itself through the routing authority, and reinjects the
advice so the original worker continues. `src/advisor/` owns the settings resolver, the synthetic
tool, the sanitized context builder, the loopback consultation executor, and the request plan.

The advisor is distinct from the Codex-owned subagent surface (`subagents.md`): subagents are
worker-initiated delegation through the collaboration catalog; the advisor is a proxy-side sidecar
the client never sees. A worker that never spawns anything can still be advised.

## Optional-subsystem boundary

The advisor follows the same seam discipline as the Lab. `src/server/responses/advisor-slot.ts`
is the core-owned slot: it holds the structural plan interface and the event-stream guard and
imports nothing from `src/advisor/` at runtime. The only runtime import of `src/advisor/` in the
Responses path is `src/server/responses/sidecar-execution.ts`, which registers a per-request plan
onto the parsed request. `src/router.ts`, `src/server/lifecycle.ts`, and
`src/server/responses/core.ts` never reach the advisor, and a disabled advisor executes no advisor
code on the request path. The guard is applied by `adapter-delivery.ts` through the structural
`_advisorGuard` field — type-level knowledge only.

## Execution paths

- Translated (non-passthrough, non-run-turn) fetch path: full support — synthetic tool injection,
  guard interception of `advisor` tool calls, advice reinjection as a paired
  assistant-toolCall/toolResult message pair, and worker re-dispatch through the same
  continuation machinery the terminal guard uses (`adapter-continuation.ts`). Consultations are
  bounded per request; past the bound the worker receives an explicit limit-reached result.
- Run-turn adapters: preflight support only — the guaranteed pre-dispatch consultation applies,
  but the synthetic tool is never injected because the run-turn loop cannot intercept it.
- Native OpenAI passthrough: no advisor support in PR1. The request path is byte-identical to a
  proxy without the advisor; the limitation is documented, not silently degraded.
- Turns claimed by the web-search or image/video sidecar loops keep the advisor tool un-injected;
  preflight still applies.

## Recursion fence

The consultation executor calls the proxy's own `/v1/chat/completions` on loopback with the
`x-opencodex-advisor-internal: 1` marker header (the same structure as the vision-describe
fence). The Chat surface detects the raw header before its bridge rebuilds headers and carries
the fact into `handleResponses` as `advisorInternal`; a marked request never plans an advisor
consultation. Depth cap 1 holds under combo re-resolution.

## Cross-provider consultation

The loopback call re-enters the normal data plane, so model resolution, provider auth, effort
mapping, and usage accounting are the routing authority's job. Any model string the router
accepts works as the advisor: a bare native model, an explicit `provider/model`, or an
account-qualified native model. The advisor never builds its own router and never touches
provider credentials.

## Context and safety boundaries

The advisor payload is built exclusively from the parsed conversation the model is already
allowed to see: user task, conversation, tool calls and their results, the worker's tool catalog,
and both model identities. Thinking/chain-of-thought parts are never included, encrypted
provider content is never decrypted or forwarded, and failure text is redacted and bounded before
it can reach any context. Advice is re-injected as identifiable
`<opencodex_advisor>`-wrapped content with no system authority: manual consultations arrive as
tool results, preflight advice as a marked developer message.

## State

Request-scoped state (consultation count, dedup fingerprints, preflight flag) lives in the
per-request plan closure. Task-scoped preflight dedup is a bounded, process-local ledger keyed by
a stable conversation fingerprint (first user message + worker model) with entry-count and TTL
caps; after a proxy restart a task in progress may receive one more preflight consultation, which
is fail-open for correctness.

## Policies

- `manual` (default): only an explicit worker `advisor()` call consults.
- `preflight`: OpenCodex additionally guarantees at least one consultation per task. The
  documented approximation for "before the first substantive mutation": the guaranteed
  consultation fires on the first worker reasoning turn that arrives WITH tool evidence of
  orientation since the latest user message, unless the conversation already carries advisor
  advice. No semantic stagnation detection exists in PR1.

## Observability

Every consultation writes one structured `[advisor]` log line (trigger, worker model, advisor
model, duration, status, usage) and the loopback call lands in usage accounting as its own
request under the advisor model. Consultation usage is never merged into the worker's terminal
usage; intercepted worker legs are, via the same usage-merge rule the terminal guard applies.
