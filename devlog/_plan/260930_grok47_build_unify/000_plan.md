# 260930 Grok 4.7 build-fast unification — plan (revision 4)

xAI's Grok OAuth gateway lists two Grok 4.7 ids, `grok-4.7` and `grok-4.7-build-fast`, so the xAI model list
shows the same model twice. Live probes (010_probe-evidence.md) show one model on two serving lanes: the
same effort ladder, image input, 500k limit and advertised defaults, while build-fast returns its first
token in about half the time and streams about 1.6x faster. They also show that today's Grok 4.7 Fast
(`service_tier: priority` on `grok-4.7`) costs about 5.9x the ticks per output token with no measurable
speed gain, while build-fast without priority costs about 2x. This unit keeps one visible row, `grok-4.7`,
and makes its Fast selection (`xai/grok-4.7--fast`, a caller `service_tier: priority`, or global
`fastMode`) dispatch `grok-4.7-build-fast` without a service tier on the Grok OAuth lane. API-key users keep
priority processing, and explicit `grok-4.7-build-fast` requests keep routing.

## Loop spec

- Archetype: satisfy-spec, single work-phase wp1, one PABCD cycle, one PR to dev.
- Trigger: user request 2026-09-30 "xai 프로바이더에 grok 4.7 이랑 grok 4.7 build가 두개 있는데 ... 4.6 의 처리방법
  속도 이런걸 너가 마음껏 프로브 해보고 하나로 통합하는 작업하고 pr 올려놔", cxc-loop HOTL, unlimited gpt-6.1-sol dispatch.
- Goal: one Grok 4.7 row plus its --fast row; Fast on OAuth uses the measured faster and cheaper lane.
- Non-goals: Cursor/Devin/Command Code/OpenCode Go 4.7 rows; priority behavior of other xAI models (4.6 etc.);
  key-auth behavior; a build-fast price row; native Chat (OAuth is ineligible, chat-native-eligibility.ts:37);
  merge, release, service restart, config mutation.
- Verifier: focused bun tests (new + touched files below), `bun run typecheck`, `bun run test:changed`,
  `bun run structure:check`, `bun run privacy:scan`; exact-head hosted CI on the PR.
- Stop: PR open to dev, template complete, exact-head CI reported.
- Memory artifact: this unit (000 plan, 010 probe evidence); goalplan unify-the-duplicated-xai-grok-4-7-rows-in-openco.
- Terminal outcomes: DONE (PR + CI green or fixed); BLOCKED (push refused). NOOP ruled out by 010.
- Escalation: CI failure needing a design change; evidence that the swap breaks OAuth continuations.
- HOTL bounds: repo edits, local bun gates, gh; write scope = files below; no user-set token/time budget.

## Architect consultation

Handle 01a0f176-87b5-7142-89ab-d8297ec852d8 (Descartes, gpt-6.1-sol). Proposal D1–D9; reflection on revision 1:
MISALIGNED (gaps 1–5). Dispositions, revision 2:

- D1 amend (gap 1 partly rebutted): hide with the existing publication hook `shouldExposeProviderModel`
  (model-visibility.ts:189; grok-4.20-multi-agent-beta-latest precedent). It filters every discovered row
  before the cache write on the xAI path (provider-models.ts:771 -> setCached at :788), and the cache is
  in-memory only (model-cache.ts:51), so a stale pre-upgrade cache cannot survive the restart that loads
  this code. Rows re-added by an explicit `retainModels` entry, a combo target, or a user-created custom row
  are explicit user configuration and stay visible on purpose; that keeps D5's routing promise without a
  selection-rewrite rule. Known limitation recorded in docs: a user who had enabled only build-fast must
  enable grok-4.7 (and use its Fast row).
- D2 accept, revision 3 (round-2 gap 1 accepted): the logical id owns ALL policy, through serialization.
  `parsed.modelId` and `route.modelId` stay `grok-4.7`, so every adapter lookup keyed on them — effort
  remap (passthrough.ts:285, reasoning.ts:284-296; openai-chat.ts:151), sampling strips (passthrough.ts:342,
  openai-chat.ts:142-148), summary delivery (passthrough.ts:354,493), web-search normalization (:419) and
  identity naming (:283) — resolves against grok-4.7 exactly as today, including operator overrides.
  Only the serialized `model` field changes: the helper writes `raw.model` (the passthrough forwards the
  raw body, passthrough.ts:543) and sets a new private `parsed._wireModelOverride`, which the openai-chat
  adapter reads in its one `model:` line (openai-chat.ts:108). No other consumer reads the override.
