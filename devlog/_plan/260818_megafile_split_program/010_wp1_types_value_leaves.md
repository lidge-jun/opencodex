# WP1 — types.ts value-leaf extraction (stacked PR 1 of the split program)

Unit: devlog/_plan/260818_megafile_split_program. Risk basis: 000_risk_assessment.md.
Branch: codex/split-wp1-types on dev @ b04cd26e7 (post FastWire B0/B1 merge).
Class: C2 (mechanical move, shared-runtime file, full-suite gate).

## Loop spec

- Archetype: pure-move refactor, zero behavior change.
- Trigger: split program WP1, lowest-risk opener.
- Goal: src/types.ts stops carrying runtime value code; values live in leaves;
  every existing import keeps working via re-export.
- Non-goals: NO type-cluster split yet (OcxConfig/OcxProviderConfig stay),
  NO consumer retargeting to leaf paths, NO behavior or signature change.
- Verifier: bun run typecheck && bun run test (full — shared runtime file).
- Stop: both green + core-lab-boundary green; PR opened against dev.
- Memory artifact: this doc + ledger attests.

## Scope (IN)

Extract the two VALUE clusters from src/types.ts (1867 lines) into leaves:

1. src/types/tools.ts — lines ~236-292:
   namespacedToolName, toolChoiceAliases, toolAllowedByChoice,
   resolveToolChoiceWireName, modelInList, OcxToolChoice (type),
   isAllowedToolChoice, toolChoiceToolPredicate.
   Needs `import type { OcxTool } from "../types"` — type-only, erased at
   runtime, so the types.ts -> tools.ts re-export is NOT a runtime cycle.
2. src/types/wire.ts — lines ~1760-1839:
   UPSTREAM_HTTP_VERSION_VALUES, UpstreamHttpVersion, 
   REASONING_SUMMARY_DELIVERY_VALUES, ReasoningSummaryDelivery,
   CodexAccountMode, OPENAI_PROVIDER_TIER_VERSION,
   MODEL_ADAPTER_OVERRIDE_ALLOWED, ANTHROPIC_WIRE_MODELS (internal),
   anthropicWireModelsForProvider (internal), captureWireAdapterHardPins,
   isWirePinnedModel, pinnedWireAdapter. Self-contained, no imports.

src/types.ts keeps every current export via `export ... from "./types/..."`;
type-only names re-exported with `export type`.

## Scope (OUT)

- All interface/type clusters stay in types.ts this PR.
- No import-path changes anywhere else in src/ or tests/.
- No lab imports anywhere new (types is on the protected graph as a value
  import from responses/core.ts: modelInList, namespacedToolName).

## File change map

- ADD src/types/tools.ts (~60 lines incl. docs)
- ADD src/types/wire.ts (~85 lines incl. docs)
- EDIT src/types.ts: delete moved bodies, add two re-export blocks at the
  same positions; net -120 lines.

## Accept criteria

1. bun run typecheck exit 0.
2. bun run test full suite: same pass count as base (13k+), 0 fail.
3. tests/core-lab-boundary.test.ts green (covers the new static edges
   types.ts -> types/tools.ts, types/wire.ts on the protected walk).
4. rg confirms no consumer file changed: git diff --stat touches exactly 3
   files.
5. Value identity preserved: MODEL_ADAPTER_OVERRIDE_ALLOWED still a single
   ReadonlySet instance (only one declaration site, re-export not re-create).

Activation grounding: criterion 3's scenario is the existing boundary test
run; criterion 5's scenario is the full suite (service-tier tests compare
set membership through both import paths).

## Verifier reality (PLAN-VERIFIER-REAL-01)

- bun run typecheck: exists in package.json, reads src/ via tsconfig
  include ["src"] — observes both new files. To be run in C.
- bun run test: tests/ suite imports ../src/types in 400 files — observes
  the barrel; core-lab-boundary walks the import graph from the three
  protected roots which reach types.ts — observes the new edges.

## Stacked-PR plan (DEV-STACK-01)

PR 1 (this): value leaves + barrel. Target: dev.
PR 2 (next cycle): type-cluster split (request/config/provider/accounts)
stacked on PR 1's head branch.
Later cycles per 000_risk_assessment.md order (config leaves, registry, ...).

## Audit amendments (A-phase, 2 auditors: grok-4.6 NEAR-PASS / gpt-5.6-sol FAIL->fixed)

1. CYCLE FIX (sol blocker): OcxTool (lines 211-232) moves INTO types/tools.ts.
   tools.ts imports NOTHING from ../types — dependency is strictly one-way
   (types.ts -> types/tools.ts). types.ts re-exports OcxTool as a type.
2. RECIPE FIX (grok finding 7): `export type { X } from` does not BIND X in
   the barrel. types.ts still uses OcxTool (line 106), OcxToolChoice (299),
   UpstreamHttpVersion (1455), CodexAccountMode (1470),
   ReasoningSummaryDelivery (1574) — so the barrel adds a local
   `import type { OcxTool, OcxToolChoice } from "./types/tools"` and
   `import type { UpstreamHttpVersion, ReasoningSummaryDelivery,
   CodexAccountMode } from "./types/wire"` next to the Kiro import.
3. OcxToolChoice + its guards travel with tools.ts (they are one cluster).
4. Extensionless specifiers only (lab walker resolves `${base}.ts`).
5. AC4 corrected: scope proof = `git diff --stat <base>..HEAD -- src tests`
   showing exactly 3 src files; devlog/plan files are committed separately.
6. AC5 proof corrected: identity is preserved by ESM re-export semantics
   (single declaration site); drop the false 'both import paths' claim.
7. Protected-roots note corrected: PROTECTED has 4 files; only
   responses/core.ts puts types.ts on the runtime graph (core.ts:63).

