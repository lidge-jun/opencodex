# Images Data Plane

Native result continuations and function-result injection follow [the mode-specific result and control contract](../transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](../transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

Vision preprocessing and image/video/search execution use the Responses
[core module ownership](../transports/responses.md#core-module-ownership). Hosted inference in
`src/images/loop.ts` follows [prepaid initial sends](../transports/responses-spend.md#prepaid-initial-sends):
fetchResponse/runTurn receives the adapter budget, while generic HTTP/WS reports final dispatch.
Async media producers own unsent cleanup before the streaming Response returns. Iteration cleanup
does not release a hosted hop while its runTurn producer is active; producer settlement releases any
unsent hop and clears only its matching pending reference. Standalone Images and direct callers
retain their existing behavior.

For a selected Claude CLI adapter, Responses request handling refuses instruction images and
file-backed image references in messages, agent messages or tool results before vision preprocessing or helper
dispatch. Other provider routes retain their own image handling; a usable image URL takes
precedence over a file ID. `tests/providers/claude-cli-client-http.test.ts` covers this boundary.

Mistral's registry entry in `src/providers/registry/entries-extended.ts` declares `zai-glm-5-3` native input as text-only, so registry enrichment enrolls that model in the enabled vision sidecar for existing configurations: the catalog advertises image attachments and request preprocessing sends GLM descriptions. Native Mistral vision models and explicit operator modalities retain precedence (`tests/vision/mistral-vision-sidecar.test.ts`).

A registry entry can also declare `inputModalities` for the whole provider. It covers ids the per-model maps do not list, such as models from live discovery, and a per-model declaration still wins. AI Stupid Level declares text, so an image for one of its pinned models is described or stripped instead of being sent to the router (`tests/providers/aistupidlevel-provider.test.ts`).

Final image/video client tool output follows the [explicit empty client-catalog boundary](../transports/responses-wire-shapes.md#declared-tool-membership-by-inbound-wire), after internal hosted operations and before client delivery or continuation state. Internal media execution retains its existing behavior.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

Hosted Responses image-tool eligibility uses the shared compatibility policy without a
Codex Spark exception; standalone Images retain the separate relay contract below. See
[Responses transport](../transports/responses.md#responses-httpsse).

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](../transports/responses-wire-shapes.md#passthrough-sse-stream-shapes-314).

Fetch-based Anthropic model iterations use the [thinking-signature recovery contract](../transports/anthropic-thinking-recovery.md#imagevideo-model-iterations), without repeating completed media calls.

Fetch-based Anthropic image bridge account recovery follows [the revoked-token contract](../providers/anthropic-account-pool.md#revoked-oauth-access-token-recovery), including output commitment and send-budget gates.

The [provider timeout policy](../transports/timeouts.md#provider-scoped-budgets) covers the
routed model iterations. Image and video generation use separate tool deadlines.

## xAI image and video models

The image bridge defaults to `grok-imagine-image-2.0`. For that model, OpenAI
`low`/`standard` maps to xAI `low`, `medium`/`high`/`hd` to `medium`, and
`auto` to `auto`; other models omit the quality field. Resolution mapping
remains independent. Edits through `callXaiImages` and the `/v1/images/edits` relay accept up to five
source URLs in caller order; both drop duplicate URLs first and then apply the limit, and the relay
checks it before resolving credentials or sending a request. The relay refuses the request when any
supplied source, an explicit `null` included, is not an https URL or a canonical base64 PNG/JPEG/WebP
data URL (for example a `file_id` or plain text) instead of dropping it. It checks the base64 alphabet
and padding directly in the supplied text. Every URL-bearing property of an `images[]` entry
(`image_url`, `image_url.url`, `url`) counts as a source. The `image_gen` bridge tool sends one
source. Safe upstream validation details are reconstructed from a
closed vocabulary of quality, field, resolution and bounded keyframe tokens;
unknown bodies and arbitrary upstream text never reach the caller.

The video bridge defaults to `grok-imagine-video-1.5-lite`. The 1.5 model supports
1080p, first and last frames, four keyframes and fourteen references capped at 720p;
Lite supports 1080p and a first frame, while classic supports 720p, a first frame
and seven references. Known models expose nine aspect ratios; unknown models retain
the legacy seven ratios and no image inputs. `parseVideoCallArgs` refuses, before any paid
call, every explicit setting the model cannot honour in the requested mode: an unsupported
resolution, aspect ratio or duration; 1080p with `last_frame`, `keyframes` or references
(reference-to-video stops at 720p); a keyframe outside the effective clip (8 s when no duration
is given) or two keyframes in the same 1/3-second slot; classic `image` plus references, and classic
references beyond 10 s; and an aspect ratio on plain image-to-video, which keeps the image's ratio.
Image inputs accept HTTPS and bounded
inline image data. A successful URL download records its original source URL in a
256-entry, one-hour process-local map. Artifact references resolve by exact path or
opaque ID without reading local files; they are forwarded only to the pinned xAI
video destination. Inline image results have no source URL and cannot be referenced.

## Video bridge destination

`planVideoBridge` in `src/images/plan.ts` decides where `video_gen` submit and poll requests go and
which key they carry. With `images.videoProvider` unset it keeps the historical xAI discovery and
pins the destination to the registry `xai` base URL, so an `xai` row's `baseUrl` override never
receives the key. `selectVideoProvider` resolves an explicit value: `xai` stays pinned, other
registry ids are refused, and a custom row contributes only its own `baseUrl` and API key after the
shared `providerDestinationConfigError` check (`allowPrivateNetwork` governs loopback and private
hosts). That plan-time check sees only address literals, so it is repeated at connect time:
`src/images/xai-video-client.ts` sends submit and poll through `providerOutboundPost` and
`providerOutboundGet` with the selected row's name, `allowPrivateNetwork`, `proxy` and `noProxy`
(carried on the plan's `VideoProviderAuth`). The outbound transport resolves the hostname, applies
the opt-in to every answer and pins the connection to a validated address, so a hostname that
resolves to loopback or private space never receives the key without the opt-in and a later DNS
answer cannot move it. Cleartext `http` is admitted only for `localhost` or a local address literal
on a row that sets `allowPrivateNetwork` itself; the poll GET passes `cleartextPolicy: "credentialed"`
so it obeys exactly the submit POST's cleartext rules. The pinned xAI destination is sent as `xai` with no
private-network opt-in, whatever the row carries, and only its registry `/videos/` URLs qualify for the
fake-IP TUN exception. The base URL may not carry userinfo, a query or a fragment, because the client appends
endpoint paths as strings, and a paused active key fails closed through `isProviderApiKeyPaused`.
A keychain reference the selected row does not own (`keychainReferenceBelongsToProvider`) is refused
for every destination, xAI included, before any secret is read. A recognizably xAI credential (an
`xai-` key, a key held by any row named `xai` in any case or pointing at an xAI host, or an
environment reference named for xAI or Grok) is refused unless the origin is HTTPS on an xAI host
and the default port. The limit is recognition: an arbitrary literal with none of those marks cannot
be attributed to xAI, which the guide tells operators.

An explicit value that cannot be used produces an unavailable plan: the `video_gen` tool is still
claimed, and `src/images/loop.ts` answers each call with the configuration error before any paid-call
accounting or network request. It never falls back to xAI. The submit and poll requests never follow
a redirect, keep the 1 MiB response cap, and the finished-video download keeps its public-HTTPS or
`data:` policy.
`tests/videos/video-provider.test.ts` covers both halves.

### Video wire

A row's `videoApi` picks the job wire (`src/images/video-wire.ts`); `resolveVideoProviderRow` copies
it onto `VideoProviderAuth` for custom rows only, so the pinned `xai` destination is always the xAI
wire. Absent or `"xai"` keeps `POST /videos/generations`, poll `GET /videos/{id}` and the public
`video.url` download above. `"openai"` selects `src/images/openai-video-client.ts`: `POST /videos`,
poll `GET /videos/{id}` (`queued`/`in_progress` keep polling, `completed` finishes with no URL), and
`GET /videos/{id}/content` streamed by `writeVideoResponseToArtifact` under the 200 MiB video cap and
per-turn budget. All three requests use the same `providerOutboundPost`/`providerOutboundGet` policy,
row name, key and `cleartextPolicy: "credentialed"` as the xAI wire, so the content download obeys the
submit POST's address, private-network, cleartext, proxy and no-redirect rules and never reaches another
host. Upstream job ids `.` and `..` are refused because they survive percent-encoding and would
collapse onto another path of the same host. Bridge arguments map to `seconds`, `size` and
`input_reference.image_url`; last frames, keyframes and reference images are refused before any send.
`tests/videos/video-openai-client.test.ts` and `tests/videos/video-openai-wire-bridge.test.ts` cover it.

## Public Videos

`src/server/videos.ts` serves `POST /v1/videos`, `GET /v1/videos/{id}` and `GET /v1/videos/{id}/content`
(`src/server/video-routes.ts` matches them; other methods and subpaths reach the JSON `/v1/*` 404).
The dispatcher applies the Images admission: draining refusal, `resolveApiAuth`, origin policy and a
request-log row (`usage.jsonl`); only the paid create takes an admitted turn slot and the inbound body
gate (`/v1/videos` is in `CONFIGURABLE_JSON_BODY_ROUTES`). The loopback listener and Remote Link admit
the same three shapes.

`model` of `<provider>/<model>` names a configured row and sends the bare model; a model without a slash goes
to `images.videoProvider`. A slash always means a provider prefix: an unknown prefix is refused before any
send, and a backend model id containing a slash is written behind its provider. A named row is final even
when it is refused.
The row must pass `resolveVideoProviderRow` and set `videoApi: "openai"`; nothing else serves these
routes and nothing falls back. A configured key's scope is checked with `admissionScopeDenial` against
that row and model before the create, and again before each poll and content request.

The returned job `id` is an AES-256-GCM handle (`src/server/video-handle.ts`, random nonce) that encrypts the provider, the
upstream id and the model, keyed by `video-handle-key` in the config directory (32 random bytes, mode
0600, recorded as owned, created exclusively). The authentication tag also covers, as associated data, the admission principal (admission kind,
configured key id and a SHA-256 of the exact presented secret, read with `resolveApiAuth`'s header precedence;
loopback is its own principal) without carrying it, so a handle presented by another key, under a replaced
or rotated secret on the same key id, edited, or minted under another signing key reads as `404` before any
credential is used. The key is read through an `O_NOFOLLOW` descriptor and refused unless it is a small
regular file owned by this user with no group/other bits; it is created in a private temporary file and
hard-linked into place, so a concurrent first use reads a complete key. Create loads the key and checks
that the provider (128 bytes) and model (256 bytes) fit a handle before the paid POST, so a key failure or
an unsealable handle sends nothing; nothing mints a process-local key. Poll and content re-resolve the
row from the handle and refuse it if it has since become unusable.

Create accepts JSON or multipart; a multipart `input_reference` PNG/JPEG/WebP file becomes the JSON
`input_reference.image_url` data URL, and other files are refused. One upstream attempt per create.
Upstream errors keep a 4xx status and only allowlisted detail; transport errors are redacted. Job
objects are rebuilt from an allowlist of closed-shape fields (status, progress, seconds, size, timestamps,
an error code and allowlisted detail or a generic message) with the handle as `id` and the model OCX sent;
upstream free text never passes through. Status and error code are relayed only from closed value lists, and
the handle is encrypted, so an upstream that echoes a credential as its job id, status or code cannot reflect it. Content is streamed with a
fixed media-type allowlist (anything else is `application/octet-stream`), `nosniff`, `no-store`, a
200 MiB cap, and only the `video`, `thumbnail` and `spritesheet` variants. List, delete, remix, edit
and extension are not served. Neither xAI nor OpenAI publishes a Responses-API video tool (xAI Responses
has `image_generation` only; OpenAI shut its Videos API down on 2026-09-24), so there is no Responses
video path. `tests/server/server-videos.test.ts` and `tests/server/video-handle.test.ts` cover it.

## Hosted Responses image display

For loopback-admitted Codex Responses clients,
`src/server/responses-hosted-image-display.ts` projects hosted `image_generation_call`
results into assistant messages with `phase: final_answer` and Markdown links to local
artifacts. The final phase keeps the image outside collapsible progress output.
`src/server/responses/passthrough-delivery.ts` applies this projection after continuation
observers, on the client branch only, for SSE, JSON and JSON synthesized into SSE.
The SSE projection emits consistent message lifecycle events and terminal snapshots,
suppresses replaced hosted-image progress frames, and adjusts numeric sequence numbers
for inserted or removed events, identically in both relay shapes.
Hosted items in the continuation cache retain their upstream representation; other
client rewrites keep their existing cache policy. Generic, remotely admitted and non-Responses
clients do not receive this filesystem projection. Individual image item events without
a string item id or a valid non-negative integer output index pass through without
allocating display state, so unidentified items cannot collide at a synthetic index.

Full-history assistant messages can replay the display Markdown without their generated
item ids. At Responses request preparation and at the remote compaction handler
(`src/server/responses/compact.ts`), exact generated links become opaque artifact HTTP
references before routing, helper dispatch and the upstream compact request. A link
matches when its target, as a plain path or `file://` URL with either separator and dot
segments resolved, names an `img-codex-<uuid>` image directly inside the current
artifact directory; on macOS and Windows the comparison also ignores letter case. This
does not read files and still applies after artifact pruning; unrelated paths, nested
directories, user messages and tool payloads retain their original content. Local display
uses filesystem links because remote Markdown media has a separate client safety gate;
HTTP references here are for upstream context, not a claim of desktop HTTP rendering.

Image data must pass the shared base64, format and byte-budget checks in
`src/images/artifacts.ts`. Files use random names, exclusive creation and mode 0600;
the artifact directory uses mode 0700 on creation. Per-response display state is capped
at 128 image items. Each retained identity/metadata envelope is limited to 64 KiB of
serialized UTF-8 JSON, with a 1 MiB aggregate allowance independent of image decoding.
Metadata is preserved unchanged within those bounds, and repeated lifecycle inputs are
validated even when display state already exists. Snapshot image identities are unique,
including against non-image items; explicit ids and fallback indices use separate namespaces.
Projected JSON and SSE lifecycle output is preflighted against the 32 MiB transport limit
before artifact writes or serialization, including metadata reused from earlier events.
The existing 50 MiB per-image and 100 MiB aggregate decoded limits still apply.
Refused display results return HTTP 502 before streaming or a failed SSE terminal after
streaming has started. Retention runs after the batch. Failed or invalid results produce a bounded
display message without reflecting payloads or filesystem errors. URL results and
partial-image previews are not downloaded or rendered by this projection.

## Standalone Images

Codex's local `image_gen.imagegen` tool makes a second Images request after the model calls it:
`POST /v1/images/generations` for generation or `POST /v1/images/edits` for reference-image edits.
These are standalone Images API routes, not the hosted Responses `image_generation` tool.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

`src/server/images.ts` uses the existing ChatGPT/OpenAI fallback unless `images.provider` explicitly
selects a custom API-key `openai-responses` provider. Explicit selection fails closed when the
provider is missing, disabled, registry-managed, incompatible, or lacks a usable key; it never
falls through to another paid upstream. The relay accepts bounded JSON generation and edit requests,
then forwards the decoded JSON without rewriting Codex's edit schema. Each paid Images POST receives
one upstream attempt; client cancellation aborts the upstream and pool-only failures update the
existing account-health state. Unknown Images subpaths still reach the JSON `/v1/*` 404 guard.

When the OpenAI credential path is unavailable or its authentication fails, `generations` (not
`edits`) may fall back to Google Antigravity if that provider has an unpaused account. A paused
active account returns an operator-actionable 403 `permission_error` and is not treated as a login failure. The fallback is
credential-driven: it exists so an image request reaches a real upstream answer rather than dying on a
local credential error, and it does not apply when the caller selected an explicit keyed custom
provider, because a configured pool owns its own authentication failure rather than hiding it behind
separately billed generation.

On non-loopback binds, data-plane authentication and origin policy cover both Images routes. An
explicit keyed Images provider accepts the proxy admission secret as either an OpenAI-style bearer
or `x-opencodex-api-key` because the provider key replaces caller authorization before fetch. The
ChatGPT Direct path still requires the dedicated header so its caller-owned upstream bearer remains
distinct. A proxy admission bearer leaves managed Pool eligible: Pool replaces it with its stored
credential, while Direct cannot forward it. A selected Pool authentication failure remains its own
error rather than falling through to a separately billed keyed provider. The outbound Images send
has one selected Authorization value, validated before the non-idempotent upstream POST.
Images providers, including the default OpenAI API fallback, can recover a stale paused active key
to an enabled pool entry inside the keyed branch. Audio and Live retain their strict snapshot
selector; only Images opts in to deferred recovery. A fully paused pool never dispatches one of its
keys. Implicit Images routing still tries eligible forward destinations and, for generations, CCA;
if no alternative handles the request, the paused-pool error is 403 `permission_error`. An eligible
alternative's own error retains its status, and an explicit custom provider remains fail-closed.
The keyed path never
enters `handleResponses`, so `src/server/images.ts` repeats
`selectProactiveApiKeyTransport` inside the keyed branch and rebuilds Authorization from the
returned clone rather than the earlier snapshot. Opt-in request-local round-robin uses that same selection seam and maps exhausted-key allocation to retryable 429. Genuine distributed 401/429 responses record the actual selected key cooldown, retaining Retry-After; synthetic replay refusals do not cool keys, and no paid POST is replayed. The standalone Images relay remains a single direct non-idempotent fetch outside the inference request-pacing executor; provider/key pacing limits do not cover that relay.

A configured key's model and provider scope applies to whichever destination the request settles
on: the ChatGPT forward account, the keyed provider, the xAI Imagine bridge, or the Antigravity
fallback. It is evaluated against that destination rather than the selector in the body, because
the bridge and the fallback choose their own model, and a body that names no model cannot satisfy
a model list. A refusal is the same 403 the scope returns on the routed path, and a key with no
scope reaches every destination as before. Forward candidates are filtered by that scope before any
stored Pool credential is resolved, refreshed or leased, so a forbidden key never reaches account
state; when no allowed destination remains, the 403 wins over the generic configuration 400.
Coverage lives in `tests/server/api-key-scope-images.test.ts` and
`tests/server/server-images-pool-admission.test.ts`.

The API-key `openai-responses` path also adapts Codex's private standalone image tool to the public
Responses tool surface. A complete `image_gen` namespace is lowered to safe
`image_gen__<inner-name>` function aliases even when no hosted image tool is present, because public
Responses runtimes may reserve the namespace itself and reject dotted function names. Native and
legacy dotted calls replayed in `body.input` are encoded to the same aliases. When any client
image-gen declaration is replaced by a usable `image_gen__<inner-name>` alias, the adapter also drops
hosted `image_generation` and deduplicates aliases in stable container order. Empty or malformed
namespaces do not remove the hosted fallback. Discovery and normalization span both top-level
`body.tools` and Codex Desktop Responses Lite `input[].type = "additional_tools"` containers.

For a model explicitly listed in `modelPreferHostedTools`, a non-forward Responses provider may opt
to remove colliding client `image_gen` declarations before this normalization and rewrite their
selectors to hosted `image_generation`, so a provider-reserved hosted tool takes precedence without
loosening a caller's tool-choice restriction. The opt-in is intentionally model-scoped: the default
alias path remains safest for ordinary public Responses endpoints. Each build records the replaced
caller identities in `AdapterRequest.hostedToolSubstitutions`, including an empty array when no
substitution applies. Streaming combo validation consumes the metadata from the actual send under
the [caller required-tool contract](../transports/responses-combo-boundaries.md#streaming-required-tool-contract),
so queued rebuilds can add or remove that authority without weakening the caller's requirement.

For OpenAI API virtual `-pro` models, preference lookup checks the selected public ID first and
uses the resolved base wire-model ID as a fallback. `modelAdapters` resolves the public ID first and
the base ID second; the second pass selects the final adapter, and configuration validation mirrors
both steps.

Client-facing API-key responses perform the inverse mapping: JSON output and SSE function-call
items restore `{ namespace: "image_gen", name: "<inner-name>" }` so Codex can dispatch the local
extension. When item-id repair is also enabled, both transforms compose in one SSE parse/stringify
pass (`src/server/sse-payload-rewrite.ts`) rather than chaining separate JS pull wrappers.
Ordinary inspection and continuation-cache branches keep the raw upstream alias, allowing stored
replays to return upstream without leaking a client-only namespace shape. Mandatory combo streams
share the authorized image restorer across judgment, client delivery and continuation observers;
the adapter encodes restored calls back to their wire aliases on replay. The image-gen layer itself
leaves malformed and empty image-gen namespaces untouched, but on a noncanonical route the general
namespace boundary above runs after it and lowers whatever remains, so no private group reaches the
wire. ChatGPT forward mode preserves the private namespace and hosted tool because that backend
understands their native semantics.

Per-model `modelReasoningSummaryDelivery` is a narrow compatibility layer for
`openai-responses` gateways whose summary capability is real but whose accepted delivery enum
differs from Codex. Presence advertises reasoning summaries in the routed catalog and rewrites only
an already-present `stream_options.reasoning_summary_delivery` at the adapter boundary. It never
injects summary generation into a request, and config validation rejects a delivery map that
conflicts with `modelSupportsReasoningSummaries: false` for the same model.

> Decision record: [ADR-0045](../decisions/ADR-0045-standalone-images.md)

Media bridge worker legs follow the [credit accounting contract](../dashboard-and-usage.md#usage-accounting)
when accumulating routed-model usage across iterations.

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../dashboard-and-usage.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

Connected CLI usage follows the [client-scoped hub usage contract](../dashboard-and-usage.md#usage-accounting); local management and account data remain separate.

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).
Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](../providers/openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../dashboard-and-usage.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](../providers/openai-accounts.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity.

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

CCA image-capable requests do not acquire the text-summary includeThoughts opt-in. See [Google summary boundary](../providers/google.md).

Claude replay carries [Go conversation affinity](inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Pool quota producers and account commands follow the [bounded raw-observation contract](../providers/openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

Account quota surfaces use [safe probe diagnostics](../transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary, and native Chat also honors explicit per-axis capability declarations; in the default `decide` mode an initial JEV null choice separately strips caller effort.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](../transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](../transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](../transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).

Image-bearing Codex history follows the selected model's existing compaction handling after a
[compaction routing override](../transports/responses-failover.md#compaction-routing-overrides).
