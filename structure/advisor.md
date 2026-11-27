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
Request-scoped copies of the live config, such as the Claude replay config `/v1/messages` passes to
the Responses pipeline, are linked with `linkAdvisorPlanConfig` so they resolve the live config's
factory at lookup time. The view's `advisor` reads through to the live config, so a consent
revocation after the copy still blocks outbound transfer up to dispatch: the runtime rechecks
consent immediately before the loopback call, and a revocation after that call has been dispatched
neither cancels it nor retracts context already sent
(`tests/advisor/advisor-messages-replay-config.test.ts`).
Advisor settings admit the complete synchronous candidate/read/patch/save/activation phase through the [config admission contract](config.md). Production uses the current disk candidate when present, preserving unrelated disk edits during admission. Successful saves adopt the committed Advisor subtree and its field-scoped live baseline together, including known absence after reset, without advancing unrelated pending live edits. Fallback or error-bearing diagnostics are refused before mutation. Deadline refusal leaves live and durable settings untouched and retains the existing `write_failed` response. Successful receipts are serialized in that callback before another settings mutation can run.
Management loads `advisor-routes.ts` only for the Advisor namespace. The guard is attached through
`_advisorGuard`. `tests/advisor/advisor-core-boundary.test.ts` enforces the transitive load-time
boundary from router, lifecycle, Responses core and management API, including direct dynamic imports.

`src/server/responses/advisor-retention.ts` bounds guard-owned retention independently of provider
parser leases: 32 MiB across raw legs, reconstruction copies and appended replay history, 2 MiB
per Advisor call's JSON-encoded argument fragments, 4,096 retained events and 1,024 calls per leg.
Non-empty text/thinking deltas consume bytes but no event slots, because the 16 KiB per-leg
character caps already bound them; empty ones are not retained. Other empty fragments count;
signatures, redacted blocks and opaque tool metadata consume bytes. Real
tool arguments pass through without a retained copy and end replay retention for that leg.
Reconstruction reserves space before joining or parsing admitted sources; raw and replay owners
overlap until the replacement is admitted. Appended history remains charged through the guard's
final exit. Accumulated usage has a separate retained owner across legs; replacement admits the
new usage while raw terminal data and prior usage remain charged. An optional request translator
budget receives separate local charges, never shared
event/call leases or disposal. All exits, including iterator close, release only the guard's own
charges. Refusals use content-free 502 `upstream_error` / `translation_buffer_limit` events.
`tests/advisor/advisor-retention.test.ts` covers aggregate/count admission, representations,
multi-call pairing, overlap and lifecycle release.

## Execution paths

- Translated (non-passthrough, non-run-turn) fetch path: full support — synthetic tool injection,
  guard interception of `advisor` tool calls, advice reinjection as a paired
  assistant-toolCall/toolResult message pair, and worker re-dispatch through the same
  continuation machinery the terminal guard uses (`adapter-continuation.ts`). Explicitly unfinished tool ends cannot trigger consultation or continuation. Consultations are
  bounded at three per request including automatic calls, with at most four Advisor-owned worker continuations. The tool
  is removed when consultations are exhausted. A repeated call gets one final paired limit result;
  a further call ends with typed 502 `advisor_continuation_limit`, without another worker send.
  Counters are shared with empty-completion retries. Usage includes the terminal rejected leg.
  `tests/advisor/advisor-continuation-limit.test.ts` covers a worker that never stops calling;
  `tests/advisor/advisor-responses-wiring.test.ts` exercises real streaming and buffered delivery.
  Client catalog checks wrap the Advisor guard, so synthetic calls are consumed internally before
  final worker output is checked against current client declarations, including direct encoders.
  Synthetic injection requires the request's effective `tool_choice` to permit Advisor. For an
  explicit selector or allowlist, `src/responses/parser-tools.ts` retains typed client selectors
  and the selected root function names before provider translation. An unqualified function
  selector can permit synthetic Advisor. An explicit root selector using the reserved `functions`
  namespace also permits synthetic Advisor when no caller declaration owns the root name.
  A caller-owned `advisor` can pass through when its
  declared kind, name and any explicit namespace match the original selector and the effective choice permits it. With `auto`
  or `required`, caller-owned tools follow the effective choice alone. A forced hosted search
  excludes a caller-owned `advisor` even when the worker receives `auto`.
  The guard resolves worker call names against the caller catalog, including flattened, dotted,
  and compatible bare or reserved `functions` echoes. It checks the declaration against
  the original typed selector and checks the effective choice on each worker leg. A forbidden call
  is refused before consultation, continuation, or disclosure of its ID and arguments.
  Linked Messages replay uses the same check. `src/claude/inbound-content-options.ts` identifies
  an explicitly selected hosted Advisor from the original declaration before choice lowering.
  The Responses core validates the original choice against the resolved route and admitted
  catalog. Duplicate matches return a request-wide HTTP 400 before dispatch. A declaration
  unavailable on the current route, under its model scope, or under the selected credential's
  captured token spend ceiling refuses that candidate before dispatch.
  Combo and policy fallback can try another candidate with the original declaration and choice.
  When all attempted candidates are incompatible, delivery retains the public HTTP 400.
  An admitted named choice drives Anthropic wire encoding and grants no root
  function permission. Explicit hosted selections skip proxy preflight. Other automatic
  consultations follow operator policy. The translated Messages wire and guard are covered by
  `tests/claude-integration/claude-translated-hosted-advisor-choice.test.ts`.
  A buffered refusal preserves the already-parsed rejected worker leg's terminal usage, merged
  with earlier intercepted legs once. Streaming refusal closes its iterator immediately.
  The empty-completion retry preserves `undeclared_tool_call` and merges available usage.
  A streaming refusal can close the retry before that send reports terminal usage.
