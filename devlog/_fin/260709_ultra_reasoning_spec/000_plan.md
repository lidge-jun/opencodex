# 000 — Ultra reasoning spec port (upstream codex-rs parity)

## Loop-spec header (C3, spec-satisfaction)

- **Loop archetype:** spec-satisfaction repair (verifier defines done).
- **Trigger:** upstream codex-rs series — df1199fdd `[codex] Add Ultra reasoning effort (#29899)`, 80f54d126 `Treat max as a first-class reasoning effort (#30467)`, 927004c06 `tui: warn on Ultra with high multi-agent concurrency (#31621)`. User request: make ocx's spec for the gpt-5.6 sol family + ultra as stable as remote.
- **Goal:** ocx accepts, orders, advertises, and wire-converts the `ultra` reasoning effort with the same semantics as codex-rs origin/main.
- **Non-goals:** no codex-rs changes; no proxy-side emulation of proactive multi-agent derivation (client-owned per upstream `core/src/session/multi_agents.rs:52-55`); no TUI concurrency warning port (TUI-owned); no routed-model default ladder expansion; no GUI work.
- **Verifier:** `bun test tests/reasoning-effort.test.ts tests/responses-parser.test.ts`, `bun test tests/codex-catalog-golden.test.ts tests/codex-catalog.test.ts`, then full `bun test`.
- **Stop condition:** all verifier gates green + SoT docs synced.
- **Memory artifact:** this unit (`devlog/_plan/260709_ultra_reasoning_spec/`), goalplan ledger.
- **Expected terminal outcomes:** DONE / NOOP (disproven by G1-G3 evidence) / BLOCKED / NEEDS_HUMAN.
- **Escalation:** LOOP-REPAIR-01 — 2 same-failure repairs -> root-cause mode; 3 -> replan.
- **HOTL resource bounds:** writes confined to this repo; read-only git on /Users/jun/Developer/codex/120_codex-cli; subagents = read-only explorer/reviewer (gpt-5.5), fan-out <= 3; wall-clock ~40 min tool time.

## Upstream contract (evidence, origin/main = a09a7c41d)

1. Enum order `None, Minimal, Low, Medium, High, XHigh, Max, Ultra, Custom(String)` — `max` first-class, `ultra` ranks ABOVE `max` (`protocol/src/openai_models.rs:40-51`).
2. `ultra` never reaches the inference wire: `reasoning_effort_for_request` maps `Ultra => Max` for Responses HTTP/WS, prewarm, compaction, memory summarization (`core/src/client.rs:174-179`, `:802-812`, `:1713-1744`, `:564-592`, `:701-710`).
3. Catalog owns effort order; clients preserve `supported_reasoning_levels` array order (`app-server/README.md:140`). Bundled models.json advertises no ultra; live/remote catalogs may. Bedrock gpt-5.6 pattern appends `Max` on top of the gpt-5.5 template (`model-provider/src/amazon_bedrock/catalog.rs:77-89`) — the exact pattern ocx already copies via `ensureMaxReasoningLevel`.
4. Proactive multi-agent derivation from `Ultra` is client-core-owned and V2-gated (`core/src/session/multi_agents.rs:39-67`); deprecated app-server `multiAgentMode` fields are ignored.
5. TUI warns on Ultra when `max_concurrent_threads_per_session >= 8` (`tui/src/chatwidget/model_popups.rs:8,552-574`) — client-owned, out of proxy scope.

## ocx gaps (evidence)

- G1 **Parser drops ultra silently**: `src/responses/parser.ts:220` `REASONING_EFFORTS` = {none,minimal,low,medium,high,xhigh,max}; `:467-469` gates ingest. `reasoning.effort:"ultra"` -> `options.reasoning` unset -> adapters treat as no-reasoning (thinking disabled entirely). Upstream degrades ultra->max; ocx degrades to nothing. Stability gap #1.
- G2 **Ladder has no ultra**: `src/reasoning-effort.ts:4-10` `CODEX_REASONING_LEVELS` ends at max; `sanitizeCodexReasoningEfforts` strips `ultra` from provider config; `clampToSupportedCodexEffort` cannot rank it; config opt-in impossible.
- G3 **gpt-5.6 sol family cannot advertise ultra**: `src/codex/catalog.ts:517-525` `ensureMaxReasoningLevel` appends only max for `gpt-5.6-*` native slugs (`:513-515`, call sites `:555`, fallback `:567`).

