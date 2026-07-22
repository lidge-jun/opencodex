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

## Standalone Images

Codex's local `image_gen.imagegen` tool makes a second Images request after the model calls it:
`POST /v1/images/generations` for generation or `POST /v1/images/edits` for reference-image edits.
These are standalone Images API routes, not the hosted Responses `image_generation` tool.

`src/server/images.ts` selects only an enabled forward-mode `openai-responses` provider, resolves
the same thread-affined Codex account as Responses, and relays the bounded opaque body without
rewriting Codex's JSON edit schema or a compatible multipart body. Each paid Images POST receives
one upstream attempt; client cancellation aborts the upstream and pool-only failures update the
existing account-health state. Unknown Images subpaths still reach the JSON `/v1/*` 404 guard.

On non-loopback binds, data-plane authentication and origin policy cover both Images routes just as
they cover `/v1/responses`; clients must send the configured `x-opencodex-api-key`.

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

The web-search loop requests `stream: true` for every routed-model iteration, but fully buffers its
semantic adapter events internally so synthetic search calls and preliminary answers never leak to
the client. Only the first iteration's final response headers/status and any 429 key rotations are
handled eagerly. A failure before downstream SSE starts returns non-2xx JSON; once headers have
started the final response, a generation failure is emitted as `response.failed` SSE.

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
`webSearchSidecar.timeoutMs` (default 200 s) separately bounds one hosted search request. The
effective web-search bridge watchdog is
`max(base stall, connect timeout, routed-model stall, sidecar timeout) + 30 s` (230 s at defaults),
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
- 장점, 단점 및 영향: Active-context reporting stays monotonic within an uncompacted Cursor conversation; no-checkpoint turns remain estimated; a process restart loses the numeric cache and safely falls back to current-turn usage until the next checkpoint.
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