- Run-turn adapters: preflight support only — the automatic pre-dispatch consultation attempt
  applies, but the synthetic tool is never injected because the run-turn loop cannot intercept it.
- Native OpenAI passthrough: no advisor support in PR1. The request path is byte-identical to a
  proxy without the advisor; the limitation is documented, not silently degraded.
- Fetch-based web-search turns: full manual support. `createAdvisorSidecarStep` shares the same
  consultation and continuation bounds with the normal guard. The search scanner consumes advisor
  calls alongside `web_search`, fulfills them in worker order, and replays paired results without
  exposing the synthetic call to the client. The synthetic tool and scanner are enabled only when
  the caller's selection and effective `tool_choice` permit Advisor. The same call resolver runs on each
  search iteration and leaves the search tool's outbound translation intact. A caller-owned
  `advisor` must be declared and permitted by both the original selector and current iteration's
  effective choice. The loop refuses other unauthorized calls before their IDs or arguments
  reach the client. Partial calls are refused at
  their start, and the terminal refusal retains worker usage. Synthetic permission is also
  iteration-scoped: tools-disabled empty-answer recovery refuses Advisor even when the original
  turn installed the sidecar; ordinary exhausted-Advisor iterations retain paired limit handling.
  Mixed real client calls still end
  interception. Search and Advisor iterations have independent allowances within one hard loop cap;
  consultation waits emit heartbeats and share the loop's cancellation signal. `advisor-responses-wiring.test.ts`
  covers search-enabled, mixed-call, real-client-call and repeated-consultation paths. The limit
  reports accumulated worker usage once, without attaching it again to the terminal error;
  `tests/advisor/advisor-web-search.test.ts` covers the accounting and independent allowances.
- Turns claimed by the image/video sidecar loops keep the advisor tool un-injected; preflight still applies.

## Claude Code's typed Advisor server tool

Claude Code also declares Anthropic's own Advisor server tool (`advisor_YYYYMMDD`, beta
`advisor-tool-2026-03-01`), which Anthropic runs server-side under the same wire name `advisor`.
The two never share a turn. When this sidecar injects its synthetic tool,
`src/server/responses/sidecar-execution.ts` removes the declaration for the whole turn, so a later
web-search iteration without the synthetic tool cannot forward it either, and records the protocol
reason `advisor-tool-shadowed-by-proxy-advisor` for a destination that would otherwise receive it.
`planAnthropicServerTools` (`src/adapters/anthropic/advisor-tool.ts`) also withholds the completed
Advisor history and the beta while a function tool named `advisor` owns the name, the same rule that
keeps the web-search sidecar's `web_search` ahead of a typed search. With
this sidecar off and no applicable token spend ceiling, the declaration reaches first-party
Anthropic, or a gateway with `forwardAdvisorTool: true`, and its blocks round-trip to the client. Destination, replay and scope
rules are in [providers and adapters](providers-and-adapters.md);
`tests/claude-integration/claude-translated-advisor-tool.test.ts` covers both sides of the precedence
through the Responses core.