## Diff plan

### 1. `src/reasoning-effort.ts` (MODIFY)
- `CODEX_REASONING_LEVELS`: append after `max`: `{ effort: "ultra", description: "Maximum reasoning that may proactively delegate work to multiple agents" }`. Order low<medium<high<xhigh<max<ultra mirrors upstream enum rank.
- `mapReasoningEffort`: after the existing clamp resolves `codexEffort`, convert `ultra` at the wire boundary exactly like upstream `reasoning_effort_for_request`: `const wire = codexEffort === "ultra" ? "max" : codexEffort;` then existing `wireMap[wire] ?? wire` lookup. Explicit `wireMap["ultra"]` (checked on the requested value, existing first branch) still wins for providers that genuinely alias ultra.
- No change to `requestToCodexEffort` body (set membership picks up ultra); `minimal->low` mapping untouched.

### 2. `src/responses/parser.ts` (MODIFY)
- Add `"ultra"` to `REASONING_EFFORTS` (L220).
- At ingest (L467-469): normalize `ultra -> max` before the set check — mirrors the upstream client-side boundary conversion so every adapter (anthropic budget switch, adaptiveEffort passthrough, kiro, cursor, openai-chat) sees only values it already handles. `const raw = data.reasoning?.effort; const effort = raw === "ultra" ? "max" : raw;`
- Activation scenario: unit test feeds `reasoning: { effort: "ultra" }` and observes `options.reasoning === "max"` (today: undefined).

### 3. `src/codex/catalog.ts` (MODIFY)
- `ROUTED_REASONING_LEVELS` (L481): change from alias to `CODEX_REASONING_LEVELS.filter(l => l.effort !== "ultra")` — routed-model DEFAULT ladder stays `low..max` (goldens unchanged; upstream bundled models advertise no ultra either). Providers opt in per-model via `reasoningEfforts` config, which `sanitizeCodexReasoningEfforts` now accepts.
- Rename `ensureMaxReasoningLevel` -> `ensureGpt56ReasoningLevels`: append `max` AND `ultra` (each only when absent), descriptions sourced from `CODEX_REASONING_LEVELS`. Update call site L555; add the same call after `applyReasoningLevels` on the no-template fallback path (L567) for `isGpt56NativeSlug` so both paths agree.
- Activation scenario: catalog-build test observes `gpt-5.6-sol` entry `supported_reasoning_levels` ending `[..., "max", "ultra"]` and a routed slug WITHOUT ultra.
- Rationale for advertising ultra on the sol family: upstream ships ultra as the user-facing selection for max+proactive-delegation; sol/terra/luna are the current-gen native slugs ocx synthesizes from the gpt-5.5 template (real backend catalog unavailable to verify directly — ocx owns this synthesis; Bedrock precedent appends efforts the template lacks). Client (>= df1199fdd; installed fork HEAD 129ea2aaf 07-01) converts ultra->max before the wire; the ChatGPT backend already accepts max for 5.6 — no new wire value reaches any backend. Worst case for an older client that sends raw "ultra": parser normalization (G1 fix) degrades it to max.

### 4. Tests (MODIFY)
- `tests/reasoning-effort.test.ts`: sanitize accepts+orders ultra (dedupe, sort after max); clamp `ultra` on supported `low..max` -> `max`; on `["low","high"]` -> `high`; `mapReasoningEffort` ultra -> `"max"` wire fallback; `wireMap: {ultra: "think-hard"}` alias respected; noReasoningModels still returns undefined.
- `tests/responses-parser.test.ts`: `reasoning.effort:"ultra"` -> `options.reasoning === "max"`; unknown effort (e.g. "banana") still dropped.
- `tests/codex-catalog.test.ts` (or golden): gpt-5.6-sol advertises max+ultra; routed default has no ultra. Re-record golden only if the 5.6 fixture is covered there.

