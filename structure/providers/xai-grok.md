# xAI Grok Provider

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

The opt-in key-auth Responses hosted-search bridge uses the shared
[continuation binding contract](../transports/responses.md#hosted-search-continuation-binding).

## xAI Grok hardening (official Grok Build contract parity)

Grounded in the open-sourced official client (xai-org/grok-build); unit + evidence:
`devlog/_fin/260716_grok_build_hardening/`.

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
- **Browser login callback:** Grok's browser login uses the shared `OAuthCallbackFlow` listener
  on a per-provider FIXED loopback port, so every response it sends closes its connection. A
  retired flow that kept a pooled socket would capture the NEXT login's callback and reject it
  as a state mismatch; see `src/oauth/callback-server.ts`.
- **Two-lock refresh transaction:** per-provider+account intent lock held across the IdP
  exchange plus a short global store-write lock + async mutation funnel around every
  `auth.json` load-merge-persist (`src/oauth/store.ts`); generation-guarded persist
  (`expectedGeneration` → superseded adoption), conditional `needsReauth`, bounded jittered
  retry for transient token-endpoint failures.
- **Reactive 401 replay:** both the adapter recovery loop and native Responses passthrough branch
  force-refresh once (singleflight, generation-checked) and replay OAuth-backed xAI requests
  exactly once with a re-resolved transport; API-key/BYOK paths are excluded
  (`src/server/responses/core.ts`).
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

> Decision record: [ADR-0059](../decisions/ADR-0059-xai-grok-hardening-official-grok-build-contract.md)

### Grok Reset Coupons (Billing API Parity)

- **Upstream RPCs:** `prod_mc_billing.ConsumerUiSvc/GetRemainingResets` (inspection) and `prod_mc_billing.ConsumerUiSvc/RedeemReset` (redemption).
- **Transport:** Binary gRPC-Web over HTTP/1.1 or HTTP/2 with 5-byte frame envelope (`0x00` data / `0x80` trailers) and protobuf wire format. Plain JSON is rejected with empty responses upstream.
- **Authentication:** `Authorization: Bearer <xai OIDC access token>` + `X-XAI-Token-Auth: xai-grok-cli`. No cookies required.
- **Safety & Idempotency:** Managed via `src/grok/reset-coupon-ledger.ts` using UUIDv4 operation tracking before upstream dispatch to prevent duplicate consumption during network flakes.
- **Surfaces:** `ocx account grok-reset-coupons` in the terminal, and the dashboard at Providers > xAI Grok > Accounts, where each OAuth row carries a ticket badge with its remaining count and opens a redemption dialog (`gui/src/hooks/useGrokResetCoupons.ts`, `gui/src/components/provider-workspace/GrokResetCoupons.tsx`). The dashboard reads one `GET /api/grok/reset-coupons` per account with at most three in flight, always sends an explicit `tokenId` and a client-minted `operationId`, and treats redemption truth as the settled `code` rather than HTTP 200 — a replayed *failure* returns 200 with `replayed: true`. After a request times out it issues no further consume call, because a redemption whose ledger record is still `open` re-executes.

Chat helper admission in `src/server/responses/core.ts` follows the
[deferred stored-main contract](openai-tiers.md): only a needed Direct OpenAI helper
claims stored main, after terminal vision, routed vision and search exclusions.

Account-scoped OAuth quota remains display evidence for provider-level Combo selection; it does not acquire single-key inference-veto authority. See [scoped provider quota](../runtime.md#scoped-provider-quota-for-combo-selection).

The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](../gui-and-management-api.md#combo-editor-routing-quota).

Optional Codex transport-hint suppression is scoped to canonical Responses client output;
its defaults and exclusions are owned by [Responses transport](../transports/responses.md).

Grok chat raw reasoning uses content-channel output with an empty summary; hidden replay envelopes retain continuation text. Native Responses content is not promoted to summaries. See [chat compatibility](chat-compat.md).

Claude replay carries [Go conversation affinity](../data-planes/inbound-compat.md#claude-affinity-at-final-go-dispatch)
privately to final dispatch; preliminary route selection does not inject Go-only headers.

Devin CLI credential path composition in `src/oauth/devin-cli.ts` follows the selected platform: Windows uses Win32 APPDATA paths, other platforms use POSIX XDG-data paths. The explicit absolute override remains verbatim; credential parsing and login behavior are unchanged.

Native Chat applies qualifying effort ceilings independently of model pins; pin selection precedes the cap and only pins or cap rewrites enter wire mapping. The [catalog effort contract](../catalog.md#ultra-reasoning-level) records the V1/compaction exemptions and caller-preservation boundary.

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary, and native Chat removes effort only for an explicit empty declaration or no-reasoning model.

### OAuth Fast Tier (Priority Processing)

xAI's Priority Processing (`service_tier: "priority"` on Chat Completions and Responses,
documented for the API-key product) is honored by the Grok OAuth subscription gateway on a
probed model set (live probe 2026-09-13, `devlog/_fin/260913_xai_oauth_fast/`): grok-4.6,
grok-4.5, grok-4.3, grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning, grok-build-0.1 and
grok-composer-2.5-fast each echoed `priority` upstream. The registry entry classifies exactly
that set in `modelSupportsServiceTier` and declares `chatServiceTier: true`, so the OAuth lane
resolves Fast-eligible per model: `--fast` synthetic rows publish, `fastMode` can force the
tier, and a caller-sent tier forwards (the Codex fast-toggle path). grok-4.20-multi-agent-0309
is deliberately excluded — the gateway answers `service_tier: "default"` when sent
`priority`, so it keeps `forwardCallerServiceTier: false` and publishes no fast row.
Classification reaches saved configs through the fill-only enrich backfill
(`src/providers/derive.ts`); an explicit config value always wins, and a config saved while
the lane is live keeps it as an explicit value even if the registry default later changes.

The upstream tier echo relays to the client on every Chat Completions delivery shape
(`src/chat/outbound.ts` projections and `src/server/chat-native-sse.ts` chunks), matching
what the Responses lane already relayed for responses-wire upstreams; the responses-lane
assembly for chat-wire upstreams tracks the echo in attempt telemetry only.
