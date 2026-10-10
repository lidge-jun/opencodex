# xAI Grok Provider

Managed alias allocation retries nested-table reservation when rewriting references
cannot parse the first candidate. Other rewrite failures still refuse the update.

The Grok client picker forwards the `meta-muse` catalog's `max` effort through its existing managed-block export; this follows the [Muse provider contract](../providers-and-adapters.md).

Native result continuations and function-result injection follow [the mode-specific result and control contract](../transports/streaming-health.md#experimental-native-function-result-injection); this surface does not infer upstream support or alter its defaults.

Native steering follows [the shared WebSocket contract](../transports/streaming-health.md#experimental-native-mid-turn-steering); this surface's defaults remain unchanged.

xAI uses the same shared credential and delivery policies through the Responses
[core module ownership](../transports/responses.md#core-module-ownership). This surface retains its existing behavior.

One Responses capability is seeded for xAI alone: `requiresPairedResponsesToolResults`, which
answers a replayed tool call whose output never arrived. It is deliberately not the same flag as
`requiresAdjacentResponsesToolResults`, which xAI also carries and shares with the Kimi presets.
The contract for both, and the reason they do not collapse into one, is specified in
[chat-compat](./chat-compat.md); it is not restated here.

Native xAI Responses delivery strips a line-leading echoed tool-result or tool-call
envelope across split SSE text deltas. It is armed only when the request can have primed the echo:
a tool call or tool output in the input (a dangling call gets a synthetic output from the paired
tool-result repair), or a `previous_response_id` continuation whose history lives upstream
(`responsesRequestMayReplayToolOutput`); a first turn is delivered untouched. Only a line that is the marker alone
(`[Tool Result]`, `[Tool Error]`, `[tool_result]`, `[Tool Call]`, trailing whitespace allowed) or a
`[Tool call:` line counts (`isWholeLineEchoMarker` in `src/lib/tool-envelope-echo-filter.ts`): prose that
merely starts with a result or error marker, such as `[Tool Result] shows the build passed.`, is an
answer and reaches the client whole (`tests/adapters/tool-envelope-echo-whole-line.test.ts`). The same filter preserves leading prose and
normalizes text-done events, completed snapshots, non-streaming JSON, and the stored
continuation snapshot. It does not rotate an xAI upstream conversation.

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

Codex-native retirement is scoped to OpenAI catalog/quota evidence. Shared Responses handling
retains xAI provider behavior; see
[the catalog boundary](../catalog.md#shared-catalog).

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts. Response-attached WebSocket telemetry follows the [stage record identity contract](../transports/responses-wire-shapes.md#passthrough-sse-stream-shapes-314).

## Responses request compatibility

### Reasoning-model sampling parameters

xAI documents that `presencePenalty`, `frequencyPenalty` and `stop` "cannot be used with
reasoning models" and answers them with `400 invalid-argument`. The registry seeds the documented
reasoning ids (`grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-4.3`, `grok-4.20-multi-agent-0309`,
`grok-4.20-0309-reasoning`, `grok-build-0.1`) into `noPenaltyModels`, so the openai-chat
adapter, the Chat passthrough and the Responses passthrough omit `presence_penalty` / `frequency_penalty` for them.
`grok-4.20-0309-non-reasoning` and `grok-composer-2.5-fast` keep caller penalties.
Regression coverage: `tests/providers/xai/xai-transport.test.ts`
("xAI reasoning models reject penalty parameters").

The same ids are seeded into `noStopModels` (provider config, registry, derive fill, resolved
policy and `routedProviderConfig`, like `noTopPModels`). The openai-chat adapter and the Chat
passthrough omit `stop`, and the Responses passthrough drops a `stop` that Claude inbound
translated from `stop_sequences` (`stripRejectedSamplingParams` in
`src/adapters/openai-responses/request-strips.ts`), because `grok-4.20-multi-agent-0309` has only
the Responses wire. Claude Code auto-mode always sends `stop_sequences`; forwarding it made its
classifier mark Grok temporarily unavailable. Regression coverage:
`tests/providers/xai/xai-no-stop.test.ts`.

`grok-4.7-build-fast` joins these lists, `preserveReasoningContentModels`, the grok-4.7
context/effort/vision rows and grok-4.7's OAuth Responses wire default, because xAI documents Grok
4.7 Fast as the same model on faster infrastructure (Cursor and Grok Build only, not the public xAI
API) and the 2026-09-30 probe confirmed identical capabilities
(`devlog/_fin/260930_grok47_build_unify/010_probe-evidence.md`). It stays out of the lineup seed and
`modelSupportsServiceTier`, and it is not published as a row of its own; see "Grok 4.7 Fast lane" below.
Regression coverage: `tests/providers/xai/grok-47-build-fast-metadata.test.ts`.

### Policy-refusal 403

xAI sometimes refuses a turn with HTTP 403 and a bare refusal sentence (`I can't help with that
request.`) instead of HTTP 200 with `finish_reason: content_filter`. Codex would treat the 403 as a
transport failure and retry the unrecorded turn. `isUpstreamPolicyRefusalMessage` matches only the
exact normalized phrases after unwrapping JSON and `Provider error 403:` bodies; plan, credit and
model-access wording stays an error, and those xAI cues are checked by the refusal matcher alone so
the global subscription classifier is unchanged. The rewrite itself is owned by
[policy-refusal.ts](../transports/responses.md#core-module-ownership). Regression coverage:
`tests/server/errors-adapter-failure.test.ts` ("xAI policy-refusal 403").

`src/adapters/xai-web-search.ts` omits `auto`/`none` tool selection after normalization if no tools
remain in either the top-level catalog or `additional_tools`. Cached-only search removal follows
the same rule. When an omitted `none` selector stated the turn's only client-call prohibition,
the explicit empty `tools` catalog preserves that denial. Available forced function selectors remain intact.
The whole web-search normalization also runs for any `grok-*` model whose final request URL is
exactly `https://opencode.ai/zen/go/v1/responses`: OpenCode Go relays Grok to xAI and returns xAI's
schema errors verbatim (`external_web_access` and `search_context_size` -> 400,
`web_search_preview` -> 422), while sibling Go models accept the OpenAI fields and keep them.
Regression coverage: `tests/providers/opencode-go-grok46-responses.test.ts`.
`src/adapters/openai-responses/request-strips.ts` preserves valid xAI custom-call item ids and
repairs missing/invalid ids from a stable digest of the JSON-encoded `(call_id, name, input)`
string tuple. Incomplete tuples remain unchanged, and call/result pairing uses the original call id.
Other destinations retain their existing item-id behavior, including OpenAI `store:false`.

## xAI Grok hardening (official Grok Build contract parity)

Grok's Responses path shares `src/responses/apply-patch-envelope.ts` for freeform restoration.
The declared `input` field remains authoritative; alternate-field and outer-fence recovery is
limited to unambiguous bare or `default.`-prefixed `exec` and `apply_patch` calls and does not rewrite foreign grammars.

Grounded in the open-sourced official client (xai-org/grok-build); unit + evidence:
`devlog/_fin/260716_grok_build_hardening/`.

The shared Responses path follows the [bounded multipart recovery contract](../subagents.md#multipart-encrypted-task-recovery); credential admission and retry policy remain unchanged.

- **Reasoning folding:** the Responses parser folds `reasoning` items into the FOLLOWING
  assistant turn (`pendingReasoning` in `src/responses/parser.ts`) so the Grok chat wire carries
  ONE assistant message with `reasoning_content` ??exact-prefix cache stability. Unsigned
  siblings newline-join; `ocxr1`-signed siblings stay separate parts (Anthropic replay keeps
  each signature on its own text); boundaries (user/tool-result/agent) clear pending state;
  call items fold pending reasoning into the same turn.
- **Grok CLI credential ownership:** `source:"local-cli"` xAI credentials re-read
  `~/.grok/auth.json` (read-only) before any refresh and adopt a newer usable generation with
  zero IdP calls (`shouldAdoptGrokGeneration`, later-expiresAt authority); an IdP refresh
  detaches the credential to `source:"oauth"`.
- **Browser login callback:** Grok's browser login uses the shared `OAuthCallbackFlow` listener
  on a per-provider FIXED loopback port, so every response it sends closes its connection. A
  retired flow that kept a pooled socket would capture the NEXT login's callback and reject it
  as a state mismatch; see `src/oauth/callback-server.ts`.
  Provider token-body budgets are separate from this shared callback lifetime. The
  [OrcaRouter bounded key-exchange contract](../transports/inventory.md#bounded-response-ingestion-and-orcarouter-login)
  is owned by its login consumer and does not impose that budget on Grok token grants.
- **Two-lock refresh transaction:** per-provider+account intent lock held across the IdP
  exchange plus a short global store-write lock + async mutation funnel around every
  `auth.json` load-merge-persist (`src/oauth/store.ts`); generation-guarded persist
  (`expectedGeneration` ??superseded adoption), conditional `needsReauth`, bounded jittered
  retry for transient token-endpoint failures.
  Newly created legacy-store recovery copies follow the [backup ownership contract](../config.md#restore);
  an ownership-registration failure (a `false` return or thrown error) warns without discarding downgrade recovery.
- **Reactive 401 replay:** both the adapter recovery loop and native Responses passthrough branch
  force-refresh once (singleflight, generation-checked) and replay OAuth-backed xAI requests
  exactly once with a re-resolved transport; API-key/BYOK paths are excluded
  (`src/server/responses/core.ts`).
- **Generic pool threshold:** xAI's generic OAuth fill-first selector in
  `src/oauth/generic-account-failover.ts` treats a non-positive threshold as disabling proactive
  usage-based account changes; reactive recovery remains independent.
- **Header parity:** per-attempt `x-grok-req-id` (fresh UUID inside the transport fetch
  wrapper), stable session/conv affinity headers, always-set User-Agent, and a single
  compatibility profile const for the Grok client version (`src/providers/xai-transport.ts`);
  `fetchWithHeaderTimeout` takes an executor so provider fetch wrappers stay inside the
  timeout race.

The generated Grok client marker also enables a client-facing sparse-terminal repair for native
Responses streams. Grok Build renders text deltas immediately but derives its durable assistant
turn from `response.completed.response.output`; an OpenAI-compatible stream may instead place the
complete items in `response.output_item.done` and finish with an explicit empty output array. For
that marked client only, OpenCodex uses a terminal-only tracker: it retains bounded, contiguous,
unique and semantically valid raw completed items, then backfills a missing or empty terminal
snapshot. It never promotes locally synthesized or merely repaired items. Unmarked callers continue
to treat an explicit empty array as authoritative. Within this marked client-facing repair,
malformed, gapped, oversized, contradictory, failed, or incomplete streams stay fail-closed.

The same marked client-facing chain normalizes lexical floating-point `response.created_at` and
`response.completed_at` values to their JSON integer spelling only for `response.*` events whose
nested values are nonnegative safe integers. Missing, malformed, fractional, negative, unsafe, and
byte-identical payloads pass through unchanged.

> Decision record: [ADR-0059](../decisions/ADR-0059-xai-grok-hardening-official-grok-build-contract.md)

### Grok Reset Coupons (Billing API Parity)

- **Upstream RPCs:** `prod_mc_billing.ConsumerUiSvc/GetRemainingResets` (inspection) and `prod_mc_billing.ConsumerUiSvc/RedeemReset` (redemption).
- **Transport:** Binary gRPC-Web over HTTP/1.1 or HTTP/2 with 5-byte frame envelope (`0x00` data / `0x80` trailers) and protobuf wire format. `src/grok/reset-coupons.ts` requires an explicit valid gRPC status in the trailer for both inspection and redemption; HTTP 200, data-only, missing or malformed status does not establish success. Plain JSON is rejected with empty responses upstream.
- **Authentication:** `Authorization: Bearer <xai OIDC access token>` + `X-XAI-Token-Auth: xai-grok-cli`. No cookies required.
- **Safety & Idempotency:** `src/grok/reset-coupon-ledger.ts` serializes open, claim, and settlement under the shared config mutation transaction. A durable atomic `open` → `attempted` claim admits exactly one request before upstream dispatch. The streamed atomic writer flushes the temporary file before rename; the coupon ledger additionally requires a successful POSIX parent-directory flush before admitting dispatch. A flush error refuses redemption even if the renamed claim is already visible. Windows retains mandatory file flush and the shared writer’s platform limitation for directory flush. Version-two opens prove pre-dispatch state. Version-one `open` records and `failed` records with `redeem_failed` are read as uncertain attempts; definitive terminal outcomes retain their replay. Subsequent writes use version two. Settlement checks the expected state, account and token in the same transaction: preflight refusals settle only `open`, confirmed redemption settles only `attempted`, and terminal records are immutable. A late refusal inspects the winner in the same config mutation transaction: an identity-matching definitive terminal result is replayed as HTTP 200 with its original code, token and settlement timestamp; an unresolved or identity-mismatched winner returns `operation_state_changed`. Neither path replaces the winner’s record. A lost atomic claim reads the durable winner under the config mutation transaction: a matching definitive outcome uses the same replay response; an unresolved or identity-mismatched operation, or a failed read of the winner, returns `attempt_in_progress`, without another redemption. After a confirmed redemption, only a `ConfigMutationLockError` caused by `SQLITE_BUSY` permits up to five local settlement attempts with four 20 ms waits; any other error or a changed state/account/token stops immediately. Redemption is never retried. Existing operations replay even at the 256-record capacity; records expire after the 30-day retention window. Unreadable or malformed ledgers refuse new dispatch and preserve their bytes. Supplied token IDs are validated as non-empty strings before credential reads or journal opening. Within retention, omitted-account same-ID retries recover the recorded account; executable open retries without a token reuse the recorded token. Explicit identity mismatches still refuse.
- **Uncertain attempts:** An unconfirmed transport response retains an `attempted` claim and returns HTTP 502 with `attempt_unresolved` and the effective operation ID. A failed settlement never permits dispatch again: the claim or a terminal record already made visible by rename remains the retry authority. A recent attempt returns `attempt_in_progress`; after 90 seconds, reconciliation inspects the remaining-reset list without redeeming again. Every unconfirmed attempt stays `attempt_unresolved`, whether its token is listed, missing, expired or of unknown validity. Availability cannot identify which request consumed a coupon. Only a confirmed redemption response establishes success; neither a stale timestamp nor a listed token proves the original request cannot still complete.
- **Surfaces:** `ocx account grok-reset-coupons` in the terminal, and the dashboard at Providers > xAI Grok > Accounts, where each OAuth row carries a ticket badge with its remaining count and opens a redemption dialog (`gui/src/hooks/useGrokResetCoupons.ts`, `gui/src/components/provider-workspace/GrokResetCoupons.tsx`). The dashboard reads one `GET /api/grok/reset-coupons` per account with at most three in flight, always sends an explicit `tokenId` and a client-minted `operationId`, and treats redemption truth as the settled `code` rather than HTTP 200; a replayed *failure* returns 200 with `replayed: true`. The CLI also mints its operation ID before sending and includes same-ID retry guidance on uncertain delivery, including `operation_state_changed` responses. After transport rejection, an unknown-outcome response, or a concurrent confirmation while the original POST is pending, the dashboard retains the original attempt in its account controller across modal close/reopen. An `operation_state_changed` response retains the original attempt as uncertain. The modal derives uncertainty from the controller so a confirmed success or definitive failure retires the active attempt and clears the matching hold before any refresh GET is awaited, including in a reopened modal. Completion of an older request cannot retire a newer active attempt. Refresh is GET-only and does not authorize another consume POST. A definitive failure clears only the matching speculative pending hold, allowing a new explicitly confirmed operation; real unknown outcomes remain held. This controller state lasts while the hook remains mounted; it is not browser-restart persistence. The backend preserves an uncertain attempt and never blindly dispatches the same operation again.

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](../dashboard-and-usage.md#usage-accounting); readable totals are not represented as a complete ledger. Upstream API-key usage follows the [physical-attempt account attribution contract](../dashboard-and-usage.md#upstream-key-account-attribution), independently of subscription quota observations.

Connected CLI usage follows the [client-scoped hub usage contract](../dashboard-and-usage.md#usage-accounting); local management and account data remain separate.

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](../remote-workspace.md) owns that integration.

Listener startup diagnostics follow [the runtime lifecycle contract](../runtime.md#lifecycle); malformed optional listener blocks follow [config loading](../config.md#config-surface).
Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

Account-scoped OAuth quota remains display evidence for provider-level Combo selection; it does not acquire single-key inference-veto authority. See [scoped provider quota](../runtime.md#scoped-provider-quota-for-combo-selection).

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../dashboard-and-usage.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](openai-accounts.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity.

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

Grok chat raw reasoning uses content-channel output with an empty summary; hidden replay envelopes retain continuation text. Native Responses content is not promoted to summaries. See [chat compatibility](chat-compat.md).

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Devin CLI credential path composition in `src/oauth/devin/cli-import.ts` follows the selected platform: Windows uses Win32 APPDATA paths, other platforms use POSIX XDG-data paths. The explicit absolute override remains verbatim; credential parsing and login behavior are unchanged.

[Anthropic seed image metadata](../runtime.md#capability-aware-image-admission) is provider-scoped; xAI model metadata and transport behavior remain unchanged.

Provider-scoped catalog hints remain isolated by provider in `src/providers/registry/entries-core.ts`. The
OpenCode Go `deepseek-v4.1-flash` 1,048,576-token context hint does not change xAI model metadata or
transport behavior.
The first-party DeepSeek `deepseek-flash` native `text`/`image` declaration is likewise scoped to
the DeepSeek provider and does not alter xAI metadata or transport behavior; explicit capability
overrides remain authoritative. First-party `deepseek-chat`, `deepseek-reasoner`, and
`deepseek-v4-flash` remain sidecar-backed by default. The Zen tiers (`opencode-zen`, `opencode-free`) could not be measured (HTTP 402) and keep their existing classifications.
OpenCode Go's `deepseek-v4.1-flash` was reclassified as native vision on 2026-09-19 (probed on
that gateway); its sibling `deepseek-v4-flash` stays sidecar-backed. None of this alters xAI
metadata or routing.
The Crusoe fixed-key registry row, discovery predicate, effort ladder, and input-modality map are
also provider-scoped and do not alter xAI model metadata, OAuth routing, or wire behavior.

The Opper pool seeds in `src/providers/registry/entries-extended.ts` are also provider-scoped and
do not alter xAI discovery, model metadata, or transport behavior.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary, and native Chat capability stripping applies only for an explicit empty declaration or no-reasoning model; an initial JEV null choice separately strips caller effort.

The [explicit model-capability contract](../config.md#explicit-per-model-capability-declarations) preserves operator declarations through provider storage and catalog capture; it does not infer upstream capability or change this surface's routing behavior.

Provider-scoped approval reviewer settings are projected by the [catalog owner](../catalog.md#provider-scoped-approval-reviewer); this surface retains its existing routing, transport and account-selection behavior.

Renamed fixed-key providers receive [missing reasoning metadata](../catalog.md#renamed-destination-reasoning-metadata) during derivation; explicit per-model entries and provider defaults retain precedence.

### OAuth Fast Tier (Priority Processing)

xAI's Priority Processing (`service_tier: "priority"` on Chat Completions and Responses,
documented for the API-key product) is honored by the Grok OAuth subscription gateway on a
probed model set (live probes 2026-09-13 and 2026-09-23, `devlog/_fin/260913_xai_oauth_fast/`
and `devlog/_fin/260923_grok47_parity/010_probe-evidence.md`): grok-4.7, grok-4.6,
grok-4.5, grok-4.3, grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning, grok-build-0.1 and
grok-composer-2.5-fast each echoed `priority` upstream. The registry entry classifies exactly
that set in `modelSupportsServiceTier` and declares `chatServiceTier: true`, so the OAuth lane
resolves Fast-eligible per model: `--fast` synthetic rows publish, `fastMode` can force the
tier, and a caller-sent tier forwards (the Codex fast-toggle path). grok-4.20-multi-agent-0309
is deliberately excluded ??the gateway answers `service_tier: "default"` when sent
`priority`, so it keeps `forwardCallerServiceTier: false` and publishes no fast row.
Classification reaches saved configs through the fill-only enrich backfill
(`src/providers/derive.ts`); an explicit config value always wins, and a config saved while
the lane is live keeps it as an explicit value even if the registry default later changes.

#### Grok 4.7 Fast lane (OAuth)

The Grok OAuth gateway lists `grok-4.7` and `grok-4.7-build-fast` as two models. They are one model on
two serving lanes: the 2026-09-30 probe measured build-fast 1.5-1.7x faster end to end, while
`priority` on grok-4.7 bought no measurable speed and cost ~5.9x the ticks per output token
(build-fast costs ~2x). So the catalog shows one row. `shouldExposeProviderModel`
(`src/codex/catalog/model-visibility.ts`) hides build-fast from discovery, and a Fast grok-4.7
request on the OAuth lane (`--fast` row, caller `priority`, or `fastMode`) is serialized as
`grok-4.7-build-fast` with no tier (`src/providers/xai-fast-model.ts`, applied at the tail of
`applyFinalRouteRequestNormalization`, so Responses, WebSocket, Chat, Claude, combo children and routed
compaction all take it). The logical id stays grok-4.7 for routing, effort, sampling strips, operator
overrides and the usage attempt. Only the serialized `model` changes (`raw.model` for the passthrough,
`parsed._wireModelOverride` for openai-chat), and `logCtx.wireModel` records it. The scope check treats
that wire override as the billed destination, so a data-plane key must authorize
`grok-4.7-build-fast` before the lane is dispatched even though routing and receipts retain grok-4.7.
Initial admission on Responses, Chat, Messages and routed compact previews the same Fast decision
and operator wire policy as final serialization; a Fast-only scope needs no additional grant for the logical id. Plain turns, disabled Fast, key auth
and explicit operator Fast wires still require their actual destination, without an implied lane grant.
The attempt's tier outcome uses the internal `model-variant` Fast wire kind (applied, assumed). Its
`responseTierAuthoritative:false` keeps a `service_tier` echo from confirming or denying it, and from
unlocking priority pricing, so estimates stay at grok-4.7's standard rate. The passthrough relays the
upstream `model` echo (`grok-4.7-build-fast`, as plain turns already relay `grok-4.7-build`), while
translated deliveries answer with `grok-4.7`. Key auth never switches lanes, because build-fast is not
on the public API, so it keeps priority processing. An explicit `xai/grok-4.7-build-fast` request, a
`retainModels` entry or a combo target keeps working and stays visible where the user configured it.
Regression coverage: `tests/providers/xai/grok-47-fast-model.test.ts`,
`tests/providers/xai/grok-47-fast-model-wire.test.ts`.

The upstream tier echo relays to the client on every Chat Completions delivery shape
(`src/chat/outbound.ts` projections and `src/server/chat-native-sse.ts` chunks), matching
what the Responses lane already relayed for responses-wire upstreams; the responses-lane
assembly for chat-wire upstreams tracks the echo in attempt telemetry only.
Pool quota producers and account commands follow the [bounded raw-observation contract](openai-accounts.md#bounded-pool-quota-observations), separate from the latest display snapshot and capacity estimates.

Account quota surfaces use [safe probe diagnostics](../transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.

Live sideband admission and its bounded upstream handshake follow the [runtime contract](../runtime.md#live-sideband-handshake); the ordinary Responses WebSocket exchange remains separate.

Translated audio/file admission follows the [final-adapter input contract](../adapters/registry.md#untranslated-input-media); native raw passthrough remains separate.

Shared response-log retention and native SSE inspection pacing follow the [bounded inspection contract](../transports/byte-accounting.md#response-log-inspection); other subsystem behavior remains unchanged.

Native steering retains fixed phase deadlines and reconciled replay output; see the [steering stability contract](../transports/streaming-health.md#steering-deadlines-and-replay-completeness).

Native steering generation overrides, explicit public-API eligibility and the consent-gated wire probe follow the [shared control contract](../transports/streaming-health.md#steering-settings-public-api-and-diagnostic-probe); this owner does not change routing or execute diagnostic tools.

Shared startup provider-id migration preserves the account binding between configuration and OAuth credentials; see the [runtime contract](../runtime.md).

Dashboard Fast-row persistence and client refresh follow the [Fast selector rows setting contract](../gui-and-management-api.md#fast-selector-rows-setting).

Routed Grok compaction uses the existing adapter and summary contract after a same-provider
[compaction routing model override](../transports/responses-failover.md#compaction-routing-overrides); a
cross-provider override runs the portable summarizer on the selected provider instead.
