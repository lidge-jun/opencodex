# Gemini 3.8 Flash rollout plan

- Date: 2026-09-03
- Session: `01a062e6-43d4-7ad2-8236-c75a8fb66a12`
- Work class: C3 — provider catalog, CCA wire routing, persisted config surface, usage pricing, generated metadata, docs and tests move together.
- Status: P (wp0, docs-only roadmap cycle).

## Loop spec

- Archetype: satisfy-spec integration.
- Trigger: Google shipped Gemini 3.8 Flash on 2026-09-02, and authenticated Antigravity discovery already returns three 3.8 wire ids ranked FIRST in the Recommended sort.
- Goal: make Gemini 3.8 Flash the selectable, correctly tiered Antigravity Flash model, and carry the same spec to every other surface that already names 3.6/3.7 — without inventing anything the vendor has not published.
- Non-goals: Vertex routing, OrcaRouter/OpenRouter seeding, widening request transport beyond `text`+`image`, hand-editing generated metadata, deleting historical price rows or usage attribution, any release or publish.
- Verifier: focused `bun test <file>` runs on the touched subsystems plus `bun run typecheck`. **The repository-wide local suite is forbidden by the user** ("로컬스위트는 절대 돌리지 말고"); exact-head GitHub CI is the authoritative full gate.
- Stop condition: 3.8 is picker-visible with a working low/medium/high ladder, every inventoried 3.6/3.7 surface is updated or carries a recorded reason not to be, focused tests and typecheck pass, CI is green on the exact head SHA, and the PR is merged into `dev` with ancestry proof.
- Memory artifact: this unit folder.
- Expected terminal outcomes: `DONE`; `BLOCKED` if CI or branch protection refuses for a reason outside this change; `NEEDS_HUMAN` if a pricing claim turns out unprovable.
- Escalation: each A gate dispatches one independent read-only reviewer on `gpt-5.6-sol` at high reasoning effort. After two failed reviewer correction loops on the same packet, the main session stops and reports.

## The decision this plan turns on

The 3.6 to 3.7 rollout (`devlog/_fin/260814_overnight_triage_release/020_gemini_37_flash.md`) was a **replacement**: the maintainer's operational fact was that Google pulls the previous Antigravity Flash model almost immediately, so 3.6 had to be deprecated in the same commit that introduced 3.7.

**That premise does not hold for this launch, and both halves of the disproof are first-hand:**

1. Google's own `latest-model` guide says Gemini 3.7 Flash "remains fully supported" and still lists it as Stable (see `001`).
2. A live CCA `:fetchAvailableModels` call on 2026-09-03 returns 3.5, 3.6, 3.7 **and** 3.8 wire ids simultaneously (see `002`).

So 3.8 lands **additively**: it becomes the default and the recommended Flash row, while 3.7 stays picker-visible and every existing retirement mapping is left exactly where it is. Copying the 3.7 unit's deprecation section would delete a model the backend is still serving.

## The second decision: wire shape

3.7 expresses its tiers as `thinkingLevel` against ONE wire id (`gemini-3.7-flash-tiered`). 3.8 does not: CCA publishes three suffixed wire ids and no `-tiered` row. That makes 3.8 structurally a **3.6-shaped** model, and it must be registered through `ANTIGRAVITY_EFFORT_WIRE_MAP` (rule 2/3), never through `ANTIGRAVITY_THINKING_LEVEL_MODELS` (rule 1b). Registering it the 3.7 way would send `thinkingLevel` against a nonexistent `gemini-3.8-flash-tiered` wire id.

## Work-phase map (dependency-ordered, PHASE-SPLIT-01)

| Phase | Doc | Consumes | Delivers |
|---|---|---|---|
| wp0 | this folder | — | research + diff-level roadmap |
| wp1 | `010_wp1_antigravity_core.md` | wp0 | `antigravity-models.ts` catalog/ladder/routing + registry default |
| wp2 | `020_wp2_metadata_pricing.md` | wp1 | expected-prices rows, metadata source + regen |
| wp3 | `030_wp3_peripheral_surfaces.md` | wp2 | direct Google seed, free-directory, Cursor seed, sidecar default, docs |
| wp4 | `040_wp4_delivery.md` | wp3 | branch, `--no-verify` push, PR, exact-head CI, merge |

wp1 is first because every later surface keys off the picker id and ladder it establishes. wp2 depends on wp1 because the price overlay is keyed by the picker id and the suffix wire ids wp1 introduces. wp3 is last among the code phases because it is the set of surfaces that merely *reference* the model rather than define it.

## Scope

### IN

- `src/providers/antigravity-models.ts`, `src/providers/registry.ts`
- `src/usage/expected-prices.ts`, `scripts/model-metadata.source.json` (plus `bun run generate:model-metadata`)
- `src/providers/free-directory.ts`, `src/adapters/cursor/effort-map.ts`, `src/adapters/cursor/catalog.ts`, `src/web-search/index.ts`
- `docs-site/` provider and sidecar tables
- focused tests beside the existing Antigravity/catalog/price tests

### OUT

- `src/adapters/google.ts` `GEMINI_DIRECT_WIRE_RENAMES`: no `gemini-3.8-flash-tiered` id is proven on any surface, so adding a rename would invent a wire id. Recorded in `030`.
- `src/providers/model-rename-migration.ts`: nothing is retired by this change, so no new rename entry. The existing 3.6/3.5 to 3.7 entries stay, because 3.7 is still live.
- `RETIRED_FLASH_TIERS` and `ANTIGRAVITY_USAGE_BASE_BY_ID`: unchanged for the same reason.
- Vertex (`google-vertex` `defaultModel` stays frozen), OrcaRouter, OpenRouter, GitHub Copilot.

## Accept criteria (goalplan c-1 through c-7)

1. `gemini-3.8-flash` is one collapsed picker row, not three suffix rows.
2. Each of `low`/`medium`/`high` resolves to its own `gemini-3.8-flash-{tier}` wire id.
3. `gemini-3.7-flash` remains picker-visible and its `-tiered` routing is untouched.
4. Retired 3.6/3.5 ids still route to 3.7 with their recorded tier and stay picker-invisible.
5. Historical usage rows carrying 3.6/3.7 ids still aggregate under their own base.
6. `bun run typecheck` exits 0; only focused test files are run locally.
7. CI green on the exact head SHA and the PR merged into `dev`.
