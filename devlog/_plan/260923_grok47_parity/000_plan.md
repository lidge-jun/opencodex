# 260923 grok-4.7 parity — plan

grok-4.7 shipped on 2026-09-21 and already answers through xAI, Devin, Command Code and Cursor, but OpenCodex has no
registry entry for it: the picker shows it without a context window, reasoning ladder, image input, Fast row or
Responses wire, and cost estimates are unavailable. This unit gives grok-4.7 the same declarations grok-4.6 carries,
using values measured with real grok-4.7 calls (010_probe-evidence.md) and xAI's published model page, and applies
them to the other providers that serve it where their evidence supports each declaration.

## Loop spec

- Archetype: satisfy-spec, single work-phase (wp1), one PABCD cycle, one PR to dev.
- Trigger: user request 2026-09-23 "grok-4.7 모델 피커 컨텍스트 fast 와이어를 실제 토큰응답으로 ... grok-4.6과 같이 패치하고 다른 프로바이더들에도 적용하는 pr".
- Goal: grok-4.7 has grok-4.6-equivalent picker/context/effort/image/Fast/wire/price metadata on xAI, plus Devin,
  Command Code, Cursor, OpenCode Go and bundled gateway metadata where evidenced.
- Non-goals: changing default or sidecar models (web-search defaults stay grok-4.6); grok-4.7-build-fast; GitHub
  Copilot wire pin and OpenCode Go hosted web_search strip for 4.7 (no probe possible, not configured locally);
  merge, release, service restart. The user forbade local tests: no bun test, typecheck or build runs locally.
- Verifier: static only locally — `git diff --check`, JSON parse of edited JSON, `rg` roster consistency (every
  grok-4.6 xAI-block key has a grok-4.7 sibling), byte-equality of regenerated metadata via the generator script
  (codegen, not a test); then exact-head hosted CI on the PR (typecheck + 4 test shards + file-size + layout).
- Stop: PR open, independent review has no unresolved blocker, exact-head CI reported.
- Memory artifact: this unit (000/010), goalplan add-grok-4-7-to-opencodex-with-the-same-first-cl.
- Expected terminal outcomes: DONE (PR open, CI green or failures fixed); BLOCKED if push refused.
- Escalation: a CI failure that needs a local run to diagnose, or a design dispute that requires changing a default.
- HOTL bounds: tools = repo edits, gh, live proxy probes already done; write scope = files listed below; no token or
  time budget was set by the user.

## Architect consultation

Handle 01a0caad-1195-74b3-8338-e7a354313b5d (Banach, gpt-6-sol). Proposal D1–D8. Dispositions:

- D1 accept (xAI declarations, grok-4.7 ahead of 4.6 in XAI_MODELS).
- D2 amended in revision 3 (see Audit round 1 synthesis): toggle set unchanged; 4.7 gets the OAuth Responses default
  through modelWireDefaults only.
- D3 accept (Devin roster, 500k, measured low..max ladder, default medium).
- D4 accept: add xai/grok-4.7 and xai/grok-4.6 to COMMAND_CODE_IMAGE_MODELS; the 4.6 negative is contradicted by the
  same two-path grid probe the header demands.
- D5 amend: OpenCode Go wire/efforts/default ARE mirrored — opencode.ai/docs/go lists "Grok 4.7 grok-4.7
  https://opencode.ai/zen/go/v1/responses @ai-sdk/openai", the same documented evidence the 4.6 pin (#3394) used.
  The Go web_search strip and the Copilot Responses pin stay 4.6-only (unprobed; recorded as follow-ups).
- D6 amend: Cursor's live GetUsableModels roster (explorer 01a0caad-9fb2-70a1-9cf5-120ad392775f) lists
  grok-4.7-{low,medium,high,xhigh} and the same with -fast, no cursor- prefix, no max. Mirror with no wirePrefix and
  keep the prefix condition 4.5/4.6-only. Context: Cursor's API reports no window; 4.6's 500k is likewise the model's
  published window, so 4.7 gets 500k from xAI's page and the measured xAI limit.
- D7 accept for xAI prices; OpenRouter's distinct prices arrive through the regenerated bundled metadata rather than
  a new overlay (4.6 has no OpenRouter overlay either). Devin-cli gets a derived row only if DEVIN_GROK equals xAI's
  list price, labeled derived like the GPT-6 rows.
- D8 accept.

Reflection: see "Reflection" below.

## File change map (dependency order)

1. src/providers/registry/model-seeds.ts — XAI_MODELS: insert "grok-4.7" before "grok-4.6".
   COMMAND_CODE_IMAGE_MODELS: add "xai/grok-4.6" and "xai/grok-4.7" with the probe note; drop xai/grok-4.6 from the
   verified-negative header list (both mentions).
2. src/providers/registry/entries-core.ts, xai block: modelSupportsServiceTier, modelWireDefaults (oauth, responses
   inbound), modelInputModalities, preserveReasoningContentModels, modelReasoningEfforts [low..xhigh],
   modelDefaultReasoningEfforts high, modelContextWindows 500_000 — each with a grok-4.7 sibling of 4.6; comments cite
   devlog/_plan/260923_grok47_parity/010_probe-evidence.md. Devin block: add "grok-4-7" after "grok-4-6" in models.
   OpenCode Go block: modelWireDefaults, modelReasoningEfforts, modelDefaultReasoningEfforts for grok-4.7.