- D3 amend -> **B** (gap 2 accepted): C loses the agreed gate against B on TTFT, and 010's cost table shows
  priority multiplies ticks per output token ~5.9x on both ids. Fast = build-fast with the service tier removed.
- D4 amend: provider-owned helper `src/providers/xai-fast-model.ts` applied at the tail of
  `applyFinalRouteRequestNormalization` (after `decideTier` and `applyServiceTierGate`, core-normalize.ts:235-248).
  Every OAuth inbound reaches it: Responses/WebSocket (websocket-handler.ts:333), Chat (chat-completions.ts:427)
  and Claude (claude-messages.ts:1221) through handleResponses -> request-prepare.ts:1181; retries rebuild
  from the same `parsed` (adapter-dispatch.ts:473, passthrough-dispatch.ts:1028). It sets
  `tierDecision = {kind:"drop"}` so both writers omit service_tier (canonical-forward.ts:27-28; openai-chat.ts:74-124),
  and replaces the observation's fast wire with an internal
  `{kind:"model-variant", canonicalToWire:{priority:"grok-4.7-build-fast"}, foreignCallerTiers:"drop"}`
  and `responseTierAuthoritative:false`, captured before the adapters serialize.
- New FastWire kind `model-variant` (types/provider.ts:201): internal only — the runtime validator keeps
  rejecting it in config (fastwire.ts:523), FAST_WIRE_ADAPTERS maps it to openai-chat/openai-responses,
  usage/log.ts:646/666 accepts it on read. A helper `emittedFastWire(parsed, body)` in fastwire.ts reports
  `model-variant` + the model id when the serialized body carries the variant, otherwise the old
  service-tier/null result; passthrough.ts:537 and openai-chat.ts:235 call it (net zero lines in
  openai-chat.ts, cap 822). createAdapterTierMetadata then records fastOutcome applied / confirmation
  assumed, the Cursor precedent (cursor.ts:138-145), instead of a false "downgraded".
- D5 accept: explicit build-fast requests route unchanged; build-fast gains the probed OAuth Responses
  `modelWireDefaults` entry so a legacy direct request stops falling back to Chat. `modelSupportsServiceTier`
  stays unset for build-fast (priority costs ~6x for no measured gain), so no build-fast --fast row appears.
- D6 accept: predicate `route.providerName === "xai" && route.provider.authMode === "oauth"`, the transport's
  own gateway selector (xai-transport.ts:124,136,176).
- D7 accept (gap 4 usage; corrected in revision 4 per audit finding 3): the attempt stays keyed to logical
  grok-4.7 (request-transport.ts:804) and `logCtx.wireModel` records build-fast. An applied/assumed
  outcome does map to requestedServiceTier "priority" regardless of kind (cost.ts:450), but xAI's priority
  price rule requires a response-confirmed tier (expected-prices.ts:619, cost.ts:526), and the model-variant
  observation sets `responseTierAuthoritative:false`, so it can never confirm. The estimate therefore stays
  at grok-4.7's base rate — a comparison figure, as every OAuth estimate already is. Tested with a complete
  outcome, including an upstream echo of "priority". No build-fast price row.
- Compaction (revision 4, audit finding 1): routed compaction reaches handleResponses with
  `_compactionRequest` (compact.ts:1414-1438, parser.ts:627/661) and follows the same Fast mapping on
  purpose: it is the same conversation on the same model, and 010 shows the alternative (priority on
  grok-4.7) costs ~5.9x for no speed. A captured-body regression pins it.
- Client model echo (revision 4, audit finding 4): translated deliveries (Chat, Claude, buffered) answer with
  the logical `grok-4.7` (adapter-delivery.ts:262); the Responses passthrough relays the upstream's own
  `model`, which is `grok-4.7-build-fast` for Fast turns, the same way plain grok-4.7 turns already relay
  `grok-4.7-build` (010). Intentional and asserted in tests; no response rewriting.
- D8 accept (gap 5): serialized-body tests below, plus visibility tests on the discovery path.
- D9 accept: structure/providers/xai-grok.md plus the public docs-site page that describes Grok/xAI Fast.

## File change map (dependency order)

