# Transports And Sidecars SOT

## Responses HTTP/SSE

`/v1/responses` is the main Codex-facing endpoint. The server parses Responses input, routes to a
provider, lets the selected adapter speak the upstream protocol, then bridges adapter events back to
Responses-compatible streaming output.

The option-aware `openai` provider uses `openai-responses` with `authMode: "forward"`. Pool mode
resolves main plus added accounts through affinity/quota/cooldown ownership; Direct forwards only
the allowed Codex/OpenAI auth/session headers from the current request and short-circuits pool
state. `openai-apikey` uses its configured key and canonical API base URL. Missing credentials fail
within their route; neither route falls through to the other. See
[`08_openai-provider-tiers.md`](08_openai-provider-tiers.md).

`POST /v1/responses/compact` handles remote compaction v1 before the generic `/v1/responses` branch
and before the `/v1/*` guard. Unknown `/v1/*` paths return JSON 404 errors instead of falling through
to GUI static serving.

### Passthrough SSE stream shapes (#314)

Native passthrough SSE has TWO shapes, selected per request in
`src/server/responses/core.ts`:

- **Default: tee + background inspection.** `upstreamResponse.body.tee()` sends
  branch[0] to the client (pure native relay on win32 without item-id repair —
  the Bun#32111 crash workaround; a JS relay elsewhere) while branch[1] is
  drained eagerly by `consumeForInspection`/`consumeForResponseLogMetadata`
  for terminal-outcome recording, quota, the passthrough continuation cache,
  and request logs. This is the only shape on the bundled Bun 1.3.14.
- **Gated: eager bounded relay** (`src/server/relay-eager.ts`). win32-no-repair
  only, armed by `decideEagerRelay(config.streamMode)` from
  `src/lib/bun-stream-caps.ts` — default-on only for runtimes proven to carry
  the Bun#32111 fix (`MIN_FIXED_BUN_VERSION`, null until a bundle bump), or by
  explicit `streamMode: "eager-relay"` opt-in. One eager reader + byte-bounded
  client queue + post-cancel bounded discard-drain replaces the tee, preserving
  the full inspection side-effect set (shared `createSseInspector` factory in
  `relay.ts`) including the #44 late-terminal semantics.

The two-shape contract is mirror-commented in `src/server/index.ts` and
source-invariant-tested by `tests/passthrough-abort.test.ts`; keep both in
lockstep with any `core.ts` passthrough change.

## Standalone Images

Codex's local `image_gen.imagegen` tool makes a second Images request after the model calls it:
`POST /v1/images/generations` for generation or `POST /v1/images/edits` for reference-image edits.
These are standalone Images API routes, not the hosted Responses `image_generation` tool.

`src/server/images.ts` uses the existing ChatGPT/OpenAI fallback unless `images.provider` explicitly
selects a custom API-key `openai-responses` provider. Explicit selection fails closed when the
provider is missing, disabled, registry-managed, incompatible, or lacks a usable key; it never
falls through to another paid upstream. The relay accepts bounded JSON generation and edit requests,
then forwards the decoded JSON without rewriting Codex's edit schema. Each paid Images POST receives
one upstream attempt; client cancellation aborts the upstream and pool-only failures update the
existing account-health state. Unknown Images subpaths still reach the JSON `/v1/*` 404 guard.

On non-loopback binds, data-plane authentication and origin policy cover both Images routes. An
explicit keyed Images provider accepts the proxy admission secret as either an OpenAI-style bearer
or `x-opencodex-api-key` because the provider key replaces caller authorization before fetch. The
ChatGPT forward path still requires the dedicated header so its upstream bearer remains distinct.

The API-key `openai-responses` path also prevents the standalone client tool from colliding with the
hosted Responses tool. When a request declares `image_gen.imagegen` (as a flat function or an
`image_gen` namespace), the adapter drops hosted `image_generation` while preserving unrelated
tools. Conflict discovery spans both top-level `body.tools` and Codex Desktop Responses Lite
`input[].type = "additional_tools"` containers because the platform validates their merged tool
namespace. ChatGPT forward mode preserves the pair because that backend accepts it and owns native
image generation.

Per-model `modelReasoningSummaryDelivery` is a narrow compatibility layer for
`openai-responses` gateways whose summary capability is real but whose accepted delivery enum
differs from Codex. Presence advertises reasoning summaries in the routed catalog and rewrites only
an already-present `stream_options.reasoning_summary_delivery` at the adapter boundary. It never
injects summary generation into a request, and config validation rejects a delivery map that
conflicts with `modelSupportsReasoningSummaries: false` for the same model.

[Decision Log]
- 목적과 의도: Preserve Codex Desktop reasoning summaries while adapting only the delivery enum rejected by a specific Responses-compatible upstream.
- 기존 구현 및 제약 조건: The existing boolean capability either passed Codex's enum unchanged or disabled summaries entirely; stale running clients can keep sending the old enum after a catalog refresh.
- 검토한 주요 대안: Disable summaries; rewrite the enum globally; inject a delivery field when absent; configure a provider-wide value.
- 선택한 방식: Use a validated per-model allowlisted map, imply summary capability for that model, and rewrite only a caller-provided delivery field at the Responses adapter boundary.
- 다른 대안 대신 이 방식을 선택한 이유: Upstream enum support differs by model and provider, while global rewriting or injection would change unrelated requests and disabling summaries removes Desktop UX.
- 장점, 단점 및 영향: Configured models retain the native summary UI and stale clients self-heal; each incompatible model needs an explicit map entry and contradictory opt-out configuration now fails closed.

## Claude Desktop config-library resolution

The Desktop profile writer and management status probe share
`resolveDesktop3pConfigLibraryPath`. Explicit opencodex and Claude user-data overrides win; otherwise
the resolver follows Electron's platform user-data convention under the `Claude` application
directory. The retired hardcoded `Claude-3p` path is neither read nor migrated implicitly, so the
status endpoint cannot report a self-consistent file that Desktop never sees.

[Decision Log]
- 목적과 의도: Make the generated Claude Desktop profile land in the directory the installed Desktop application actually reads and keep dashboard status consistent with that write target.
- 기존 구현 및 제약 조건: Both callers duplicated a macOS-only `Claude-3p` fallback, which made their internal status agree while Electron used `Claude/configLibrary`; users may also set explicit profile roots.
- 검토한 주요 대안: Rename only the CLI fallback; scan both directories; move or delete legacy files automatically; centralize a cross-platform resolver.
- 선택한 방식: Centralize override-aware macOS, Windows, and Linux resolution and use it for both write and status paths without destructive migration.
- 다른 대안 대신 이 방식을 선택한 이유: One resolver prevents drift, platform defaults match Electron, and leaving the legacy directory untouched avoids deleting user data or guessing which copy should win.
- 장점, 단점 및 영향: New applies become visible to Desktop on every supported platform; old `Claude-3p` files remain harmless and users with nonstandard layouts must use the documented override.

## Cursor Native Exec

Cursor's experimental live transport can receive server-driven local read/write/delete/ls/grep,
shell, and fetch exec frames. These frames are denied by default because they bypass Codex's normal
approval and sandbox path. `nativeLocalExec: "on"` is the explicit config-owner opt-in for trusted
local experiments; `off` and the backwards-compatible `codex-sandbox` spelling both fail closed.
MCP, screen recording, and computer-use stay on their separate explicit executor/MCP config paths.

[Decision Log]
- 목적과 의도: prevent caller-controlled Responses text from authorizing Cursor native local shell, filesystem, or fetch execution.
- 기존 구현 및 제약 조건: the adapter preserved top-level `instructions`, system messages, and developer messages, then treated a `sandbox_mode ... danger-full-access` prose marker as an exec allow signal in `codex-sandbox` mode.
- 검토한 주요 대안: keep marker-based authorization, require a future trustworthy attestation channel, or restrict authorization to server-local config.
- 선택한 방식: keep marker detection only as diagnostic/context and make `nativeLocalExec: "on"` the only non-legacy mode that enables built-in local exec; unset, `off`, and `codex-sandbox` all deny.
- 다른 대안 대신 이 방식을 선택한 이유: opencodex has no trustworthy per-request sandbox attestation in request text or headers, so any prompt-carried marker is spoofable by data-plane callers.
- 장점, 단점 및 영향: this closes prompt-to-native-exec escalation while preserving an explicit operator escape hatch; existing configs that relied on `codex-sandbox` must switch to `nativeLocalExec: "on"` for trusted local experiments.

## WebSocket

The WebSocket endpoint exists at `/v1/responses`, but discovery is opt-in:

```json
{
  "websockets": false
}
```

`websocketsEnabled(config)` is true only for an explicit `true`. When false, opencodex removes
`supports_websockets` from injected provider tables and routed catalog entries, keeping Codex on
HTTP/SSE. When true, Codex may use Responses WebSocket frames handled by `src/server/ws-bridge.ts`.
If Codex still attempts a WebSocket upgrade while the feature is disabled, `/v1/responses` rejects
the upgrade with 426 so Codex falls back to HTTP cleanly.

The endpoint handles `response.create`, ignores `response.processed`, supports warmup
`generate: false`, and feeds the same request pipeline as HTTP/SSE.

`ws-bridge.ts` preserves upstream `failed` and `incomplete` status values in the final WebSocket
frame rather than always emitting `response.completed`. If the response status is `failed`, a
`response.failed` frame is sent; otherwise `response.completed` carries through the original status.

## Heartbeat and stall deadline

The HTTP/SSE bridge emits `response.heartbeat` events during upstream silence to re-arm Codex's idle
timer (Codex's default `stream_idle_timeout` is 300 s and ANY SSE event re-arms it). Those
bridge-enqueued keepalive frames do NOT count as activity for the bridge's own watchdog: a bounded
stall deadline (default 300 s, configurable via `stallTimeoutSec`, checked on the 2 s heartbeat tick)
closes the stream with `response.incomplete` / `upstream_stall_timeout` and cancels the upstream
request if no real adapter events arrive. Adapter-yielded `{ type: "heartbeat" }` events DO reset
the watchdog.

The web-search loop requests `stream: true` for every routed-model iteration, but buffers the events
needed to decide whether to intercept a synthetic search call. Text explicitly phased as
`commentary` is safe to forward live because it cannot terminate the turn; this keeps Kiro's
progress visible. A Kiro stream EOF after user-facing text or reasoning gets one bounded completion
retry, because neither the upstream text event nor `END_TURN` / `STOP_SEQUENCE` reliably distinguishes
progress from a final answer. Those two clean-stop reasons prove only that the inference ended; on a
tool-enabled turn, only the private completion tool authorizes `final_answer`. Any other explicit
reason already terminated the inference upstream and is reported as a terminal state rather
than converted into another model request: output-token limits become continuable incomplete output,
context-window exhaustion becomes a non-retryable `context_length_exceeded` error, filtering becomes
filtered incomplete output, and a `TOOL_USE` without an actual tool call is a contradiction. Since
the stop reason arrives only at the end of the stream, `required`-mode assistant text is held inside
the adapter until a real tool call starts or the stream ends, then released as `commentary` unless a
private completion call supplied the final answer. Each held event yields a `heartbeat` in its place
so the stall watchdog stays armed. Synthetic search calls, real tool calls,
and terminal events remain buffered until the iteration validates. Only the first iteration's final
response headers/status and any 429 key rotations are handled eagerly. A failure before downstream
SSE starts returns non-2xx JSON; once headers have started the final response, a generation failure
is emitted as `response.failed` SSE.

Kiro transient HTTP 429 recovery is coordinated process-wide after the first throttle: healthy
traffic remains parallel, but throttled followers wait behind one abort-aware probe and share a
deadline that is re-checked after every sleep. Event-stream `ThrottlingException` records the same
deadline for the next client replay. Retries are bounded to three attempts; hard quota responses and
ordinary 5xx errors are not replayed. Completion fallback rebuilds only replayable text, preserves
the original user/tool-result turn for reasoning-only attempts, supplies neutral non-empty carriers
for empty tool output, and validates role alternation plus tool-use/result pairing before transport.

[Decision Log]
- 목적과 의도: Prevent Kiro progress from becoming a false final answer, reject invalid empty completion retries, and stop concurrent transient 429s from consuming independent retry budgets.
- 기존 구현 및 제약 조건: Kiro text has no trustworthy phase; stop metadata arrives only at stream end; the private completion tool is adapter-owned; normal parallel tool traffic must remain parallel; client cancellation must interrupt all waits.
- 검토한 주요 대안: Trust native `END_TURN`; infer completion from wording; serialize every Kiro request; leave throttling entirely to the client; manufacture empty assistant turns to preserve alternation.
- 선택한 방식: Require the private completion tool on tool-enabled turns, rebuild only valid replayable wire turns, validate the final conversation, and activate a shared cooldown plus single probe only after a transient throttle.
- 다른 대안 대신 이 방식을 선택한 이유: Native stop metadata has mislabeled progress, wording is language-dependent, global serialization harms healthy concurrency, client-only retries amplify bursts, and empty structural turns are rejected upstream.
- 장점, 단점 및 영향: Completion phase is deterministic and throttled concurrency recovers without a request storm; some clean Kiro stops pay one bounded validation call and an exactly repeated completion answer may be shown twice to preserve `final_answer` semantics.

Historical `web_search_call` output items from previous Responses turns are not converted into
assistant text. They are UI/search-cell evidence, not a replayable search result payload; turning
them into strings risks routed models echoing an internal marker or implying a current search ran
when the sidecar is unavailable. The active sidecar path is the only place that emits new
`web_search_call_begin` / `web_search_call_end` events.

Four independent clocks bound this path. `stallTimeoutSec` is the base bridge event-stall budget.
`connectTimeoutMs` (default 200 s) covers only DNS/TCP/TLS and the wait for final response headers,
not response-body generation. Config-file-only
`webSearchSidecar.routedModelStallTimeoutMs` (default 200 s, integer 1..2147483647) bounds continuous
raw response-byte inactivity for a routed-model iteration and resets on every non-empty byte.
`webSearchSidecar.timeoutMs` (default 60 s) separately bounds one hosted search request (lowered
from 200 s so an unavailable/limit-exhausted search backend degrades within ~1 min instead of
hanging the whole turn, #398). The
effective web-search bridge watchdog is
`max(base stall, connect timeout, routed-model stall, sidecar timeout) + 30 s` (230 s at defaults,
dominated by the routed-model stall clock),
with seam heartbeats between bounded units. None of these clocks is a total generation deadline.

## Reasoning and tool-result compatibility

Native OpenAI passthrough sanitizes routed reasoning history so `reasoning` input items do not send
non-empty `content` arrays to upstream models that reject them. Chat Completions bridging repairs
orphan `toolResult` messages by inserting a synthetic assistant `tool_call` before tool messages.
It also repairs the opposite direction (260718): an assistant `tool_calls` round left dangling —
by an intervening user/developer barrier or an interrupted turn — is closed by deferring barrier
messages until the round completes, reattaching real results to their original call occurrence,
and synthesizing explicit "no tool result was recorded" answers only when no real result exists
(Kimi/Moonshot 400 `ocx-mrqaiw05-269`; unit `devlog/_plan/260718_dangling_toolcall_hardening`).

Forward-mode OpenAI passthrough also repairs replayed `call_id` values longer than the Responses
API's 64-character limit. Sidechat/fork replay can namespace routed-provider ids beyond that limit,
so each oversized id and all matching call/output items receive the same deterministic,
request-local alias. Raw API-key continuations deliberately preserve ids because an output-only
continuation may reference a call stored upstream under its original id; proxy-expanded API-key
replays are explicit and receive the same repair.

These compatibility guards are covered by focused tests and should stay close to the adapters that
need them.

## Cursor Router optimization levels

Cursor Router's parameterized `default` model is represented in Codex by four catalog rows:
`cursor/auto` preserves Cursor's team/account default, while `cursor/auto-cost`,
`cursor/auto-balance`, and `cursor/auto-intelligence` make each optimization level explicit.
All four route to the `default` Cursor wire model. Explicit variants additionally populate
`AgentRunRequest.requested_model.parameters` with the `optimization` parameter; this is the same
parameterized-model channel used by current Cursor clients. Router rows are static capabilities and
must survive a live `GetUsableModels` response that omits `default`.

## Cursor active-context usage

Cursor's `conversationCheckpointUpdate.tokenDetails.usedTokens` is treated as the authoritative
absolute active-context size for a Cursor conversation. Some client-tool suspension turns must end
before Cursor emits a new checkpoint; those turns carry forward the last observed total for the same
Cursor conversation instead of reporting only the tiny current-turn output delta. The carry-forward
cache is process-local, numeric-only, bounded, and keyed by Cursor conversation id. Compaction
boundaries clear the carry so pre-compaction totals are not reused after Codex replaces history.
Historical compaction markers restored by `previous_response_id` expansion are acknowledged as a
replayed prefix and do not clear a fresh post-compaction checkpoint again on every later turn.
Compaction summarizer turns may still report their own checkpoint for that response, but their
pre-compaction checkpoint is not persisted for later carry-forward.

```text
[Decision Log]
- 목적과 의도: Keep Codex's visible "context left" indicator aligned with Cursor's active-context usage on client-tool turns that finalize before a checkpoint arrives.
- 기존 구현 및 제약 조건: Checkpoint turns reported totalTokens correctly, but no-checkpoint client-tool finalize fell back to output-only usage and could overwrite a meaningful prior total with values like 109 tokens.
- 검토한 주요 대안: Add a longer wait for late checkpoints; infer prior+output totals; store full prompt/history state; carry forward only the last numeric checkpoint per Cursor conversation.
- 선택한 방식: Carry forward the last numeric absolute checkpoint per Cursor conversation with bounded LRU/TTL storage, update it only from live checkpoint frames, and clear/suppress it once when a newly appended compaction boundary starts an epoch; previous_response replay provenance acknowledges historical markers without serializing private metadata upstream.
- 다른 대안 대신 이 방식을 선택한 이유: It fixes the UI regression without delaying tool turns, fabricating token growth, storing prompt/tool content, or repeatedly clearing valid post-compaction usage when historical markers replay; one-time compaction resets still prevent stale over-report when history is replaced.
- 장점, 단점 및 영향: Active-context reporting stays monotonic within an uncompacted Cursor conversation; no-checkpoint turns remain estimated; a process restart loses the numeric cache, and when neither a checkpoint nor a carry-forward is available the turn reports a request-local estimate derived from the same pruned payload sent to Cursor (#373 — reporting output-only usage made Codex read the context as nearly empty). Estimates are never persisted or promoted into checkpoint carry-forward; only live checkpoint frames update the cache.
```

## OpenRouter provider routing

The canonical OpenRouter `openai-chat` transport may carry optional provider-routing preferences
from `OcxProviderConfig.openRouterRouting`, with exact model-id replacements in
`modelOpenRouterRouting`. The adapter maps camel-case config to OpenRouter's request wire
(`order`, `only`, `allow_fallbacks`) after the Codex-facing routed slug has been decoded to the
native model id.

Preferences are accepted only for `https://openrouter.ai/api/v1` (an optional trailing slash is
equivalent) and the `openai-chat` adapter. Alternate ports, credentials, query strings, fragments,
lookalike hosts, and custom proxy paths fail validation. A model override replaces rather than
merges the provider-wide default, keeping precedence deterministic. With no preference configured,
the request body is byte-for-byte unchanged in this area and OpenRouter retains its default routing.

## Kimi Coding Plan prompt-cache affinity

The canonical `kimi` OAuth and `kimi-code` API-key presets opt into forwarding the internal
request's `prompt_cache_key` to Kimi's Chat Completions body. Kimi Code Plan documents a stable
session/task key as required to improve cache hit rates. The chat adapter never invents a key of
its own: it forwards what the request already carries — Codex's session key on
`/v1/responses`, or the session-scoped key the Claude `/v1/messages` inbound derives
(metadata.user_id hash, else the system+tools cohort hash) — and a request with no key stays
keyless. An explicit provider-level `promptCacheKey: false` continues to opt out, and the flag is
persisted through `providerConfigSeed`/`enrichProviderFromRegistry` for new configs; key-pool 429
rotation keeps it — along with every other registry backfill — because the retry inherits the
request's routed provider and swaps only the API key (`rotateProviderTransportOn429` in
src/providers/key-failover.ts). If an opted-in upstream rejects the field, OpenCodex does not strip it and retry or mutate the
saved configuration. Other OpenAI-compatible providers remain deny-by-default because strict
backends may reject the OpenAI-specific field.

## xAI Grok hardening (official Grok Build contract parity)

Grounded in the open-sourced official client (xai-org/grok-build); unit + evidence:
`devlog/_plan/260716_grok_build_hardening/`.

- **Reasoning folding:** the Responses parser folds `reasoning` items into the FOLLOWING
  assistant turn (`pendingReasoning` in `src/responses/parser.ts`) so the Grok chat wire carries
  ONE assistant message with `reasoning_content` — exact-prefix cache stability. Unsigned
  siblings newline-join; `ocxr1`-signed siblings stay separate parts (Anthropic replay keeps
  each signature on its own text); boundaries (user/tool-result/agent) clear pending state;
  call items fold pending reasoning into the same turn.
- **Grok CLI credential ownership:** `source:"local-cli"` xAI credentials re-read
  `~/.grok/auth.json` (read-only) before any refresh and adopt a newer usable generation with
  zero IdP calls (`shouldAdoptGrokGeneration`, later-expiresAt authority); an IdP refresh
  detaches the credential to `source:"oauth"`.
- **Two-lock refresh transaction:** per-provider+account intent lock held across the IdP
  exchange plus a short global store-write lock + async mutation funnel around every
  `auth.json` load-merge-persist (`src/oauth/store.ts`); generation-guarded persist
  (`expectedGeneration` → superseded adoption), conditional `needsReauth`, bounded jittered
  retry for transient token-endpoint failures.
- **Reactive 401 replay:** the serving recovery loop force-refreshes once (singleflight,
  generation-checked) and replays OAuth-backed xAI requests exactly once with a re-resolved
  transport; API-key/BYOK paths excluded (`src/server/responses.ts`).
- **Header parity:** per-attempt `x-grok-req-id` (fresh UUID inside the transport fetch
  wrapper), stable session/conv affinity headers, always-set User-Agent, and a single
  compatibility profile const for the Grok client version (`src/providers/xai-transport.ts`);
  `fetchWithHeaderTimeout` takes an executor so provider fetch wrappers stay inside the
  timeout race.

## Parallel tool calls (default-on for chat providers)

The openai-chat adapter buffers ALL streamed `tool_calls` deltas (keyed by `index`, falling back to
`id`, then last-seen) and flushes them as atomic start/delta/end sequences at the terminal signal.
This is required by the bridge's sequential tool-call contract and makes interleaved parallel
deltas, id-only-first-chunk continuations, and whole-chunk multi-call frames all safe.

Parallel tool calls are DEFAULT-ON for openai-chat providers: the adapter follows Codex's
request-level `parallel_tool_calls` bit (default true) and routed catalog entries advertise
`supports_parallel_tool_calls`. `OcxProviderConfig.parallelToolCalls: false` is the per-provider
opt-out (registry-seeded, router-backfilled; an explicit user value always wins). Non-chat
adapters advertise the catalog bit only on explicit `true`; cursor keeps its own special-casing.
Providers with flaky parallel streaming can be opted out individually. Evidence and provider
ledger: `devlog/_plan/260709_parallel_tool_calls/`.

## Reasoning display parity (hideThinkingSummary)

`hideThinkingSummary` (request reasoning summary absent/"none" — the routed catalog default) is
honored by BOTH reasoning paths: anthropic `thinking_delta` AND raw `reasoning_raw_delta`
(openai-chat `reasoning_content`, kiro tags). Hidden reasoning emits an envelope-only reasoning
item (`summary: []`, txt-only `ocxr1:` `encrypted_content`, no text deltas) — invisible in the
Codex app, so tool cells group like native models — while the text still round-trips for
`preserveReasoningContentModels` replay. Visible mode (summary "auto") keeps the raw
`content[reasoning_text]` shape. Diagnosis and codex-rs grouping evidence:
`devlog/_plan/260709_native_response_pattern/`.

## Chat-to-Responses message phase inference

Chat Completions streams do not carry the Responses `message.phase` field. The bridge keeps an
unphased live message provisional while its deltas arrive, then assigns `commentary` when a later
tool, search, reasoning, or assistant boundary proves that more work follows, and assigns
`final_answer` only when a clean terminal `done` closes the current message. Explicit adapter
phases always win. Streaming `output_item.added` remains unphased until that future boundary is
known; `output_item.done` and the terminal response snapshot carry the authoritative inferred phase
with the same item id. The batch/non-streaming bridge follows the same rule.

```text
[Decision Log]
- 목적과 의도: Prevent Codex App from rendering one bridged Chat Completions answer as both live commentary and a second persisted final answer.
- 기존 구현 및 제약 조건: openai-chat emits text deltas without phase, the bridge streamed them immediately, and whether text is pre-tool commentary or the terminal answer is unknowable until a later boundary arrives.
- 검토한 주요 대안: Mark every delta final_answer; mark every delta commentary; buffer the entire answer before emitting; infer phase only when the message is finalized.
- 선택한 방식: Keep the live added item provisional and infer commentary or final_answer at the authoritative close boundary, preserving explicit phases and item identity in done/completed output.
- 다른 대안 대신 이 방식을 선택한 이유: Eager defaults misclassify either tool preambles or final answers, while full buffering removes live streaming; close-time inference provides correct persisted semantics without adding latency.
- 장점, 단점 및 영향: Codex App receives a definitive phase for persisted bridged messages and avoids the duplicate-final rendering path; the provisional output_item.added event intentionally has no phase because its classification is not yet knowable.
```

## Upstream reset retry

`src/lib/upstream-retry.ts` guards upstream fetches against stale pooled keep-alive sockets
(Cloudflare closes idle connections; Bun's fetch reuses the dead socket and rejects with
`ECONNRESET` before any response bytes). `fetchWithResetRetry` retries only
connection-reset-shaped rejections (up to 3 total attempts, jittered backoff, warn-logged);
timeouts, aborts, `ECONNREFUSED`, HTTP error statuses, and mid-stream SSE failures are never
retried. Guarded paths: the ChatGPT passthrough and generic adapter fetch in
`src/server/responses.ts`, the vision/web-search sidecars, and the web-search loop's direct-fetch
fallback. Adapters with their own `fetchResponse` (kiro, cursor, google) keep their own retry
policies; kiro imports the shared abort/sleep helpers from this module.

## Sidecars

Web search and vision sidecars only run when the mode-aware `openai` forward ChatGPT authority
exists and the main request needs that capability.

There is one deterministic `openai` sidecar candidate; its current account mode owns credential
selection. API-key OpenAI is not a ChatGPT forward sidecar candidate.

| Sidecar | Default model | Activation |
| --- | --- | --- |
| `web-search/` | `gpt-5.6-luna` | Hosted `web_search` requested by a non-passthrough routed model. |
| `vision/` | `gpt-5.4-mini` | Input contains images for a model listed in `noVisionModels`. |

Sidecar failures must degrade to text markers or skipped capability, not abort the main request.
