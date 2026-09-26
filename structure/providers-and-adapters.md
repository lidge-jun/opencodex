# Providers And Adapters

The coding-agent stream parser buffers each tool-use block by its content-block index
and emits a complete start/delta/end sequence on closure. A new start on an occupied
index closes the previous block; distinct indices can interleave. Turn completion
requires every opened block to close, preserving the downstream single-open-call contract.
An indexless argument delta belongs to the sole open block; with multiple blocks open,
the parser fails the turn before releasing their buffered calls.
The capture-only bridge checks each raw tool-use start against the init handshake before
buffering; a later init cannot authorize a call that started earlier.

RunTurn hosted search uses `src/web-search/run-turn-loop.ts`: synthetic calls remain private, progress reaches the bridge during collection, and a validated terminal precedes search execution. Complete search calls remain actionable at a truncated `done`; cancellation prevents subsequent queries and calls. OAuth preflight replay in `src/server/responses/run-turn-execution.ts` retains the synthetic tool while refreshing credential-scoped route state. In `src/server/responses/sidecar-execution.ts`, a search plan takes priority over image/video bridge execution for both transports; only fetch-capable adapters enter the fetch search loop.

Combo preflight allows the private search tool only while a search plan is active; client tool declaration checks and replay-unsafe heartbeat protection remain enforced.