1. src/types/provider.ts — FastWire.kind adds "model-variant" with a doc line.
2. src/providers/fastwire.ts — FAST_WIRE_ADAPTERS["model-variant"]; `emittedFastWire(parsed, body)` helper.
3. src/usage/log.ts — accept "model-variant" in normalizeAttemptTierOutcome.
4. src/providers/xai-fast-model.ts (new) — XAI_OAUTH_FAST_MODELS map, `xaiOauthFastModel(providerName, provider, modelId)`,
   `applyXaiOauthFastModel(parsed, route, logCtx)` (writes raw.model + parsed._wireModelOverride, never parsed.modelId).
   It is idempotent per final route: when the current route does not qualify but a previous route in the
   same request set `_wireModelOverride` (combo/fallback re-normalization), it restores `raw.model =
   route.modelId` and clears the override — core-normalize.ts:136 only rewrites `raw.model` when
   `route.modelId !== parsed.modelId`, so a same-id fallback (e.g. xai/grok-4.7 on key auth) would otherwise
   inherit build-fast. On that restore it also deletes `logCtx.wireModel` only when it still equals the
   value the helper installed (another normalizer's later annotation is preserved). Tested for both the
   outbound model and the logged identity.
4a. src/types (OcxParsedRequest) — optional `_wireModelOverride?: string`.
5. src/server/responses/core-normalize.ts — call (4) after applyServiceTierGate.
6. src/adapters/openai-responses/passthrough.ts, src/adapters/openai-chat.ts — use `emittedFastWire`;
   openai-chat `model:` line prefers `parsed._wireModelOverride` (same line, net zero).
7. src/codex/catalog/model-visibility.ts — hide build-fast via the map values of (4).
8. src/providers/registry/entries-core.ts — comments; build-fast OAuth Responses modelWireDefaults.
9. Tests: grok-47-build-fast-metadata.test.ts (wire parity now expected, tier still absent);
   new tests/providers/xai/grok-47-fast-model.test.ts — helper matrix (OAuth+Fast swaps; no Fast, fastMode
   false, key auth, grok-4.6, explicit build-fast, non-xai unchanged), emittedFastWire + createAdapterTierMetadata
   outcome applied/assumed and log normalization round-trip, visibility hook; new
   tests/providers/xai/grok-47-fast-model-wire.test.ts — execution tests that capture the ACTUAL
   outbound body from a mocked upstream (harness chosen by the explorer lane) for: Responses inbound,
   Chat-translated, Claude-translated, WebSocket inbound, OAuth 401 replay, and a combo child targeting
   xai/grok-4.7; each asserts model = build-fast, no service_tier, and that effort remap / strips were keyed
   on grok-4.7 (a divergent operator override on grok-4.7 is honored while build-fast's registry row differs);
   and asserts the logged attempt tierOutcome is model-variant/applied/assumed. Key auth, no Fast and
   fastMode:false keep today's body. A pricing case proves a model-variant outcome does not trigger the
   priority multiplier (complete applied/assumed/non-authoritative outcome with a "priority" echo, through
   the real xAI estimate), a routed compaction (`compaction_trigger`) request under global Fast and caller
   priority, and the client-visible model on passthrough vs translated delivery. Continuation: 010 shows no
   model-id boundary (local expansion keyed by response id, state.ts:1056); a proxy-level test proves a
   previous_response_id turn after a Fast toggle expands history and sends the variant.
   Register both files in scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json.
10. structure/providers/xai-grok.md; structure/transports/responses-wire-shapes.md:68 (Grok 4.7 no longer forwards
    service_tier for OAuth Fast); review the other manifest owners of FastWire/adapters/usage and edit only
    inaccurate text; docs-site English page for Grok Fast (+ locales if the paragraph exists there).

## Acceptance

- A1 visibility: discovery for xai returning both ids yields one grok-4.7 row (hook test on the list the
  discovery path filters; activation = discovery output containing build-fast).
- A2 Fast dispatch: an OAuth grok-4.7 request with Fast intent serializes `model: grok-4.7-build-fast` and no
  `service_tier` in both adapters; tier outcome = model-variant / applied / assumed.
- A3 no regression: key auth, no Fast, fastMode false, grok-4.6, explicit build-fast unchanged; existing xai,
  fastwire and usage suites pass.
- A4 gates exit 0: focused tests, typecheck, test:changed, structure:check, privacy:scan.


## Reflection

Architect 01a0f176-87b5-7142-89ab-d8297ec852d8, three rounds on this plan:

- Revision 1: MISALIGNED, gaps 1-5 (visibility retention, D3 gate selects B, native Chat bypass, policy
  keying and usage identity, execution tests/docs). Dispositions recorded in "Architect consultation".
- Revision 2: MISALIGNED, 2 gaps (passthrough effort remap keyed on physical id; execution-level tests and a
  pricing case). Both accepted in revision 3 (logical id kept in parsed.modelId; test list expanded).
- Revision 3: MISALIGNED, 1 gap (stale logCtx.wireModel after a non-qualifying re-normalization). Accepted
  and folded above (revision 3.1). All earlier objections were reported resolved; continuation stays an
  evidence item carried into A/C.