Translated turns evaluate the current send's selected identity and effective wire. An applicable
root, identity or pool token ceiling withholds the optional hosted declaration, completed Advisor
history and beta from that send onward, while the main model and other tools continue. The same
rule applies when the effective Anthropic provider appends an operator credential header recognized
by `src/providers/api-key-response-ownership.ts`, which makes credential ownership ambiguous.
An explicit Messages selection refuses either target before vision preprocessing or worker dispatch. An
eligible fallback candidate can still fulfill the selection. The client receives HTTP 400 if no compatible route serves the request
before response streaming starts. During streaming, a refused continuation emits a terminal error.
`hosted-advisor-spend.ts` and `sidecar-execution.ts` use the transport's `initialAdapterProvider`
to check the actual authenticated target's ceilings without starting main-model accounting. The
original translated turn owns the numeric ceiling snapshot and shares it with the default policy
candidate and translated Combo trackers. The budget's read-only
`hasCapturedSpendCeiling` checks the original numeric ceilings against that target, including an
identity selected after Combo prepayment. An inherited budget can also supply its published
snapshot for that check. See [Responses spend](transports/responses-spend.md#prepaid-initial-sends)
for precedence. The request-owned `hostedAdvisorSpendGuard` runs in the selected adapter's
`buildRequest` wrapper after credential admission, including sidecar copies and dispatch-time
reselection. The builder supplies its own resolved provider and reuses the captured policy.
Eligibility follows its effective wire, even when credential rebuilding restores a provider-wide
adapter. Once withheld, the optional hosted tool and replay stay withheld across later credentials,
policy candidates and translated Combo children in the same turn.
`src/server/responses/request-transport.ts` uses the effective Anthropic serializer to bind each
hosted Advisor request to the credential it applied, including on local-mode gateways.
`request-spend-target.ts` keeps the hosted binding separate from ordinary accounting scopes. For
Anthropic OAuth, the existing OAuth label function hashes the admitted serving snapshot's provider
and account ID. This keeps same-ID accounts in separate instances distinct. Identity changes only
when normal credential admission accepts a new snapshot. Provider display tags and generic account
log fields stay the same.
After upstream plugin rewrites and before the physical-send receipt, the HTTP guard requires an
exact match and uses the same ownership classifier to reject conflicting credential headers. On
failure, it refuses the explicit selection or rebuilds the optional request with its original
serializer inputs and hosted Advisor withheld. The final headers omit the Advisor beta.
Removing Advisor blocks from a validated mixed replay run preserves the other completed search
or fetch exchanges at their original unique anchor and in their original order, subject to the
existing destination checks.
For a choice without an explicit hosted selection, after the final tool catalog is known, an
unmatched named `advisor` choice becomes `auto` when spend policy has removed its hosted tool or
replay. A named selection with an ordinary or proxy function owner keeps that owner. The delivery
maps are rebuilt once and charged for newly usable tools;
normal, web-search and image/video paths apply this before the adapter builds its request.
An existing entry trace receives `advisor-tool-withheld-by-spend-policy`; unmarked
Combo children retain the existing trace behavior. Main-model terminal usage does not independently account for
the hosted Advisor. The proxy Advisor retains its separately budgeted consultations; see
[Responses spend](transports/responses-spend.md). The same integration test covers all three scopes,
streaming and buffered responses, replay, opted-in gateways, accounting and admitted identity,
and policy changes after capture.
`tests/responses/responses-first-send-spend-policy.test.ts` also covers target-dependent authority
across key rotation, including a rebuilt provider whose default differs from its pinned wire,
the web-search retry copy, post-rotation named-choice delivery and explicit hosted refusal.

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
provider credentials. `src/server/capture-admission-policy.ts` freezes a credential-free copy of
the caller's model scope, metered consent class, fallback policy and resolved device ids at HTTP
authentication, before any inbound-body capacity wait or body parsing; `src/server/index/serve-options.ts`
hands that snapshot to the Responses, Chat, Messages and compact handlers. WebSocket turns capture
before dispatch; policy-profile retries retain the outer owner's snapshot. Compact retains it through
native retries and routed Responses/JEV handoffs. `src/types/admission-policy.ts` defines these decision inputs.
`src/server/advisor-admission-scope.ts` holds them in a process-local registry for one consultation.
Its random 256-bit handle is honored only beside the current process-owned capability; unknown
or missing handles are refused. Consultation completion or failure releases the entry; abort
revokes it immediately, even while transport work is still settling. Registration owns a frozen copy.
The bounded scope envelope remains validated separately. Neither handle nor capability is sent upstream.
Advisor and shared local Chat self-fetches use direct transport, including when the destination
is the hub's non-loopback bind address. Outbound provider requests still follow provider egress policy.

Routed vision carries the same frozen policy through its plan and a scoped registry entry. The
shared local Chat helper registers every self-fetch and attaches a frozen policy when supplied.
Its separate sidecar capability authenticates origin and any inherited policy without suppressing
Advisor on the helper.
Chat intersects that registration with the host snapshot captured at authentication; missing or
expired registrations presented with a valid capability are refused. Completion, failure and abort
release the entry. Ordinary client headers cannot grant inherited policy authority.
A loopback listener (a loopback bind or the secondary loopback listener) admits the self-fetch before
reading any token, so that snapshot carries no key limits. After the capability and registration
are validated, Chat therefore also resolves the `x-opencodex-api-key` the self-fetch presents and
intersects that key's scope, paid-combo consent and fallback device identity; a presented credential
the data plane does not recognize is refused. Other loopback callers keep plain loopback admission.
`tests/advisor/advisor-caller-policy-host-key.test.ts` drives both loopback ingress shapes.
Senders pick that credential with `selfFetchAdmissionToken` (`src/lib/local-destinations.ts`): the
unchanged ladder where the destination requires admission, otherwise only the first ladder credential
this data plane recognizes, so a hub client key a loopback bind left out of its admission credentials
is not sent. When a loopback listener admitted the hop, `selfFetchHostPolicy` takes paid-combo
consent from the validated key instead of the loopback default a public bind always refuses; the
combo's own opt-in and the caller's consent still bind, and the hop keeps loopback transport identity.
`tests/advisor/advisor-caller-policy-self-fetch.test.ts` covers both on the real listener.

The host keeps its admission identity and adds the captured caller constraints. Shared scope,
metered-consent and fallback guards require the intersection of caller and host policy for every
resolved destination, combo pick (including router-collapsed picks), proactive/reactive fallback
and child invocation. Nested JEV decision turns retain that same admission. Scope intersection
checks each original scope, preserving bare and provider-qualified model semantics. Later edits
or removal of the caller's key or fallback settings cannot broaden the frozen decision inputs.
`tests/advisor/advisor-caller-policy.test.ts` exercises these constraints through real handlers.
`tests/advisor/advisor-caller-policy-routing.test.ts` covers laptop provider-fallback refusals,
native combo dispatch, early capture, external forgeries and worker-unavailable delivery.
`advisor-caller-policy-ingress.test.ts` and `advisor-caller-policy-http.test.ts` widen live config during body reads and capacity waits.
`advisor-caller-policy-vision.test.ts`, `advisor-caller-policy-replay.test.ts` and
`advisor-caller-policy-compact.test.ts` cover routed helpers, policy candidates and compact JEV turns;
`advisor-caller-policy-sidecar-authority.test.ts` covers sidecar capability admission and registration lifetime.

## Context and safety boundaries

`advisor.contextMode` defaults to `context`. With `question-only`, the consultation sends only a
fixed question-only system instruction and the worker's trimmed `question` (at most 2,000 Unicode
code points plus a truncation notice). No task, transcript, tool catalog, worker identity or repair
evidence is attached. The protocol guard and builder share `src/server/responses/advisor-question.ts`:
clipping preserves surrogate pairs, scans only through the first excess code point and is idempotent.
`buildAdvisorUserPrompt` returns before reading parsed task state. The
synthetic tool requires a self-contained string question. Its schema omits length constraints so
Google's `reject-lossy` policy can accept it; the runtime enforces nonempty input and the shared bound.
Both the runtime and low-level consultation
executor reject empty questions without dispatch. The runtime re-reads the mode before dispatch.
Its synchronous admission hook also prevents invalid question-only calls from consuming the guard's
consultation allowance. Worker continuations retain their independent hard limit, including invalid calls.
Automatic preflight and adaptive repair consultation are disabled in this mode because they have
no worker-written question. Existing consent, request limits and adaptive task budgets still apply.
The management API, CLI `--context-mode` and dashboard checkbox configure the same field.
The CLI capability registry publishes the flag and automation exception in the generated `skills/ocx/` operating reference.
`tests/advisor/advisor-consult.test.ts` checks real loopback request equality across history sizes.

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
owns that text and neutralizes untrusted fragments. Upstream HTTP failures use a status code only; transport exceptions use a fixed failure category.
Neither upstream error bodies nor exception messages enter worker context or consultation logs.

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

