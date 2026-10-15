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

The core owns `src/server/responses/advisor-plan-slot.ts`, a config-scoped factory slot, and
`src/server/responses/advisor-slot.ts`, the protocol guard. Neither imports `src/advisor/`.
`src/lib/advisor-activation.ts` registers a lazy factory only for an enabled Advisor with a model.
The server composition root registers it synchronously at startup; a successful settings write
updates activation, including enable after startup and disable/reset. The runtime is loaded only
when an active factory is used, so its process-local ledger is not constructed by an inactive
install. `sidecar-execution.ts` reads the core-owned slot, not Advisor settings or runtime.
Management loads `advisor-routes.ts` only for the Advisor namespace. The guard is attached through
`_advisorGuard`. `tests/advisor/advisor-core-boundary.test.ts` enforces the transitive load-time
boundary from router, lifecycle, Responses core and management API, including direct dynamic imports.

## Execution paths

- Translated (non-passthrough, non-run-turn) fetch path: full support — synthetic tool injection,
  guard interception of `advisor` tool calls, advice reinjection as a paired
  assistant-toolCall/toolResult message pair, and worker re-dispatch through the same
  continuation machinery the terminal guard uses (`adapter-continuation.ts`). Consultations are
  bounded at three per request, with at most four Advisor-owned worker continuations. The tool
  is removed when consultations are exhausted. A repeated call gets one final paired limit result;
  a further call ends with typed 502 `advisor_continuation_limit`, without another worker send.
  Counters are shared with empty-completion retries. Usage includes the terminal rejected leg.
  `tests/advisor/advisor-continuation-limit.test.ts` covers a worker that never stops calling;
  `tests/advisor/advisor-responses-wiring.test.ts` exercises real streaming and buffered delivery.
- Run-turn adapters: preflight support only — the automatic pre-dispatch consultation attempt
  applies, but the synthetic tool is never injected because the run-turn loop cannot intercept it.
- Native OpenAI passthrough: no advisor support in PR1. The request path is byte-identical to a
  proxy without the advisor; the limitation is documented, not silently degraded.
- Turns claimed by the web-search or image/video sidecar loops keep the advisor tool un-injected;
  preflight still applies.

## Recursion fence (server-owned authority)

The consultation executor calls the proxy's own `/v1/chat/completions` on loopback and presents
`x-opencodex-advisor-internal` with a **process-owned capability**: a 256-bit random value minted
once per process, kept in memory only — never in config, on disk, in logs, in usage, in request
metadata, or in an API response, and never forwarded upstream. The Chat surface carries the fact
into `handleResponses` as `advisorInternal` only when the header value matches that capability
(shape-checked, constant-time compare); a request without it — including one that sends the old
literal `1` — is an ordinary external request and never receives internal authority. Peer address
is deliberately not part of the decision: Docker, WSL, tunnels, and port forwarding can all end on
loopback. A marked request never plans an advisor consultation, so depth stays capped at 1 under
combo re-resolution, and a new process mints a new value, which invalidates any captured token.

The vision-describe fence still compares a literal header value and therefore has the same
pre-existing spoof shape; wiring it to this capability is a separate follow-up, recorded so the
gap is visible rather than assumed absent.

## Cross-provider consultation

The loopback call re-enters the normal data plane, so model resolution, provider auth, effort
mapping, and usage accounting are the routing authority's job. Any model string the router
accepts works as the advisor: a bare native model, an explicit `provider/model`, or an
account-qualified native model. The advisor never builds its own router and never touches
provider credentials.

## Context and safety boundaries

**Context-sharing consent is required before any of that transfer.** `advisor.enabled` does not
grant it. The operator records `advisor.contextSharingConsent: "v1"` from the dashboard checkbox,
`ocx advisor consent` / `ocx advisor on --ack-context-sharing`, or `PUT /api/advisor/settings`.
Absent, stale, or wrong-typed consent resolves as no consent. The runtime then does not call the
Advisor provider: preflight returns without injecting, and a manual `advisor()` call returns a
consent-required tool result. Task text, the worker, and the Advisor model cannot grant consent.
Upgrades do not write consent for an existing `enabled: true` block.

