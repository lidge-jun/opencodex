# 010 Phase 1 — re-pin the upstream snapshot

## Change map

| Path | Action |
|---|---|
| `src/codex/data/upstream-models.json` | MODIFY: byte-for-byte copy of openai/codex `6cfe29984` `codex-rs/models-manager/models.json` |
| `src/codex/catalog/metadata.ts` | MODIFY: `PINNED_UPSTREAM_MODELS` maps every row through `withDerivedBaseInstructions` |
| `tests/codex-integration/codex-catalog.test.ts` | MODIFY in place (net 0 lines, file is at cap) |
| `tests/codex-integration/reserve-catalog-lifecycle.test.ts` | MODIFY: fixture derives `base_instructions` |
| `tests/codex-integration/codex-model-entitlements.test.ts` | MODIFY: Daybreak Blue now has a pinned row |
| `structure/catalog.md`, `docs-site/src/content/docs/guides/codex-app-models.md` | MODIFY: snapshot facts |

## Why metadata.ts changes

Upstream #43604 stopped shipping top-level `base_instructions`; rows keep `model_messages.instructions_template`. `hasNativeCatalogRowShape` (`metadata.ts:677`) requires `base_instructions`, and the alias branch of `upstreamNativeEntryForSlug` only rewrites `base_instructions` when present. `withDerivedBaseInstructions` already fills it from the template for `gpt-6-astra`; apply it to the whole map so the pinned JSON stays byte-identical to upstream.

```diff
 const PINNED_UPSTREAM_MODELS: Map<string, RawEntry> = new Map(
   ((upstreamModelsSnapshot as unknown as { models?: RawEntry[] }).models ?? [])
-    .flatMap(model => typeof model.slug === "string" ? [[model.slug, model] as const] : []),
+    .flatMap(model => typeof model.slug === "string" ? [[model.slug, withDerivedBaseInstructions(model)] as const] : []),
 );
```

## Test repairs (measured in a scratch worktree before this plan)

Replacing only the JSON turns 9 tests red beyond the 30 environment-only `codex-cooldown-recovery` failures that also fail on the base (worktree under `~/.codex` trips the test home guard):

| Test | Line | Old → new |
|---|---|---|
| gpt-5.6 natives come from the pinned upstream snapshot | `codex-catalog.test.ts:3563`, `:4272` | Sol description → "Reliable agentic workhorse for everyday tasks." |
| Daybreak Blue inherits Sol capabilities | `codex-catalog.test.ts:3757` | 372_000/372_000 → 272_000/872_000 |
| configured ChatGPT-forward Daybreak | `codex-catalog.test.ts:3950` | fixed by the metadata.ts derivation |
| catalog sync upgrades fallback-quality gpt-5.6 entries | `codex-catalog.test.ts:4252` | Luna priority 3 → 8 |
| reserve lifecycle x3 | `reserve-catalog-lifecycle.test.ts:39` | fixture clones Luna and adds `base_instructions` from `model_messages.instructions_template` |
| ungating the 5.6 family empties the derivation | `codex-model-entitlements.test.ts:1674` | derivation now returns `"0.142.2"` from the shipped Daybreak Blue row; composed floor stays `"0.144.0"` |

## Out of scope

## Audit round 1 dispositions (reviewer Peirce, grok-4.7, VERDICT FAIL)

- B1 blast radius — rebutted with measurement: the scratch run replaced only the JSON and ran the eight touching files (`.tmp/resync-probe-full.log`: 470 pass / 39 fail; base `.tmp/resync-base-full.log`: 479 pass / 30 fail, the same 30 cooldown-recovery environment failures). `codex-catalog.test.ts:3497`, `:3524` and `:3865` passed in that run. Folded the part that is right: the comments that describe the old pin are updated — `native-models.ts:74-79` (the pin no longer holds `gpt-5.2` / `gpt-5.4-mini`), `model-entitlements.ts:93-111` and `:123-129` (the snapshot now records 0.144.0 for the 5.6 family and 0.142.2 for Daybreak Blue). Raw-row assertion at `:3757` is kept as a raw-row assertion (272_000/872_000) with its comment corrected; the effective 922_000 override is asserted separately at `:3939` and is unchanged.
- Capped file: every `codex-catalog.test.ts` edit is an in-place value swap, net 0 lines.

Daybreak Blue stays a capability alias of Sol (its pinned row is data only); making it self-described would drop the Fast tier and is a separate decision.

## Verification

`bun run typecheck` (exit 0). Tests: NOT RUN locally per user steering; hosted CI on the PR head.