Adaptive spending state is separate: `src/advisor/budget.ts` reserves attempts in private
`advisor-budget.sqlite` under the resolved config home, with a SQLite immediate transaction.
The task digest omits worker identity so changing workers does not reset its allowance. The
original task key is captured before automatic user-role injection and reused by continuations.
Reservations count dispatched failures and cancellations, expire 24 hours from the first
attempt, survive restarts, and never evict live tasks (512-task capacity). A locked, unavailable
or full database refuses the expert call while the worker continues. No database is opened
until an adaptive consultation with stable identity is actually admitted. Manual and preflight
policies retain request limits and the existing preflight ledger without the durable task cap.
Activity and worker results distinguish a request consultation `limit` from a durable task `budget` refusal.

## Dashboard model selection

`gui/src/components/AdvisorModelSelect.tsx` loads `/api/models` independently of the settings editor and uses the shared `Select`. Values are exact `namespaced` routing selectors, never display names or lowercased input. Disabled and initial-selection-pending rows are excluded from new choices. A current value outside the selectable catalog remains visible with a warning; load failures preserve it and expose retry. Clearing saves the existing empty-model state. The catalog provides no text-consultation eligibility guarantee; the operator chooses a text-capable model. API and CLI model-string validation remains unchanged.

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
  policy. No semantic stagnation detection exists. Both policies require current
  `contextSharingConsent` before any task context is sent. Without it, preflight does not run
  and a manual call returns a consent-required result. Consent is re-read from the live config
  immediately before dispatch; a revocation after plan creation (or after a preflight claim)
  blocks outbound transfer, releases any claim, and adds no cooldown or injection.

