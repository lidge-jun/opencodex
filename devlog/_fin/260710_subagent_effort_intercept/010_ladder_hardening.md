# 010 — WP1: Ladder-aware cap resolution (snap-down / lowest-rung / strip)

## Loop-spec

- Archetype: spec-satisfaction repair.
- Trigger: user hardening request — a cap value the target model does not support must
  degrade gracefully instead of shipping an unsupported wire value.
- Goal: capped turns always leave the proxy with an effort the target model actually
  supports, or with NO effort when the model exposes none.
- Non-goals: GUI/docs (WP2), adapter-internal maps, upstream codex-rs.
- Verifier: `bun test tests/effort-policy.test.ts` + full `bun test` + `bunx tsc --noEmit`.
- Stop: all named tests green. Terminal outcomes: DONE / BLOCKED (registry semantics conflict).

## Semantics (accept criteria)

Amended after audit round 1 (reviewer FAIL, blockers 1-3 folded back; the cap NEVER
raises an effort — "lowest supported rung when all rungs are above the cap" was a
contradiction and is DROPPED).

Given configured cap C (already the LOWER of effortCap/subagentEffortCap for the turn)
and the target model's supported ladder S. Rankable = member of the Codex ladder
low..ultra (codexEffortRank >= 0); `minimal` and provider tokens like "enabled" are
not rankable.

1. S undefined (unknown ladder) -> resolved ceiling = C (today's behavior).
2. S = [] (model intentionally exposes no effort control, e.g. noReasoningModels) ->
   STRIP: remove any present effort from BOTH shapes REGARDLESS of its rank (also
   `minimal`, also efforts below C — the model takes no effort at all). Preserves
   `_rawBody.reasoning.summary`. Activation scenario: routed provider with
   `noReasoningModels: [model]`, cap "high", incoming "max" AND incoming "low" ->
   parsed.options.reasoning undefined + _rawBody.reasoning.effort deleted, summary kept.
3. S nonempty but NO rankable entry (e.g. ["enabled"]) -> treat as case 1 (unknown,
   ceiling = C); never accidental strip.
4. Eligible = rankable rungs of S with rank <= rank(C). If eligible nonempty ->
   resolved ceiling = highest eligible rung (C itself when C in S; snap-down
   otherwise). Activation scenario: cap "high", S = [low, medium, xhigh] -> "medium";
   cap "high", S = [low, medium, high] -> "high".
5. S has rankable rungs but NONE <= C (cap unfulfillable, e.g. cap "medium",
   S = ["xhigh"]) -> STRIP (same as case 2): the model cannot run at or below the cap,
   so send no effort and let the provider default apply. Never select a rung above C.
6. Only-lowers invariant (non-strip cases): incoming effort at or below the resolved
   ceiling passes untouched; absent/non-rankable incoming efforts pass untouched.
   Strip cases (2, 5) remove whatever effort is present, by design.
7. Ordering: the strip decision is evaluated BEFORE the requested-vs-ceiling early
   return (a "low" request to a no-effort model must still strip when a cap is
   configured).

## File change map

- `src/server/effort-policy.ts`
  - NEW `supportedLadderFor(route)` — route.provider is the REGISTRY-MERGED provider
    object (router.ts routedProviderConfig); the persisted config.providers entry
    misses registry seeds, and bare ids can route via defaultModel/model-list/
    default-provider so no "/" heuristic anywhere. Resolution order (audit round 2):
    1. `modelInList(provider.noReasoningModels, modelId)` -> `[]` (explicit strip class).
    2. RAW ladder present (`modelRecordValue(provider.modelReasoningEfforts, modelId)
       ?? provider.reasoningEfforts`) -> `configuredReasoningEfforts(provider, modelId)`
       (sanitize + healMaxTier); if the SANITIZED result is empty while the raw ladder
       was nonempty (non-rankable-only, e.g. ["enabled"]) -> return undefined
       (unknown/passthrough), NEVER strip — the raw-vs-sanitized check preserves the
       case-3 distinction that configuredReasoningEfforts alone destroys.
    3. No provider ladder metadata -> catalog fallback ONLY for the ChatGPT-backend
       native passthrough IDENTITY (`provider.adapter === "openai-responses" &&
       provider.authMode === "forward"` — the fresh-install `openai` provider shape,
       config.ts getDefaultConfig; the injected catalog is the source of truth exactly
       for models Codex validates against that backend): `catalogModelEfforts(
       [route.modelId])`. `adapter` alone is a configurable protocol string, so a
       custom `openai-responses` provider (e.g. key-mode openai-apikey or a
       self-hosted responses endpoint) serving a bare native-looking id returns
       undefined instead of inheriting the unrelated native catalog ladder.
  - NEW `resolveCappedEffort(cap, supported)`: semantics 1-5; returns
    `string` (resolved ceiling; supported undefined / non-rankable-only / eligible
    rungs all collapse here) or `null` (strip: S=[] or cap-unfulfillable).
  - `applyEffortCap(parsed, headers, config, supported)`: strip path clears
    `parsed.options.reasoning` and DELETES `_rawBody.reasoning.effort` only (summary
    preserved); returns `{ from, to: "none", subagent }` on strip; from = requested or
    return null when no effort was present to strip (no-op). Strip fires regardless of
    the incoming effort's rank (also "minimal"/below-cap).
- `src/server/responses.ts` — cap block passes
  `supportedLadderFor(route)`; log line unchanged shape.
- `tests/effort-policy.test.ts` — new describe "ladder-aware resolution": snap-down,
  table-driven `resolveCappedEffort` cases: cap-in-ladder, snap-down, cap-unfulfillable
  strip, S=[] strip (incl. incoming BELOW cap and incoming "minimal"), non-rankable-only
  ladder -> unknown, mixed rankable/non-rankable, undefined passthrough; applyEffortCap
  strip removes effort from BOTH shapes while `reasoning.summary` survives;
  `supportedLadderFor` fed from REAL `routeModel(config, id)` routes: registry-merged
  provider (minimal persisted config gains registry ladder), bare id routed via
  defaultModel, noReasoningModels -> [], raw ["enabled"] merged ladder -> undefined
  (real-route non-rankable case), collision case: custom `openai-responses` provider
  with authMode "key" + native-looking bare id + no ladder -> undefined, native
  catalog fixture via a forward-mode openai-responses provider (CODEX_HOME fixture,
  multi-agent-compat pattern);
  composition: snapped ORDINARY rung no-ops through `mapReasoningEffort` and
  `nativeEffortClamp`, while a synthetic native top rung (max/ultra on an off-ladder
  native) is still lowered by `nativeEffortClamp` AFTER the cap block (split
  assertions, no universal no-op claim).

## Scope boundary

- IN: files above.
- OUT: GUI, docs-site, adapters, catalog policy, management API shape (unchanged),
  devlog 000 (WP1 evidence lands here in this doc + D summary).
