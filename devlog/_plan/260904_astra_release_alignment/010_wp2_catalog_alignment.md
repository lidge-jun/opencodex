# 010 — wp2: replace the Astra guess with the shipped upstream row

Consumes 000; **amended by 015 after the round-1 audit returned FAIL**. Goal: every field
opencodex projects for `gpt-6-astra` comes from the shipped upstream definition instead of
Sol's snapshot plus a hand-written label.

## What the audit changed about this phase

The original headline ("fix the 922k context window") was wrong. Measured on current
`dev`: `nativeOpenAiContextWindow("gpt-6-astra")` is **already 272,000**, because
`NATIVE_GPT56_CONTEXT_WINDOW` is 272,000. The real drift is three things — the
presentation, the **long-window** ceiling (922,000 vs the shipped 872,000), and a ladder
that the naive fix would have BROKEN. See 015 for the full disposition.

## Approach: pin the real row, drop the alias scaffolding

Astra is no longer an alias with no upstream identity — it has its own row. The whole
capability-source + alias-presentation path exists to answer "what do we show for a slug
upstream has never described", and that question is now answered. So the change is
subtractive where possible.

### File change map

**1. `src/codex/data/upstream-models.json`**

Add the real `gpt-6-astra` row, copied from
`~/Developer/codex/121_openai-codex`, `git show origin/main:codex-rs/models-manager/models.json`.
Copy it whole, including `base_instructions` and `model_messages` — Astra's own GPT-6
prompt, not Sol's. Do NOT hand-edit values; the point is that this file is a pin.

Keep the existing 8 rows untouched. Sol's stale `372000` window is a separate defect
(000 Q1a) and is explicitly OUT of this unit.

**2. `src/codex/catalog/native-models.ts`**

- Remove `NATIVE_GPT6_ASTRA_MODEL` from `NATIVE_OPENAI_CAPABILITY_SOURCES`. With a real
  pinned row, `nativeOpenAiCapabilitySourceSlug("gpt-6-astra")` must return the slug
  itself so `PINNED_UPSTREAM_MODELS` resolves Astra's own entry.