The opt-in `inlineThinkTagModels` list follows static-policy override and model-rename rules;
shared Kiro/Chat splitting and raw display follow [Chat compatibility](providers/chat-compat.md#inline-think-tag-recovery).

Meta Muse management login in `src/server/management/oauth-account-routes.ts` requires a
server-resolved `gui-session` before starting credential acquisition, including local import,
device login, add-account and reauthentication. This principal is not a checkbox receipt;
forged GUI headers and raw management credentials do not substitute for it. Direct CLI login
and other OAuth providers retain their existing policies. `src/oauth/meta-muse-device.ts`
cancels unparsed authorization/mint failures, including mint429, without reflecting their bodies.

The capture-only bridge in `src/adapters/coding-agent/turn.ts` reports staging failures with
the fixed `tool_bridge_setup_failed` error, never an OS error carrying private file paths.
Failure prevents CLI spawn and settles the bridge's private directory; the CodeBuddy adapter
also settles its prompt-file directory. Catalog and MCP-config write failures cover both owners.
In a compiled executable, the bridge launches the private `__codebuddy-mcp` CLI entrypoint;
source execution launches the MCP module with Bun. Both paths advertise only the request's
isolated catalog and leave tool execution to the external client. Qoder appends the folded
system prompt through its documented scoped `QODER_APPEND_SYSTEM_PROMPT` or
`QODERCN_APPEND_SYSTEM_PROMPT` child environment,
never through command-line arguments or inherited vendor variables.

Coding-agent stdout is framed as bounded JSONL directly from decoded stream segments. The framer
tracks the current line's UTF-8 byte count incrementally, searches each decoded segment once, and
joins only when a newline or EOF completes the frame. This preserves split UTF-8, BOM, CRLF,
blank-line, line-limit, and total-limit behavior without re-encoding the growing partial frame on
every child stdout chunk. See [ADR-0102](decisions/ADR-0102-incremental-stream-accounting.md).

Kimi Coding's Chat, API-key, and optional Responses presets consume the same model seeds in
`src/providers/registry/model-seeds.ts`, including the native `k3-256k` ID. The Responses preset
shares the `kimi` OAuth account and Coding endpoint, keeps Chat as the featured default, and
enables adjacent tool-result repair on its Responses wire. Its metadata alias is generated from
the registry; sharing authentication does not implicitly share a usage-price namespace.

OrcaRouter key exchange uses the shared raw-byte reader before returning a durable key. Its
64 KiB response ceiling, single 30-second header/body deadline, and cancellation behavior follow
the [bounded ingestion contract](transports/inventory.md#bounded-response-ingestion-and-orcarouter-login).

Anthropic model-scoped quota labels in `src/providers/quota/vendor-probes-oauth.ts` publish
only canonical Fable, Opus, or Sonnet labels after removing terminal controls; unknown upstream display names are omitted.

MiniMax and MiniMax CN Coding Plan quota in `src/providers/quota/vendor-probes-key.ts` uses the
region-matched `/v1/api/openplatform/coding_plan/remains` endpoint. It publishes the `general`
model's consumed 5-hour percentage and, when active, weekly percentage with their reset times;
video quota rows are unrelated and omitted.

Kiro's account quota cache persists quota and an optional exhaustion verdict under one
opaque account key and a non-secret login identity. Hydration admits only matching live
accounts and bounds quota and verdict independently by reset and ten-minute TTL; a failed
probe keeps the same-login last-good display bar. The protected OAuth store rotates
`ProviderAccount.loginId` on every explicit login, preserves it across credential refresh,
and uses `addedAt` for legacy rows without one.

For Kiro, `src/oauth/generic-account-failover.ts` filters confirmed monthly exhaustion
and process-local suspension by the live account identity before picking a replacement.
The account actually sent supplies the generation fence; a rotated bearer always travels
with its own profile ARN and region. Reactive rotation follows the stored two-account
quorum, while refusal-aware first admission follows the proactive preference setting.
Kiro's `least-loaded` strategy selects the fewest in-flight eligible requests under
`pool.kernel` and proactive preference; unknown quota remains eligible. Its optional
per-account cap is validated only for Kiro and never persists in-flight counts.

The routed identity sentence a catalog row carries is model-neutral on disk: `base_instructions`,
and a native capability alias's `model_messages.instructions_template`, hold `NEUTRAL_IDENTITY_LINE`
rather than a model id, because Codex stores a session's instruction block once and replays it
verbatim into a sub-agent spawned on a DIFFERENT model, where a baked id makes the worker answer
identity questions with the parent's id (#5217). The destination model is therefore named at request
time, in two steps, because the parser reads the body before routing has run and can only name the
id the CLIENT sent. `src/responses/parser.ts` names it in the top-level `instructions` string and in
developer and system-role items; `applyFinalRouteRequestNormalization`
(`src/server/responses/core-normalize.ts`) then settles that sentence on `route.modelId` through
`renameRoutedIdentityInContext`, where the wire id is final and every dispatch path — passthrough,
`runTurn`, and the adapter request build — still has to read the context. Adapters that build their
own system text call `identifyRoutedModel` on top of that with their own wire id, so the ones that
never call it are not the ones that leak a client selector upstream (#5221).
The Responses passthrough rewrites the sentence on a routed destination and strips it on a native or
forward one, where Codex's own identity wording already supplies it;
`tests/adapters/identity-neutralize.test.ts` and `tests/adapters/identity-subagent.test.ts` pin the
rewrite rules and the routed-id settlement.

| Path | Responsibility |
| --- | --- |
| `src/providers/registry.ts` | Compatibility facade; canonical provider presets for CLI, dashboard, OAuth, key providers, and metadata live in `src/providers/registry/entries-core.ts` and `entries-extended.ts`, with model seeds in `model-seeds.ts`. |
| `src/providers/registry/model-ids.ts` | Classifies every `ProviderRegistryEntry` field by what its KEYS mean for selector decoding, and derives the native model ids an entry names. The classification is exhaustive by construction: a new registry field fails typecheck until its keys are given a meaning, which is what stops an identity-bearing map from being silently left out of decoding. Imported directly rather than through the facade, which is at its file-size cap. |
| `src/providers/derive.ts` | Enrichment from provider presets into user config. |
| `src/providers/model-rename-fields.ts`, `src/providers/model-rename-migration.ts` | Classifies every provider config field for a declared model rename. Exact-model records, lists and nested request-pacing keys follow the replacement; an already saved replacement entry wins. Provider-wide settings and credential fields are not model identities. |
| `src/providers/resolved-model-policy.ts`, `src/providers/resolved-model-policy-merge.ts` | Static provider/model policy resolution for the final upstream wire model, plus its pure clone/merge/URL/family helpers. The resolver detaches and freezes registry defaults, operator overrides, exact explicit input-modality declarations, provider-scoped hard wire pins (including Command Code's `claude-` prefix), aliases, and explicit false/empty values with field-level provenance. Provider derivation, routing, catalog hints, gather admission, and adapter selection consume its detached frozen result. Callers supply transport match, the exact capability row, and a credential-free effective auth decision; credential bytes, usability evidence, account/quota/health state, and observed limits remain outside the result. |

| `src/oauth/` | OAuth providers, token storage, refresh, and auth-token resolution. Meta Muse device authorization, polling, and key-mint JSON responses share the 64 KiB bounded-body ceiling and the request's deadline; oversized declared or streamed bodies are rejected before JSON parsing. The login callback listener binds a per-provider FIXED loopback port, so consecutive logins reuse the same number; every response it sends ends its connection (`Connection: close`, including non-callback paths such as a stray `/favicon.ico` 404). Stopping the listener does not close an established socket, so without that a pooled client would deliver the next login's callback to the retired flow, which rejects the unknown state as a CSRF mismatch while the live flow waits. Command Code manual callback JSON remains opaque to the shared `code#state` parser and is state-validated by its provider parser. A raw Command Code paste with an explicit `#state` suffix must match the flow state on the direct prompt as well. Kiro add-account identity prefers same-session `whoami` over a leftover SQLite state profile, and never persists the Builder ID service profile ARN as `accountId`. |
| `src/combos/request.ts` | Clones each selected combo target request and applies the existing target capability ladder: adaptive unknown targets and explicit empty ladders receive no unsupported reasoning/thinking controls, while known ladders retain per-target resolution. |
| `src/adapters/openai-responses.ts` | Native OpenAI/ChatGPT Responses passthrough. |
| `src/responses/muse-tool-name-alias.ts` | Host-gated Meta Muse 64-char tool-name alias/restore used by the Responses passthrough. |
| `src/adapters/openai-chat.ts`, `src/adapters/openai-chat/` | OpenAI-compatible Chat Completions bridge, split into leaves (`wire.ts`, `messages.ts`, `response-events.ts`, `passthrough.ts`, `parallel-tool-calls.ts`, `reasoning-wire.ts`, `serialized-tool-call-content.ts`, `tool-call-validation.ts`, `tool-call-id-remint.ts`, `tool-schema.ts`, `errors.ts`). `parallel-tool-calls.ts` owns the `parallel_tool_calls` wire value for both the translated and native builders, so the three provider states — configured opt-out, configured opt-in, and the unset default that forwards only a caller's explicit `false` — cannot drift between them. `reasoning-wire.ts` applies explicit gateway-object and tool-bearing effort-omission declarations to both builders; absent declarations leave native raw forwarding unchanged. Its client delivery shapes in `src/chat/outbound.ts` and `src/server/chat-native-sse.ts` relay the upstream `service_tier` echo on non-stream, folded-stream, and synthesized-SSE bodies, never inventing the key when the upstream omits it. |
| `src/adapters/anthropic.ts` | Anthropic Messages bridge. A `refusal` or `content_filter` stop reason yields an explicit `incomplete` event with `retryable: false` rather than `done` with that stopReason (#4312); `max_tokens` remains `done`. It is the wire that defines `tools[*].strict` and `tools[*].allowed_callers`, so a rebuilt declaration carries both: an explicit `strict: true` and any `allowed_callers` the caller declared. An absent `strict` stays absent, because the Messages inbound records it as `false` and a `false` on the wire would read as an opt-out nobody asked for. Anthropic Fast uses the native `anthropic-speed` FastWire: a set decision sends `speed: "fast"` with `fast-mode-2026-02-01` in one case-insensitively merged, deduplicated `anthropic-beta` header that preserves OAuth betas. Stream and buffered `usage.speed` echoes confirm fast or downgrade to standard; no echo leaves the request assumed. `tests/adapters/anthropic/anthropic-fast-speed.test.ts` pins the wire and echoes. Anthropic Fast is opt-in: the registry marks both Anthropic entries `fastOptIn`, and `src/providers/fast-opt-in.ts` (`providerFastSwitchOff`) keeps Fast off until `providers.<name>.fastEnabled` is `true`. An off switch is provider capability `false`, applied in the FastPolicy authority (`service-tier.ts`), `resolveModelPolicy`, and router registry enrichment, so no model-level Fast toggle, `--fast` row, or proxy-generated `speed` field is produced. Native Claude Messages passthrough still forwards a `speed` field the caller sends itself, outside the proxy Fast policy. `tests/adapters/anthropic/anthropic-fast-opt-in.test.ts` pins the default, the switch, and the management PATCH/GET. |
| `src/adapters/google.ts` | Gemini bridge. The final wire compiler owns [endpoint-scoped tool-schema loss policy](providers/google.md#google-tool-schema-loss-reporting): compatible mode changes no request bytes, strict initial loss creates no physical send, and strict non-direct repair creates no changed repair send. A caller-declared strict tool selects `functionCallingConfig.mode: "VALIDATED"` in place of the absent-choice default; `NONE`, `ANY` and a forced-name choice are stronger constraints the caller asked for and are never overwritten. |
| `src/adapters/unique-tool-call-ids.ts` | Request-scoped tool-call-id uniqueness for every `openai-chat` provider. An upstream that mints an id from the call's position in its response repeats `call-0-0` on every turn; a Messages client has already paired that id, drops the duplicate, and is left with a call that has no result, so the turn reads as empty and the model re-issues it indefinitely. Only a **repeat** is rewritten — the first occurrence stays byte-identical, leaving prompt-cache keys, reasoning-replay lookups and already-unique upstreams untouched. The ids to avoid come from the caller's history, captured in `buildRequest` (the only point that sees it) and applied at emission, never at ingestion: ingestion matches streamed deltas against the id upstream sent, so rewriting there would strip a pending call of its identity mid-stream. A repeat takes a `-<n>` suffix, never `_<n>`, because `<earlier>_<digits>` reads as a batch sub-call of `<earlier>`. Covered by `tests/adapters/openai/openai-chat-tool-call-id-remint.test.ts`. |
| `src/adapters/declaration-carrier.ts`, `src/adapters/input-media-guard.ts` | Default-deny allowlists for constraints the normalized request carries but a wire may not be able to express: `tools[*].allowed_callers`, which fences a tool off from callers, and inline document bytes. Both are refused with a 400 at the single guard every registered adapter passes through, rather than left to each adapter, because an adapter that never learned about the carrier rebuilds without it and answers normally. `allowed_callers` reaches the `anthropic` wire; document bytes reach `anthropic`, `openai-chat` and `google`; the `openai-responses` wire is exempt from the whole guard because it forwards the original body. Adding an `AdapterWire` member makes the omission visible in these lists instead of at a customer's upstream. The unrestricted `["direct"]` caller default is not a restriction. |
| `src/adapters/azure.ts` | Azure OpenAI bridge. |
| `src/adapters/cursor.ts`, `src/adapters/cursor/` | Cursor protobuf transport: discovery, request builder, event decoding, MCP, thread continuity, native-exec policy. |
| `src/adapters/devin.ts`, `src/adapters/devin/cloud-direct/` | Devin runTurn transport over Cognition Connect-RPC. `GetChatMessage` uses the Responses provider executor and shared physical-send budget; catalog, JWT, and `src/web-search/devin-executor.ts` native search support RPCs remain outside inference-send accounting. Provider-stated pre-output 429 reset delays are surfaced immediately by default, releasing shared active-turn capacity. A positive `OPENCODEX_DEVIN_STATED_RESET_WAIT_MS` explicitly enables bounded waiting and up to two replays on standalone turns, which hold that capacity until completion or cancellation. Combo children bypass that wait and surface a pre-output 429 so the next target can run. During an opted-in standalone wait, safe heartbeats commit the response preflight and keep the stream's stall watchdog fed. Invalid values fail closed to the immediate-refusal behavior. A recorded tenant host is used only for the stored account whose credential owns the transmitted key, searched in the configured provider id and then its deprecated alias; a configured, forwarded, or unmatched key uses the configured base URL or the US default. Native search previews the current route by effective adapter without mutating combo selection state, pins one admitted active-account snapshot for the request, and calls `GetWebSearchResults`, so it starts no CLI or second model. |
| `src/adapters/kiro.ts` and `src/adapters/kiro/` | Kiro event/tool/thinking/truncation/retry handling, including an egress-aware completion fallback, fixed public HTTP 5xx text, and closed-set status/code diagnostics. The original path is a facade over leaves for wire identity, reasoning, conversation state, token estimation, payload assembly, streaming, and the adapter. |
| `src/adapters/mimo-free.ts` | Mimo Free transport (client identity + JWT). Concurrent requests share one JWT bootstrap bound only to its timeout; each request stops waiting on its own abort without cancelling the others. |
| `src/adapters/command-code.ts`, `src/adapters/command-code-tool-text.ts`, `src/adapters/command-code-restored-schema.ts` | Command Code OAuth NDJSON translation. For every `xiaomi/mimo-` model, text, native calls, reasoning, and terminal decisions share one byte-bounded queue with linear queue visits. Markup is deduplicated against matching native calls; text-only restoration requires one contiguous text run, a clean finish, a declared tool, and arguments validated against supported schema constraints. A parameter-free (freeform) block may omit `</function>` but must end with `</tool_call>`; parameter blocks keep the canonical close. Markup appended after prose in the same delta is split off at the marker and held like a block that opens with `<tool_call>`; a marker split across deltas after prose is still released as text. Native, reasoning, and other intervening events interrupt a still-probing block but leave a held block held in arrival order, and the queued byte bound still flushes an unresolved envelope as text. An envelope the strict parser rejects but that opens with `<tool_call>`, closes with `</tool_call>`, and names a declared function is dropped when a native call for that same function arrives and on a clean finish; markup that parses but fits no supported schema is still released as text. Regex patterns, other unsupported constraints, and abnormal finishes fail closed. `tests/providers/command-code-tool-text-prose-split.test.ts` covers the split, the interleaved-event hold, and both drop paths. |
| `src/adapters/image.ts`, `src/adapters/anthropic-image-guard.ts`, `src/adapters/anthropic-image-normalize.ts`, `src/adapters/anthropic-image-codec.ts` | Image conversion for adapter ingress and Anthropic-specific normalization/limits. An image's ladder position is pinned to its own identity (content hash + media type), so appending a newer image cannot re-encode older ones and bust Anthropic's prompt prefix cache (#4532). |
| `src/adapters/run-turn-queue.ts`, `src/adapters/tool-catalog-nudge.ts`, `src/adapters/identity.ts`, `src/adapters/upstream-http-error.ts` | Shared adapter execution support: turn queueing, tool-catalog nudging, client identity, upstream error normalization. |

## Keyless Zen client identity

`src/adapters/opencode-free-session.ts` mints the keyless Zen tier identity for the canonical `https://opencode.ai/zen/v1` endpoint from the shared Chat transport (translated adapter and native fast path alike) and the Responses passthrough (`src/adapters/openai-responses/passthrough.ts`): a stable-per-Codex-thread `x-opencode-session` in the OpenCode session shape (`ses_` + 12 hex + 14 base62), the anonymous `Bearer public`, and a repair of exactly the bare default User-Agent to a verified versioned one — applied only when the operator has not set those headers and only when no API key is configured. `src/adapters/opencode-free-tools.ts` appends the missing never-invoked `shell`/`read` gate declarations the tier requires behind one shared helper (keyless only), and builds the guidance text for mistaken calls (naming the turn's real alternatives, never upstream internals): the translated lane substitutes it in a registry-composed Chat wrapper applied conditionally on the endpoint, the native Responses lane in the undeclared-tool guard rewrite, both firing only for gate names the client never declared. The `opencode-free` registry entry routes the Responses-only Muse Spark contributor-free ids to `openai-responses` through `modelWireDefaults` on every inbound; every other Zen id stays on Chat.

> Decision record: [ADR-5810](decisions/ADR-5810-zen-keyless-client-identity.md)

Inline document admission shares one encoding predicate between its scanner and parser in
`src/responses/inline-document.ts`: malformed base64 quantum/padding lengths are refused,
and valid padded or unpadded payloads pass unchanged without a decoding allocation.

Kiro metering uses the [provider credit contract](providers/kiro.md#kiro-reasoning-round-trip-signature);
`src/types/request.ts` keeps reported credits separate from estimated token usage.

Adapter output must stay in internal `AdapterEvent` form until `src/bridge/sse.ts` converts it back
to Responses SSE or WebSocket frames, or `src/bridge/response-json.ts` buffers it into a JSON
response. `src/bridge.ts` is the compatibility facade that re-exports both.
`src/adapters/run-turn-queue.ts` preflight callers may supply an optional wait bound; timeout hands
the outstanding iterator read to replay once, while callers without a bound keep the existing wait.

The image/video loop bounds each hidden iteration before replay or fulfillment; see
[media iteration retention](transports/inventory.md#media-iteration-retention).

Live model discovery is bounded and registry-driven through `src/providers/model-discovery.ts`.
Custom providers keep the conventional `${baseUrl}/models` request, normalized by
`providerModelsUrl` the same way `openaiChatCompletionsUrl` normalizes the send path: outer
whitespace and trailing slashes are trimmed and an already-pasted `/models` is not doubled, so a
`baseUrl` written with or without a trailing slash yields the identical discovery URL and an
existing path prefix is preserved. Canonical presets may select a
trusted URL/path/query, response envelope key, model identifier field, and declarative eligibility
filter without persisting that policy into user config. A response is rejected before caching when
it exceeds 4 MiB, contains more than 2,000 raw rows, has a malformed declared list envelope, or
includes an invalid model id. Tests use fixtures and
must never depend on live provider endpoints. Newly promoted fixed key presets opt into
`preserveCustomDestination`, so an older same-named custom provider keeps its configured adapter,
destination, and key boundary instead of being silently canonicalized onto the new host. Fixed
OAuth presets resolve discovery against the same canonical registry transport as normal routing
before any adapter-specific transport override, so a stale configured `baseUrl` cannot receive an
OAuth bearer token.

Command Code effort defaults in `src/providers/command-code-efforts.ts` combine public-profile
facts with the live API measurements from #5096. Both presets share the exact per-model rows;
`xhigh` is preserved when accepted, and narrow ladders such as Laguna's `medium`-only row remain
narrow. Rows without a verified profile URL still record rejected efforts but skip profile fetching.
An explicit `modelReasoningEffortsAuthoritative` model row overrides the shipped ladder; seeded
rows without that flag do not. `tests/providers/command-code-efforts.test.ts` covers the measured
rows and wire values; `tests/providers/command-code-provider.test.ts` covers operator overrides.

## TypeSafe JEV decision provider

`src/providers/registry/entries-extended.ts` owns the canonical `jev` key preset at
`https://api.typesafe.ai/v1/systemone` with adapter `jev-decision`. It is a credential owner, not an
inference route: the registry marks it `credentialOnly`, its adapter is deliberately absent from the
routable adapter registry, live discovery is disabled, no default/static model is published, and
key login returns unknown without probing a nonexistent model catalog. The normal `ocx login jev`
flow and provider-workspace API-key panel both persist the same credential-only row. Combo validation
rejects the decision provider as a target. `src/server/management/provider-routes.ts`
special-cases its connection test through the same bounded decision client before the generic
static-catalog branch. The test sends no user prompt and returns only sanitized health status.

The request path consumes a configured literal/reference key only when the row still matches the
canonical registry transport, with `TYPESAFE_API_KEY` and the standard provider-derived
`JEV_API_KEY` as explicit environment fallbacks. A same-named custom destination cannot receive
either credential through the JEV client. All automated coverage mocks TypeSafe; live-key behavior
remains an operator smoke boundary.

`src/combos/jev.ts` extracts bounded user-task, previous-assistant, and latest-tool-output text plus
the tool name and boolean signals; raw image data, tool arguments, encrypted reasoning, headers, and
the JEV credential are excluded. It owns the joint target/effort choice map, strict response
validation, fixed `jev-latest` destination, four-second deadline, no-redirect policy, bounded response,
and caller-cancellation propagation. Missing credentials or safe state, transport failures, and invalid
answers fail open to the first eligible target; no response can escape the configured choice map.
Telemetry never retains extracted state or credentials.

`src/server/responses/core-combo.ts` computes current eligibility, asks JEV once for the initial pick,
applies the validated effort, and removes caller `service_tier` for that child. A retryable child
failure re-enters the ordinary Combo fallback loop from the untouched request without another JEV
call. Each target may carry an optional non-empty `reasoningEfforts` allowlist. Omission keeps the
backward-compatible all-advertised behavior; a present list is intersected with current capabilities,
and an empty intersection removes that target from the JEV choice map rather than broadening it.
Direct models and every other Combo strategy bypass this path. The shared Combo editor owns the GUI
checkboxes and `Create JEV Auto` template; no second model picker or JEV-only editor exists.

JEV setup stays inside those existing shells. A configured `jev-decision` provider Overview exposes
**Create JEV Auto**, which navigates to the registered `models/combos/jev-auto` action hash.
`gui/src/pages/Combos.tsx` owns that one-shot add intent and normalizes the hash when the modal
closes; `ComboWorkspace` and `combo-workspace-add-modal.tsx` reuse the ordinary Combo form and target
editor with a pure template from `combo-workspace-data.ts`. The template includes only currently
available Astra/Sol/Luna rows, remains fully editable, marks the first eligible row as fail-open,
and displays known effort ladders. The JEV provider is hidden from the target picker because it owns
only the decision credential. Existing model rows, default selection, and direct picker behavior are
unchanged; an existing `jev-auto` id or alias disables or reports the quick action.
An existing JEV Combo adds a lazy **Stats** detail tab. It polls only while visible, uses the
management API's JEV projection, and keeps decision-service tokens separate from physical model
tokens. Config remains the ordinary editable Combo form, including per-target effort allowlists.

`src/usage/jev-stats.ts` owns the parallel content-free JEV projection. Its retained accumulator is
keyed by Combo and stable preset boundary, shares concurrent reads, verifies append identity and LF
digest, clones before folding a suffix, and starts a fresh accumulator after a rebuild-required
scan. It counts physical sends from `attempts[].sendCount`, ignores zero-send rows for fallback
detection, and folds identities beyond 255 concrete rows into one explicit overflow row while
preserving global totals. Up to four JEV projections participate in the same app-owned memory budget
and eviction path as ordinary usage aggregates. Read failure returns HTTP 500 rather than a partial
projection.

The Crusoe preset uses that fixed-key path at `https://api.inference.crusoecloud.com/v1`. Its
registry-owned policy admits only public rows whose `architecture.modality` is `text` or
`multimodal`, caps the response at 256 KiB and 256 raw rows, and leaves same-named custom
destinations untouched. Five catalog ids carry explicit text-and-image input metadata;
`openai/gpt-oss-120b` alone carries a direct low/medium/high `reasoning_effort` ladder.

Provider-scoped capability hints remain authoritative when discovery returns an id without
capabilities. In particular, `src/providers/registry/entries-core.ts` assigns OpenCode Go's live
`deepseek-v4.1-flash` route the official 1,048,576-token window instead of the conservative 128k
routed-model fallback.
Meta's two direct surfaces keep separate reasoning contracts: `meta-model` remains capped at
`xhigh`, while `meta-muse` advertises `max` and sends the transparent Muse compatibility
User-Agent required by that credential surface. The existing registry header merge keeps an
operator-supplied User-Agent authoritative.
The same registry declares the first-party `deepseek-flash` model with `text` and `image` input,
so it bypasses the vision sidecar by default; explicit `noVisionModels` or text-only declarations
remain authoritative. First-party `deepseek-chat`, `deepseek-reasoner`, and `deepseek-v4-flash`
remain sidecar-backed by default.

OpenCode Go's `deepseek-v4.1-flash` joined them on 2026-09-19: probed against
`https://opencode.ai/zen/go/v1/chat/completions` with this proxy's headers, the route accepts an
`image_url` part and the model reads it, so it left `noVisionModels` and gained a positive
`modelInputModalities` declaration. Its sibling `deepseek-v4-flash` on the same gateway still
answers HTTP 400 "Model only supports text input" and stays sidecar-backed. The Zen tiers
(`opencode-zen`, `opencode-free`) were not measurable (HTTP 402) and keep their existing
classification — an unverified tier is not evidence.

Because `enrichProviderFromRegistry` fills `noVisionModels` all-or-nothing and fills
`modelInputModalities` per-key beneath the saved value, both halves of a stale classification are
frozen into any config saved while it was current. `src/providers/stale-vision-classification-migration.ts`
repairs exactly those two saved values and runs inside the shared startup repair pass in
`src/providers/model-rename-startup.ts`. Correcting the registry alone fixes new installs only.

It covers both states that reach a running process, because the sidecar predicate reads
`noVisionModels` before `modelInputModalities`: the full stale pair (modalities still the stale
declaration and the id listed, both rewritten) and the half-repaired row (modalities already
corrected but the id still listed, where removing the name is what stops the image from being
stripped). The paired modality declaration is the guard in both cases, which is why a name listed
without one is left alone — that row is either a half-finished repair or a deliberate operator
entry, and the projection does not guess which. The row must also still be the registry's own:
identity resolves through `providerMatchesRegistryTransport`, the rule `enrichProviderFromRegistry`
applies before it writes registry metadata, plus the entry's adapter. `opencode-go` is a pinned
key preset without `preserveCustomDestination`, so its id alone claims a row — exactly as it does
for enrichment — and an entry that opts into destination preservation narrows the projection with
it. `modelCapabilities` is never written: it is the
axis that outranks every source here, so it is where a deliberate text-only override belongs
(`ocx provider edit <provider> --model <id> --text-only` writes it) and the one declaration a
restart cannot take back.

The BigModel Coding Plan Responses preset uses the separately documented
`https://open.bigmodel.cn/api/v1` transport and a static catalog. Its provider row
disables live discovery: a local Codex `models.json` example does not establish an
authenticated HTTP models endpoint. Its static context and reasoning metadata are
kept in the canonical registry, including an explicit empty selectable effort
ladder for `glm-5-turbo`.

Raycast is a managed client export, not an upstream model provider. Its YAML
contribution owns only the unique `providers/[id=opencodex]` entry, with the
existing manifest and fingerprint checks protecting user-owned provider values.
Ambiguous selector matches and incompatible containers cannot be adopted or
mutated. Catalog refresh uses the existing owned-integration activation check;
an unowned client remains disconnected. OpenCodex omits Raycast API-key fields
and exports only to eligible local targets. Pro detection is an advisory hint,
not an authentication or entitlement decision.

Routed Responses continuations whose local replay state is missing resolve their recovery decision from the selected wire protocol, not the model name; the contract lives in [Responses transport](transports/responses.md).

Volcengine Ark Coding Plan is a native Responses preset at `/api/coding/v3/responses`. Validated
tool continuations there reject the reasoning item the previous turn returned, so its registry
entry sets `dropResponsesReasoningItems`, which removes replayed Responses `reasoning` items from
continuation input before forwarding. That is lossy — summaries, item ids and `encrypted_content`
go with the item — and an explicit `false` on the provider turns it off. The flag belongs to the
DESTINATION rather than to the provider-wide wire, so `routedProviderConfig` fills it on the
early-return path too: a row saved on Chat still reaches the Responses adapter when one model
opts in through `modelAdapters`, and would otherwise forward the rejected item. Because it changes
the continuation body, it is part of the compatibility behavior record and two routes that
disagree about it are not the same subject.

A row already saved on `openai-chat` keeps that wire. The entry is
`preserveCustomDestination` with key auth, so `providerMatchesRegistryTransport` refuses the
adapter mismatch and the request path returns the stored row unchanged, and the retired Chat
destination stays an alias so that row keeps this entry's metadata. There is deliberately no
startup config migration: the Z.AI one (`src/providers/zai-responses-migration.ts`) is
behavior-preserving only because it gates on `providerMatchesRegistryTransport` and therefore
rewrites rows the router already canonicalizes, which a Volcengine Chat row is not.

Command Code ships its own per-model `reasoning_effort` table in
`src/providers/command-code-efforts.ts`, and that table decides the wire effort. Profile refresh
adds newly listed efforts while retaining accepted rungs; every observed upstream rejection stays
excluded from later refreshes for that destination and model. Configuration can take precedence, but only when the provider declares
`modelReasoningEffortsAuthoritative`:
`providerConfigSeed` copies the shipped table into every materialized preset and both enrichment
and routing keep a persisted row over the current seed, so neither the presence of a configured
row nor its difference from today's table establishes that a human wrote it. With the flag the
ladder resolves through `configuredReasoningEfforts`, the same function that advertises the Codex
picker, so the catalog and the wire agree; a rung the upstream then refuses is returned as that
error rather than replayed without the effort, because the operator asked for it. The flag is part
of the compatibility behavior record for the same reason as above.

The shared Responses path follows the [bounded multipart recovery contract](subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

## Hosted-search continuation binding

The opt-in key-auth Responses hosted-search bridge in `src/server/responses/passthrough-delivery.ts` captures the
request binding that served the first leg, after any permitted initial reselection. Before every
continuation dispatch, after provider pacing, that binding must remain an API-key selection matching
the configured entry, reference, revision, resolved key, authentication mode, and base URL; a
disabled or removed provider fails the same check. Drift produces the bridge's failed terminal
without another provider request, and an unchanged binding resends the built request with its
executed search result appended, never re-entering the initial reselection/rebuild path. Initial
dispatch keeps its normal reselection policy. When the route's registry policy carries a
terminal-repair grace (`modelResponsesTerminalRepair`), the response body of every successful
continuation is wrapped by the same repair that saw the raw first leg, so a complete leg the
destination leaves open still ends that leg on schedule instead of stalling the turn. `tests/web-search/web-search-passthrough-bridge.test.ts`
covers drift during search, while pacing, and before first-leg headers return, plus successful
first-dispatch reselection and result preservation.

`providers.<name>.webSearchBridge.backend` is explicit-only. `ollama` spends that provider's API key
on the planned search endpoint. `openai`, `anthropic`, `xai`, `gemini`, and `exa` reuse the matching
sidecar executor and that executor's own credential; a missing credential leaves the bridge
disarmed rather than falling through to another paid search. A leg that mixes an intercepted
`web_search` call with another client-executed tool ends the turn on that leg: the intercepted
searches run, their hosted cells complete, the held client calls are released for the caller to
execute, and the leg's own terminal closes the turn with no continuation sent upstream. The
destination therefore does not receive that search result during the turn. It gets it on the next
one: every search the bridge executes is recorded in `src/responses/bridge-search-replay-cache.ts`
under the hosted cell's proxy-minted id, scoped to the admitted caller principal, client
conversation, and exact provider, adapter, model, destination, and physical credential binding, and bounded by entry count, total
bytes, and a one-hour TTL. An unavailable scope fails closed. The caller principal comes from
`resolveContextPrincipal`; a caller that presents no opencodex API key (a keyless loopback
client) has none and is never given a shared one, so nothing is recorded or restored for it and
its hosted cells reach the destination unchanged. When the caller replays that cell,
`restoreBridgedWebSearchCalls` in `src/adapters/openai-responses/tool-output-recovery.ts` puts the
destination's own `function_call` and the executed `function_call_output` back in the cell's
position before the next turn's first leg is dispatched, recording exactly the text
`appendBridgeSearchTurn` would have sent on a continuation leg so a replayed turn and a continued
turn show the destination one consistent conversation. The rewrite runs only for a provider with
`webSearchBridge.enabled`, and a miss — unknown id, expired entry, a different conversation or
serving binding, or a `call_id` the body already carries — leaves the replayed item untouched.
Re-running the search or synthesizing result text is not a permitted recovery. The bridge finalizes
request-scoped OpenAI sidecar authority on completion, failure, and client cancellation —
cancellation releases immediately rather than waiting on an abandoned upstream read — so a
recovery probe lease no search consumed is always returned.
`tests/web-search/web-search-bridge-replay.test.ts` pins the restore and each of those refusals.
A forward OpenAI search sidecar retries a 429 only when the requested delay fits both its retry ceiling and the remaining overall sidecar deadline. A delay that cannot fit returns and records the original 429 so pool routing retains quota evidence.
One search makes at most three physical sends in total: connection-reset recovery and 429 replays draw from the same budget, and a budget spent with a 429 in hand ends with that 429 as the recorded outcome.
A leg whose
upstream terminal is `response.failed` or `response.incomplete` runs no search at all and closes
any cell it opened rather than leaving it in progress. Assistant text is not treated as a search
instruction.

`src/web-search/passthrough-bridge.ts` withholds at most 8,388,608 UTF-16 code units of
SSE data payloads per leg; this is not a byte or total-heap measurement. A companion cap of
65,536 events is derived from that budget at a realistic 128-code-unit serialized delta, so it
only bounds per-event object overhead the character budget cannot see rather than refusing a
large client-executed tool call streamed as fine-grained argument deltas. The first over-budget
event fails the leg before releasing any held tool call, and reports that refusal as the
bridge's own bound rather than as an upstream read failure.
Read failures and exhausted continuation budgets use the same cleanup: discard held calls and
close every search cell opened by the current leg as failed before one failed terminal and DONE.
Successful release serializes held events lazily rather than building another full frame array;
release, discard, and the next leg reset the held payload counter and identity sets.
`tests/web-search/web-search-progress-stream.test.ts` covers both bounds, identity-only deltas,
upstream cancellation, cell closure, the exact event boundary, and mixed terminal controls.

The bridge backend and the global `webSearchSidecar` block are configured independently, so the
sidecar's `model` applies to a bridge search only when `resolveSidecarBackend(webSearchSidecar.backend)`
equals that bridge backend; otherwise the bridge runs the backend's own default. An unset global
backend resolves to `openai`, so an unset-backend model reaches an `openai` bridge and no other.
There is no per-provider `webSearchBridge.model`, so a mismatched backend gets the default rather
than a vendor-specific override. This is a model and settings rule, not a credential one:
`resolvePassthroughWebSearchBridgeAuth` switches on the bridge backend and consults only that
backend's credential locator, so no key crosses backends. `reasoning` and `xSearch` are not gated —
`reasoning` is a generic effort level and `xSearch` is xai-only with no per-backend default and no
`webSearchBridge` equivalent. `resolveSidecarBackend` lives in `src/web-search/sidecar-providers.ts`
rather than the `src/web-search/index.ts` barrel so the bridge can answer this question without a
value import of the barrel; the barrel re-exports it.
`tests/web-search/web-search-passthrough-bridge.test.ts` covers the mismatch and matching cases for
anthropic, xai, and gemini, plus the unset-backend default.

`providers.<name>.webSearchBridge.endpoint` names the destination that receives that provider's own
API key, so it carries the same literal destination assessment as `baseUrl`:
`providerDestinationConfigError` runs both at management write time, inside
`providerWebSearchBridgeConfigError`, and at plan time inside `resolveOllamaWebSearchEndpoint`.
Metadata destinations are refused unconditionally; loopback, localhost, and private space need the
provider's `allowPrivateNetwork` opt-in or a registry entry that is local by default, which is what
keeps a self-hosted Ollama on `127.0.0.1` working. Both checks are synchronous and literal-only and
resolve no DNS, so a hostname that resolves into metadata or private space is a disclosed residual
rather than a blocked case. That residual is strictly larger than `baseUrl`'s: `baseUrl` also runs
the async `providerDestinationResolvedError` at management write, which the endpoint does not, and
parity there would still leave the hand-edited-file path uncovered because the plan-time boundary is
synchronous. The plan-time check is the
authorization boundary rather than a second opinion: a hand-edited config file, `ocx config set`,
and `ocx config import` all reach `configSchema` only and never call
`providerWebSearchBridgeConfigError`, and `resolveOllamaWebSearchEndpoint` is the only reader of
this field in the tree, so a value that survives file load still cannot be spent. It refuses
silently by design; config-time is where the operator is told why. The planner requires the
provider name for that assessment, so `planPassthroughWebSearchBridge` takes it explicitly.

## Meta Responses tool selection

At the final request boundary for `api.meta.ai`, `src/adapters/openai-responses/passthrough.ts`
uses `src/adapters/openai-responses/muse-tool-choice.ts` to normalize `tool_choice`. Omitted or
`auto` selection keeps its meaning. Explicit `none` sets `tools` to an empty list, removes
`additional_tools` items from `input`, and omits `tool_choice` and `parallel_tool_calls` from the
outgoing body. Forced, named, and `allowed_tools` selections fail with HTTP 400 before the
upstream send because Muse supports only `auto`. Filtering a required tool never changes the
caller's obligation into `none` or `auto`. This rule applies only to the Meta Responses
destination. The input body, historical tool calls and results, and non-Meta requests keep their
existing meaning.

## Shared type declarations

`src/types/` holds the declarations every layer imports: config types (`src/types/config.ts`),
provider and account types (`src/types/provider.ts`, `src/types/accounts.ts`), and the internal
request shape (`src/types/request.ts`). Two files also own small resolvers that must agree at every
boundary. `src/types/tools.ts` owns tool-name identity: namespaced and dotted names, declared-name
normalization, and `tool_choice` alias resolution, so every adapter matches a declared tool the
same way. `src/types/wire.ts` owns accepted wire enumerations such as the per-provider upstream
HTTP-version pin, shared by the config load schema, the management write boundary, and the fetch
runtime, so no boundary accepts a value another rejects.

Preflight heartbeat retention keeps `replayUnsafe` sticky in the replayed tail, so a second
preflight cannot forget earlier side effects after the original marker is evicted.