- `adaptive`: retains the initial preflight attempt and additionally consults after a failed
  repair. `src/advisor/evidence.ts` scans at most the latest 512 messages after the current user
  task for paired validation calls/results with explicit exit codes, a completed successful
  file-edit tool after the first failure, and a newly started execution of the same validation
  in the same directory failing again. A successful validation clears the failure. Polling a
  command started before the edit is not a post-repair retry. Unknown/compound shell commands,
  shell-based edits and ambiguous output do not qualify. `src/advisor/evidence-tool.ts` accepts
  single Code Mode helpers with static JSON arguments; it never evaluates worker JavaScript.
  The bounded failure/repair/retry evidence, including message references and output excerpts,
  precedes the clipped general transcript in the Advisor prompt.

  The preflight ledger key and each failed-repair event key are independent, so initial advice
  or a successful manual consultation cannot suppress a later repair event. A claim still
  serializes concurrent consultations of the same event and failure uses the existing cooldown.
  Event identity uses the paired tool-call IDs; shifting history positions changes source
  references without granting the same failed repair a second consultation.
  Automatic adaptive calls require stable conversation identity; clients without it retain only
  request-bounded manual access. All adaptive attempts, including manual calls, use the durable
  `maxConsultationsPerTask` allowance (integer 1–3, default 3). The worker's three-consultation
  request cap and four-continuation cap remain hard bounds.

## Observability

Every consultation writes one structured `[advisor]` log line (trigger, worker model, advisor
model, duration, status, usage) and the loopback call lands in usage accounting as its own
request under the advisor model. Consultation usage is never merged into the worker's terminal
usage; intercepted worker legs are, via the same usage-merge rule the terminal guard applies.