- Remove its `NATIVE_OPENAI_ALIAS_PRESENTATION` entry. `display_name` and `description`
  now come from the pinned row (`GPT-6-Astra`, "Our most capable model for complex,
  demanding work."). Leaving the overlay in place would keep overwriting the real values
  with the provisional ones.
- Keep Daybreak in both maps: it still has no upstream row.
- Rewrite the `NATIVE_GPT6_ASTRA_MODEL` doc comment: it currently describes a leak and a
  404 probe. Replace with the shipped facts (commits `ed391d4dd` #42607 / `1f7b99922`
  #42619, `minimal_client_version 0.153.0`, `available_in_plans` incl. free/go/plus/pro).
- Gating: keep it OUT of `ACCOUNT_GATED_NATIVE_OPENAI_MODELS`. Rationale is now
  STRONGER, not weaker — `available_in_plans` lists 23 plans including `free`, so this is
  a broadly-available model, and gating it behind a roster that has not refreshed yet
  would hide a model the user is entitled to. Record this as a decision, not an omission.

**2b. `src/codex/catalog/effort.ts` — added by 015/C3, the blocker that mattered**

`isGpt56NativeSlug` is `nativeOpenAiCapabilitySourceSlug(slug).startsWith("gpt-5.6-")`.
Measured: it returns **true** for `gpt-6-astra` today, only because the capability source
is Sol. Change 2 flips it false, and `applyReasoningLevels(entry, isGpt56NativeSlug(slug)
? undefined : ["low","medium","high","xhigh"])` in `sync.ts` then truncates Astra's ladder
to xhigh, dropping the shipped `max` and `ultra`. That is the opposite of this unit's goal.

The predicate is misnamed for its actual meaning — "native slug entitled to the full
5.6-era ladder". Keep Astra inside it: extend the check so a self-described native with a
max/ultra ladder also qualifies, or name Astra explicitly. Its five other call sites in
`sync.ts` (`ensureUltraReasoningLevel`, `ensureGpt56ReasoningLevels`, the preserved-row
path) must keep taking the same branch they take today.

**3. `src/codex/catalog/metadata.ts`**

- `NATIVE_GPT56_FAMILY`: remove `NATIVE_GPT6_ASTRA_MODEL`. It is not a 5.6-family member
  and must not ride the measured 922,000 GPT-5.6 clamp.
- `NATIVE_OPENAI_CONTEXT_OVERRIDES`: set the Astra entry to the shipped numbers —
  `contextWindow: 272_000`, `maxContextWindow: 872_000`, `maxInputTokens: 872_000`.
  Note what each does: the default window is unchanged in value (272,000 either way), the
  **long window drops 922,000 → 872,000**, and `maxInputTokens` is clamped to the active
  window by `nativeOpenAiMaxInputTokens`'s `Math.min(narrowed, window)` — so it reads
  272,000 under the default window and 872,000 only under the long-window opt-in. Do NOT
  touch that clamp; advertising input above the window is the defect it prevents.
- `upstreamNativeEntryForSlug`: the guard `if (!sourceSlug.startsWith("gpt-5.6-")) return
  undefined;` currently lets Astra through only because its capability source WAS Sol.
  After change 2 that guard rejects Astra and `UPSTREAM_NATIVE_ENTRIES` loses the row —
  which would regress `shouldUpgradeToUpstreamEntry` and the sync backfill. Admit Astra
  through an explicit **self-described allowlist** holding exactly
  `NATIVE_GPT6_ASTRA_MODEL`. A structural predicate such as `PINNED_UPSTREAM_MODELS.has(slug)`
  is REJECTED (015/C2): it would also admit `gpt-5.5`, `gpt-5.4` and `gpt-5.4-mini` into a
  map that authorizes replacing their persisted rows during sync, which the invariant
  comment above that map forbids.
- Record the knock-on effects the first draft omitted (015/M6): `nativeOpenAiContextTier`
  reports `longWindow` 872,000 instead of 922,000; the auto-compact soft budget follows the
  resolved window; and a `providerContextCaps.openai` lever at 922,000 no longer sits above
  Astra's long window, so it stops being a no-op for this slug.
- `DOCUMENTED_NATIVE_OPENAI_ADDITIONS`: keep Astra. Installs with a live codex-rs catalog
  older than 0.153.0 still need the row to exist. Update the comment to say the slug is
  shipped-but-newer rather than unlisted.

**3b. Verified-unaffected consumers (015/H1), named so the next reader need not re-derive**

- `src/codex/catalog/provider-fetch.ts` — gates on `isNativeOpenAiCapabilityAliasModel` and
  resolves `nativeOpenAiAliasPresentation(...)?.displayName ?? cm.modelId` for CUSTOM model
  rows. After removal an explicit custom Astra row labels itself `gpt-6-astra`. Acceptable:
  a custom row is user-declared, and the native row carries the real label. Confirm, do not
  change.
- `src/codex/catalog/parsing.ts` — uses the same predicate to classify a routed
  `openai/gpt-6-astra` row as ChatGPT-native. Covered by the existing ChatGPT-forward Astra
  test in `tests/codex-catalog.test.ts`; that test is now on the affected list and must stay
  green.

**4. Tests**

- `tests/codex-catalog.test.ts`: rewrite "gpt-6-astra is registered ungated with Sol
  capabilities…". It currently asserts `nativeOpenAiCapabilitySourceSlug === "gpt-5.6-sol"`
  and a "leaked API identifier" description, both of which this unit deliberately breaks.
  Replace with assertions on the projected identity (`GPT-6-Astra`, the shipped
  description) and keep the two that still hold: membership in `NATIVE_OPENAI_MODELS`, and
  `codexAccountGatedCanonicalWireModel` returning undefined (the slug IS the wire id).
  Comparing `upstreamNativeEntry` against `upstream-models.json` is REJECTED as the primary
  oracle (015/H2): once Astra self-describes, that compares the code to its own input, so a
  mis-transcribed pin would pass. Independent oracle instead: when
  `~/Developer/codex/121_openai-codex` is present, read the upstream `models.json` and
  compare; when absent, skip with a recorded reason rather than silently degrade.
- Keep the existing ChatGPT-forward custom Astra test green (015/H1).
- `tests/native-model-toggle.test.ts`: keep "gpt-6-astra lists without any roster so the
  request reaches upstream" as-is — that contract is unchanged and is what makes the row
  visible. Add the LONG-WINDOW assertion, which is the one that actually goes red without
  the patch: `nativeOpenAiContextTier("gpt-6-astra")` must be
  `{ defaultWindow: 272000, longWindow: 872000 }` (measured today: `longWindow: 922000`).
- Add a post-sync ladder assertion (015/C3): after catalog sync, Astra's
  `supported_reasoning_levels` still contain `max` and `ultra`.

## Scope boundary

IN: the files above (`upstream-models.json`, `native-models.ts`, `effort.ts`,
`metadata.ts`, the tests). OUT: Sol's stale pin, Bedrock routing, GUI, any change to
Daybreak's alias treatment, and the `Math.min` input clamp.

**`visibility` (015/M3).** Upstream ships `hide`; opencodex projects `list` and keeps doing
so. That divergence is deliberate and belongs here rather than being left unargued:
upstream hides a row the ChatGPT client reveals through its own entitlement UI, whereas an
opencodex user picks models by hand from the proxy's list. Hiding it would reproduce the
original complaint — the model exists but cannot be selected. `disabledModels` remains the
user's lever.

## Accept criteria

1. `upstreamNativeEntry("gpt-6-astra").display_name === "GPT-6-Astra"` and its description
   is the shipped sentence — cross-checked against the upstream checkout when available.
2. `nativeOpenAiContextTier("gpt-6-astra")` is `{ defaultWindow: 272000, longWindow: 872000 }`.
   Activation: today it measures `longWindow: 922000` via `NATIVE_GPT56_FAMILY` membership,
   so this assertion is red before the patch and green after — unlike the default window,
   which is already 272,000 and proves nothing.
3. After catalog sync, Astra's `supported_reasoning_levels` still include `max` and
   `ultra`. Activation: without the `effort.ts` amendment the sync else-branch truncates the
   ladder at `xhigh`, so this assertion fails on the naive patch.
4. `UPSTREAM_NATIVE_ENTRIES` gains `gpt-6-astra` and NOT `gpt-5.5`, `gpt-5.4`,
   `gpt-5.4-mini`. Activation: the rejected structural predicate would admit all three.
5. Astra stays absent from `ACCOUNT_GATED_NATIVE_OPENAI_MODELS` and present in
   `nativeModelRows` with no entitlement roster (existing test still green).
6. `bun test tests/codex-catalog.test.ts tests/native-model-toggle.test.ts` — 0 fail, plus
   `bun run test:changed` for the widened touch set.
7. `bun run typecheck` — exit 0.
8. Live: restarted `ocx service`, `/v1/models` shows `gpt-6-astra`, and
   `~/.codex/opencodex-catalog.json` shows `display_name: "GPT-6-Astra"` with a ladder that
   still contains `max` and `ultra`.

### Verifier reality check (PLAN-VERIFIER-REAL-01)

- `bun test tests/codex-catalog.test.ts tests/native-model-toggle.test.ts` — RUN this
  session, exit 0, 303 pass. Reads the change target: both files import from
  `src/codex/catalog`, which is where every edit lands. YES.
- `bun run typecheck` — RUN this session, exit 0. Reads the target: project-wide
  `tsc --noEmit`. YES.
- `jq` against `~/.codex/opencodex-catalog.json` — RUN this session; it is the file the
  Codex client actually reads, written by sync. Observes the target end-to-end. YES.
- `bun run test:changed` — the import-graph selector AGENTS.md names for a touch set wider
  than one file. Reads the target: it walks Bun's module graph from the changed files, which
  now include `effort.ts` and `metadata.ts`. YES, with the documented limit that it cannot
  see subprocess or golden-file dependencies — which is why the post-sync ladder assertion
  is written as an explicit test rather than assumed covered.