**What a consultation may send** (only after current consent): the latest user task; user,
assistant, and developer text in the parsed conversation; tool calls and arguments; tool results;
the worker tool catalog and descriptions; worker identity; the configured Advisor model; and an
optional focus question on a manual call. The builder reads parsed task state only.

**What OpenCodex does not insert:** provider API keys, Authorization headers, OAuth tokens,
backend-only config secrets, process environment, hidden chain-of-thought, or decrypted
provider-private reasoning. **Task content is not generally secret-redacted.** A pasted key, a
secret in a file the tools read, or a token printed by a tool can be sent. There is no DLP claim.

The Advisor's own system instruction treats the transcript and tool output as untrusted evidence.
That is defense in depth, not a claim that prompt injection into the Advisor is solved.

## Authority contract

Automatic preflight uses two distinct messages. The fixed runtime transport instruction remains
in a developer-role message; no Advisor-generated bytes are included in it. The quoted
`advisor_result` payload is a separate user-role advisory message. On translated OpenAI Chat,
the fixed developer policy may map to system, but the advisory bytes remain user-role data.
Anthropic carries the advisory in a user message without fabricating an unpaired tool result.
Manual advice stays a paired tool result for a call the worker made.

`advisor_result.advice` is JSON-string-escaped and `status` is runtime-owned. Escaping prevents
structural breakout and forged sibling fields; it does not guarantee a model will ignore hostile
plain-language advice. User-role transport lowers the payload's authority. A dedicated
consultation-result protocol could provide a stronger distinction from ordinary user input.
`tests/advisor/advisor-authority-transport.test.ts` checks hostile advice through both adapters.

Provenance does not trust Advisor strings. Manual "already advised" is a `toolResult` whose
`toolName` is `advisor` and whose content parses as `advisor_result.status === "advice"`.
Automatic preflight dedup is the claim ledger only. Developer text is not inspected. A marker
in shell output, user text, or a developer message cannot suppress a consultation.

## Provenance and the preflight claim

"Already advised" for a manual result is the parsed runtime status described above, not a
substring search. Automatic preflight is not decided from developer-message text. A genuine
manual tool result is a separate provenance check; every other history form — ordinary tool
output, developer text, user text, and failure notices (`<opencodex_advisor_unavailable>`) —
matches nothing. The guard never composes failure prose itself: `AdvisorPlan.formatUnavailable`
owns that text and neutralizes untrusted fragments. Upstream HTTP failures are logged as a
status code only, so an error body that echoes the prompt is not written to the worker context
or the log line.

Keys are SHA-256 digests, never a short fold and never raw text: one domain-separated digest
over `conversation identity + task boundary + worker model`, where the task boundary digests the
FULL latest user text (no truncation) together with the user-turn count. Task identity is a
correctness boundary, so a 32-bit hash is not acceptable there, and storing only the digest means
a captured key reveals nothing about the conversation.

Automatic-preflight dedup is ledger-authoritative. The fixed developer policy labels the
separate user-role payload for the worker. Developer messages are never inspected for suppression. Manual advice
remains a paired tool result whose `toolName` is the synthetic advisor tool and whose JSON
`status` is the runtime-owned value `advice`.

The preflight ledger is an atomic CLAIM table, not a has-then-mark pair: `claim` returns
`claimed` / `inflight` / `complete` / `cooldown` with an ownership token, and a settlement whose
token no longer matches is a no-op.
Success suppresses for the task lifetime; a failure suppresses only for a one-minute cooldown
(the minute scale the repository already uses for polling), so a transient outage pauses the
policy instead of silencing it; a client cancellation releases the claim with no cooldown. Keys
are conversation identity + task boundary + worker model, reusing the existing `thread-id` /
Cursor / replay-scope identities. A client with NO stable identity stays out of the ledger
entirely: it is limited to request-scoped dedup and genuine in-history provenance (fail-open),
so two independent identity-less conversations can never suppress each other.

## Privacy and security

Assets: task contents, tool outputs, credentials that happen to be inside them, provider auth
credentials, conversation integrity, and the worker instruction hierarchy.

Trust boundaries:

- client → OpenCodex → worker provider
- OpenCodex → Advisor provider
- Advisor provider → OpenCodex → worker

| Threat | Control |
| --- | --- |
| Accidental cross-provider disclosure | Advisor defaults off. Current versioned consent is required in addition to `enabled` and a model. The dashboard, CLI, and docs state what is sent. |
| Stale consent after a wider disclosure | Only `"v1"` is current. Any other stored value resolves as no consent and does not authorize transfer. |
| Consent bypass by the worker, Advisor, or task text | Consent is read only from operator config written by the management API, dashboard, or CLI. |
| Prompt injection from task or tool output into the Advisor | The Advisor system instruction treats that material as untrusted evidence. |
| Malicious Advisor output | Fixed developer transport policy and a separate JSON-quoted user-role payload. Provenance and suppression do not trust Advisor strings. The Advisor has no tools. |
| Advice authority | Advisor output is user-role data, never developer/system content. User-role context still requires the worker to distinguish advice from an operator request. |
| Marker or provenance spoofing | Manual detection parses `status` on the runtime object. Developer text is not a suppression signal. |
| Internal loopback spoofing | 256-bit process-local capability, timing-safe compare, not a literal, not forwarded upstream, rotated on restart. |
| Duplicate consultation | Atomic claim ledger with an ownership token. |
| Accidental backend-secret injection | The context builder reads parsed task state, not env, config secrets, or auth headers. |
| Logging of prompt or error bodies | Consultation logs carry model ids, timing, and a bounded status. HTTP failures omit the upstream body. |
| Saturated ledger or provider failure | Saturated ledger fails open for the worker. Provider failure uses a short cooldown and does not fail the coding request. |

## State

Request-scoped state (consultation count, dedup fingerprints, preflight flag) lives in the
per-request plan closure. Task-scoped preflight state is a bounded, process-local CLAIM table
(see "Provenance and the preflight claim") keyed by conversation identity + task boundary +
worker model; a client with no stable identity is excluded from it on purpose. After a proxy
restart the table is empty, so a task in progress may receive one more preflight attempt —
fail-open for correctness and only one extra expert call.

## Policies

- `manual` (default): only an explicit worker `advisor()` call consults.
- `preflight`: OpenCodex additionally ATTEMPTS one consultation per task automatically. The
  documented approximation for "before the first substantive mutation": the attempt fires on the
  first worker reasoning turn that arrives with orientation evidence — an assistant tool call OR
  a tool result — since the latest user message.

  Preflight has two independent suppression checks:

  1. A genuine manual Advisor tool result since the latest user message
     (`historyHasManualAdvisorResult`: `toolName` is the synthetic `advisor` tool and the content
     parses as runtime-owned `advisor_result.status === "advice"`) suppresses automatic preflight
     for that task turn.
  2. For tasks with a stable identity, the server-owned ledger must return `claimed`. Any other
     claim result suppresses that automatic attempt: `inflight` (another request is consulting),
     `complete` (already advised), `cooldown` (recent provider failure), or `saturated` (the
     table is full of live claims). Identity-less clients skip the ledger and fail open.

  Developer-message Advisor text and markers are informational transport and are not used as
  suppression authority.

  A failed attempt is recorded under its own ledger key (no retry storm within the TTL)
  and injected with the `<opencodex_advisor_unavailable>` wrapper, which
  historyHasManualAdvisorResult deliberately does not match: a failure is not advice and does not permanently suppress the
  policy. No semantic stagnation detection exists in PR1. Both policies require current
  `contextSharingConsent` before any task context is sent. Without it, preflight does not run
  and a manual call returns a consent-required result. Consent is re-read from the live config
  immediately before dispatch; a revocation after plan creation (or after a preflight claim)
  blocks outbound transfer, releases any claim, and adds no cooldown or injection.

## Observability

Every consultation writes one structured `[advisor]` log line (trigger, worker model, advisor
model, duration, status, usage) and the loopback call lands in usage accounting as its own
request under the advisor model. Consultation usage is never merged into the worker's terminal
usage; intercepted worker legs are, via the same usage-merge rule the terminal guard applies.