`src/advisor/activity.ts` holds config-scoped process memory: at most 100 records, at most 24
hours old, with pruning on access and no timer. The store is keyed by the LIVE config object, so a
request that runs on a linked view (the Claude replay config) records into the feed the management
route reads. `GET /api/advisor/activity` and `ocx advisor
activity` expose trigger, status, models, requested/mapped effort, duration and reported tokens.
There are no task bodies, commands, advice, conversation identifiers or provider error bodies
in these records. Dashboard polling runs only while its page is visible. Restart clears activity,
independently of the durable budget; no adoption score or exact monetary cost is inferred.

`src/server/inference/advisor-diagnostics.ts` carries bounded serialization evidence in the
loopback response only for the process-capability-authenticated Advisor caller. Translated
paths use adapter-owned `effectiveEffort`; native Chat observes the finalized request body.
No requested value is substituted for missing wire evidence. The activity UI displays unknown
when unreported and does not claim verification of a provider's internal reasoning.

Translated union combos check the selected hosted Advisor against each candidate’s destination and caller model scope before evaluating image or context capability. Child preparation checks the selected tool again on the settled route.

## Streaming, stability and external MCP / CLI host

`src/server/chat-native-eligibility.ts` and `src/server/messages-native-eligibility.ts`
(`bridgeOnlyPolicyApplies`, excluding first-party `oauth` when `managedMessagesNativeOAuth` preserves
native wire fidelity) decline direct native Chat / Messages forwarding when `config.advisor.enabled`
is true with a non-self advisor model so worker turns enter the Responses sidecar pipeline.
`advisorPlan.injectWorkerNotice` places a runtime-marked `developer` worker notice (`ADVISOR_RUNTIME_NOTICE_START` / `ADVISOR_RUNTIME_NOTICE_END`) ahead of the latest user
turn only on paths where an advisor tool is actually callable (external `consult_advisor` MCP tool
when permitted by `tool_choice` and `explicitClientToolChoices`, `webSearchAdvisor`, or normal
translated exchange after attaching the synthetic `advisor` tool — excluding run-turn and
image/video paths without an allowed external advisor tool, and skipping duplicate synthetic
attachment on both normal and web-search paths only when `advisorPlan.hasExternalMcpTool` is true
for the effective `tool_choice`).
When long tool loops or repeated errors push an older runtime notice beyond `ADVISOR_TAIL_NOTICE_WINDOW`,
only validated runtime-marked copies are stripped and re-anchored at the tail (`urgentRepair` wording
after `>= 2` errors or long loops) without touching application-owned `## Advisor` developer messages
or splitting `tool_call`/`tool_result` pairs.
`src/advisor/state.ts` keeps in-flight preflight ledger claims alive for the full duration of an
active consultation (`isAlive` liveness predicate settled in `finally`) while retaining
`ADVISOR_INFLIGHT_TTL_MS` for untracked/abandoned claims.
`src/server/chat-completions.ts` derives `advisorSessionIdentity` from `x-opencode-session`,
`x-session-id`, `x-conversation-id`, and W3C `baggage` `codebuddy.session_id`
internally into `parsed._advisorSessionIdentity` (without mutating upstream `session-id` HTTP headers)
so `policy: adaptive` retains task identity without altering upstream wire headers.

During intercepted tool calls, `src/server/responses/advisor-slot.ts` (`withAdvisorHeartbeats`)
yields `{ type: "heartbeat" }` events so the worker SSE stall timer stays alive during long
expert turns. `src/advisor/consult.ts` sends `stream: true`, detects headerless SSE incrementally
while streaming; it assembles multiline SSE data fields per event and stops at `[DONE]`. Data fields reset `createInactivitySignal` before EOF (ignoring `: ` heartbeat
comments; default `timeoutMs` is `600_000` ms / 10 min, max `1_800_000` ms / 30 min).