### 5. SoT docs (MODIFY, SOT-SYNC-01)
- `docs/codex-app-model-catalog.md`: document the effort ladder incl. ultra semantics (advertised for gpt-5.6 natives; parser converts ultra->max at ingest; proactive multi-agent is client-derived).
- `structure/03_catalog-and-subagents.md`: sync if it names the ladder.

## Scope boundary
- IN: the five files above + goldens if touched + this unit.
- OUT: adapters (anthropic/kiro/cursor/openai-chat bodies unchanged — parser normalization shields them), providers/registry.ts effort lists (opt-in left to config), GUI, codex-rs checkouts.

## Accept criteria
1. `bun test tests/reasoning-effort.test.ts tests/responses-parser.test.ts` green with new ultra cases (activation evidence for G1/G2 paths).
2. `bun test tests/codex-catalog-golden.test.ts tests/codex-catalog.test.ts` green; gpt-5.6-sol advertises ultra; routed defaults unchanged.
3. Full `bun test` green (fresh output, exit 0).
4. Docs synced in same cycle.
5. D summary records terminal outcome + evidence in this unit.

## A-phase fold-back (reviewer: gpt-5.5, VERDICT FAIL -> plan amended, re-verdict not required per accepted fixes)

REVIEW-SYNTHESIS-01 record:
- **B1 (P1, ACCEPTED):** parser ultra->max normalization means adapters never receive "ultra"; the "wireMap.ultra respected at runtime" claim was contradictory. Amendment: single conversion boundary = parser ingest (upstream-faithful). `mapReasoningEffort` ultra branch remains as DEFENSIVE direct-call coverage only (non-Responses callers / future paths); its test is labeled defensive. No runtime wireMap.ultra claim.
- **B2 (P2, ACCEPTED):** `applyReasoningLevels` (catalog.ts:504) falls back to ROUTED_REASONING_LEVELS for descriptions; once routed list filters ultra out, an opt-in `reasoningEfforts: [..,"ultra"]` would render generic "ultra reasoning". Amendment: default efforts come from the filtered routed list; description lookup sources from full `CODEX_REASONING_LEVELS`.
- **B3 (P2, ACCEPTED):** docs scope extended: README.md:144 (Codex accepts low..max wording) + :182 (GPT-5.6 max note), docs-site/src/content/docs/guides/codex-app-models.md:67, guides/providers.md:117, index.mdx:43. README.ko.md/README.zh-CN.md synced only where the same lines exist (check during C).
- Confirmed-good (reviewer): clamp walkthrough sound (ultra->max, ultra->high, []->undefined, ["ultra"]->ultra); upstream parity claims verified; default_reasoning_level stays medium and upstream midpoint pick for 6 levels = high (no accidental ultra default).

## C-phase fold-back (reviewer: gpt-5.5 on the live diff, VERDICT FAIL -> fixed, gates re-run)

- **Blocker 1 (High, ACCEPTED):** raw `wireMap[requested]` lookup let an `ultra`-keyed alias bypass the ultra->max boundary; my test had locked the wrong behavior in. Fix: `boundary = requested === "ultra" ? "max" : requested` applied before alias AND clamp resolution (upstream converts before any provider concern); ultra-keyed aliases are now inert, max-keyed aliases apply. Test updated to assert the corrected invariant.
- **Blocker 2 (Medium, resolved by fix 1):** docs/codex-app-model-catalog.md direct-caller claim is now true as written.
- **Coverage gap (ACCEPTED):** added no-template fallback-path test — `buildCatalogEntries(null, ["gpt-5.6-sol", ...])` advertises `[low..max, ultra]`, gpt-5.5 stays `low..xhigh`.
- Re-verified after fixes: `bun x tsc --noEmit` exit 0; full `bun test` 1651 pass / 0 fail / exit 0.