3. src/adapters/devin/live-models.ts — DEVIN_MODEL_CONTEXT_WINDOWS "grok-4-7": 500_000; DEVIN_MODEL_EFFORTS (if it
   has per-model entries) "grok-4-7": low..max, default medium if a default map exists.
4. (removed in revision 3 — see Audit round 1 synthesis; xai-responses-opt-in.ts is unchanged)
5. src/usage/expected-prices.ts — xai grok-4.7 base {2,6,0.5,0}, priority 2x rule list gains grok-4.7, >=200k
   UNIFORM_DOUBLE row with confirmedPriorityRelation lower-bound; devin-cli grok-4-7 conditional (D7).
6. src/adapters/cursor/{catalog.ts,effort-map.ts,discovery.ts} — "grok-4.7" capability (displayName "Cursor Grok
   4.7", CONTEXT_500K, no wirePrefix, regular+fast low..xhigh), tiers for "grok-4.7" and "grok-4.7-fast", heuristic
   window 500_000 for grok-4.7 ids. Verify the Fast path emits flattened grok-4.7-<effort>-fast (accepted live) and
   not the bare grok-4.7-fast (not_found live).
7. scripts/model-metadata.source.json + src/generated/model-metadata.ts — add grok-4.7 rows beside each existing
   grok-4.6 row for providers whose current models.dev entry lists 4.7 (xai, opencode-go, opencode, openrouter, kilo,
   vercel, zenmux if present), copying that provider's live models.dev record; regenerate with
   scripts/generate-model-metadata.ts.
8. Tests (hosted CI runs them): tests/providers/provider-registry-parity.test.ts:1259 default-effort map;
   tests/service/service-tier-capability.test.ts:125; tests/usage/usage-cost.test.ts:939; an xAI
   wire-default case for 4.7 (OAuth Responses inbound resolves openai-responses; explicit modelAdapters Chat wins); command-code vision assertion
   (tests/providers/command-code-provider.test.ts:219 flips 4.6 to image-capable); cursor effort/Fast wire-id cases for
   4.7; opencode-go Responses wire case for 4.7. codex-catalog.test.ts is at its cap: no edits there.
9. Docs: docs-site guides/codex-app-models.md model table (+ locales), reference/configuration/providers.md xAI Responses
   default note if it lists models (the opt-in toggle list stays 4.5/4.6); structure/providers/xai-grok.md Fast set, structure/transports/responses.md:418,
   structure/providers/cursor.md grok row.

## Acceptance

- A1 every xai-block map that names grok-4.6 also names grok-4.7 with the measured value (rg check).
- A2 Cursor 4.7 wire ids equal the live roster: regular grok-4.7-<e>, Fast grok-4.7-<e>-fast, no cursor- prefix.
- A3 (removed in revision 3): toggle set unchanged; xai-transport and management toggle tests stay as they are.
- A4 generated metadata byte-matches the generator output (codegen run + model-metadata-sync test in CI).
- A5 hosted CI green at the PR head, or failures diagnosed and fixed.


## Reflection

Architect 01a0caad-1195-74b3-8338-e7a354313b5d on revision 1: MISALIGNED (narrow), D1–D8 all mapped. Gaps and
dispositions:

- OpenRouter >=200k band rule: rebutted. `src/usage/expected-prices.ts` carries no OpenRouter context tier for any
  model, including grok-4.6 whose OpenRouter entry publishes the same kind of override band. Adding one only for 4.7
  would create a new, inconsistent pattern; it belongs in a separate change that covers OpenRouter tiers as a whole.
  Recorded as a follow-up.
- Broken evidence pointer (010 -> 010_plan.md): fixed to 000_plan.md, and the Cursor Fast success / bare-id
  rejection recorded in 010_probe-evidence.md.
- Missing Reflection section: this section (revision 2).


## Audit round 1 synthesis (revision 3)

Reviewer 01a0cab4-38a2-7ec0-8de2-02c1982a4345: FAIL, 2 High, both caused by D2 (4.7 joining the Responses toggle).

Root cause: `XAI_RESPONSES_OPT_IN_MODELS` is the scope of a legacy compatibility switch (dashboard copy
"Grok 4.5 and 4.6", management write path provider-routes.ts:449, v1 migration). grok-4.6's actual Responses
default comes from `modelWireDefaults` (entries-core.ts:264), and that is the declaration parity requires.

D2 amended (before -> after): before, 4.7 joins the toggle set and the migration gets a separate legacy list; after,
the toggle set, its migration, the GUI copy and the management tests stay unchanged, and 4.7 receives the same OAuth
Responses default through `modelWireDefaults` only. A user who wants 4.7 on Chat sets
`modelAdapters["grok-4.7"]="openai-chat"`, which always wins (the same escape hatch the Go/Copilot pins document).
Consequences: blocker 1 (xai-transport.test.ts:85, management-provider-validation.test.ts:4102/4123) and blocker 2
(gui/src/i18n copy, ProviderAuthPanel mixed state) no longer arise; plan step 4 is removed, and so is acceptance A3.
Non-blocking note folded: DEVIN_STATIC_MODELS (src/adapters/devin/live-models.ts:18) gains "grok-4-7".
The proposed "grok-4-6" fallback entry was removed because its Devin-specific ladder was not measured.