For harnesses whose built-in models bypass the OpenCodex proxy,
`src/advisor/external-consult.ts` backs `POST /api/advisor/consult` with uniform consent checks
(matching routed paths, including `question-only`), fail-closed adaptive task-budget enforcement
(deriving `external:<taskId|sessionId>` or canonical `external:transcript:<path>` and rejecting
adaptive requests without a stable identity with `400 advisor_budget_identity_required`),
content-hashed request dedup (including `taskId` and transcript digest), explicit-ID/path local
`.jsonl` session transcript attachment in `contextMode: "full"` across `~/.workbuddy`,
`~/.workbuddy-ai`, `~/.qoder`, `~/.qoder-cn`, `~/.commandcode`, and `~/.claude/projects`,
preferring exact session IDs over task-ID fallbacks and excluding prior Advisor calls and results
(`loadWorkBuddySessionMessages`), and a bounded 32-entry 30-minute consultation store that never
evicts pending entries (returning `429 advisor_capacity_exceeded` when saturated) and separates
TTL expiry pruning from insertion eviction. Long-poll `waitMs` is capped at `240_000` ms across
API, CLI (`ocx advisor consult`), and stdio MCP (`src/advisor/mcp-server.ts`, `ocx advisor mcp`,
annotated `readOnlyHint: false, openWorldHint: true`)
to stay below the 255s HTTP listener idle timeout; `nextCallArguments` (`{ consultationId, afterElapsedMs }`)
accepts any nonnegative integer cursor alongside `notifications/progress` heartbeats.
Advisor CLI settings output reports MCP reconciliation errors separately from mounted-client trust status; JSON retains the management response.
`contextMode: "full"` expands bounded per-message/transcript caps (128k/512k chars) and strips
`<system-reminder>` wrappers before clipping.

`src/advisor/client-mcp.ts` manages per-client `opencodex-advisor` MCP registration (`selfLaunchArgv`
for both source-entrypoint and standalone executable installs plus explicit `OPENCODEX_HOME` and `BUN_BE_BUN=1`
propagation), hooks (stripping only the exact command OpenCodex registers, the POSIX single-quoted script path,
while preserving sibling commands and same-named hooks at other paths in shared hook groups; the hook
script's own path assignments are single-quoted too), and skills across compatible clients (`workbuddy`, `workbuddy-ai`, `qoder`, `qoder-cn`,
`commandcode`, `cline` with 900s timeout and explicit user confirmation, `opencode` with 900_000ms
timeout and `skills/`, optional `claude`). The reminder requires readable Advisor settings and an executable runtime before checking proxy health. Skill files (`ADVISOR_SKILL_MARKER`) and hook scripts
(`ADVISOR_HOOK_MARKER`) carry explicit ownership markers: unowned files and symlinks are never
overwritten or counted as mounted, and unmounting deletes only verified OpenCodex files (never recursive
directory removal, preserving sibling user files). An `opencodex-advisor` MCP entry is replaced or removed only when it is
exactly what OpenCodex writes now or what it recorded writing in `<configDir>/advisor-mcp-entries.json`; a
same-named entry the user created is refused on mount and left in place on unmount. `autoMountMcp` defaults
to off: writing into another tool's configuration needs that explicit opt-in or a manual `mcpClients`
selection. An explicit `homeDir` without an explicit `env` ignores the host's client config-directory
overrides, so tests and previews cannot reach a real client configuration. Sync targets are gated on `advisorRunnable` (so
missing or revoked consent unmounts existing MCP registrations, hooks, and owned skills), reconciled
by resolved filesystem path (`collectProtectedPaths`) so shared custom directories (e.g. `WORKBUDDY_CONFIG_DIR`)
are never unmounted by an unselected sibling client, isolated per client for errors, backed up once
before edits. On shared JSON configs an Advisor write advances the Routing `OwnershipRecord.fileFingerprint`,
so Routing toggles do not read it as a conflict, but not the Undo journal: Undo of the Routing apply sees
the Advisor edit as drift and asks before restoring a snapshot that would remove it. Bidirectional sync links `PUT /api/advisor/settings` (`autoMountMcp` / `mcpClients`) with
client route toggles in `src/server/management/integration-routes.ts` (`reconcileAdvisorMcpForRoutedClient`,
wrapped so optional MCP failures degrade via `advisorMcp` without interrupting committed Routing
mutations or Home route-intent recording). `gui/src/pages/Advisor.tsx`,
`gui/src/pages/advisor/AdvisorClientMcpPanel.tsx`, and `gui/src/pages/integrations/FileIntegrationPage.tsx`
surface draft-derived auto selection, `runnable`-gated mount notices, partial MCP sync errors with
retry, mounted config paths, and client-specific trust steps.
