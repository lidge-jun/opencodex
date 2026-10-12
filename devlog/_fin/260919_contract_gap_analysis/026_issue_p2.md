# P2: [Feature]: Derive model selector decode hints from all classified registry identity maps

### Area

Catalog / models

### What are you trying to accomplish?

Allow an encoded provider/model selector to round-trip when its native model ID is declared only in an authoritative policy map, without falsely publishing that model as available.

### What prevents this today?

[src/router.ts:107](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/router.ts#L107) gathers known native IDs from a hand-written subset of model-keyed registry maps. [src/providers/registry/types.ts:169](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/providers/registry/types.ts#L169) declares additional identity-bearing maps. The type system permits an ID to exist only in an omitted map. No specific current production failure is claimed.

### What should OpenCodex do?

Classify every registry field whose keys are native model IDs and derive selector decode hints from that classification. Keep decode hints separate from catalog availability and retain ambiguous-selector rejection.

### Example usage or interface

A synthetic registry entry contains `vendor/model-a` only in its wire-default map. Its client-safe encoded selector decodes to that native ID. The hint alone creates no new visible catalog row.

### Alternatives or workarounds

Requiring every policy key in the static models list would interfere with live discovery. Retaining a partial hand-maintained list leaves future fields easy to omit.

### Additional context

Source snapshot: `7864869c31c41cca9830d93540238f17df8faafb` after fast-forwarding `dev` on 2026-09-19. This is source-grounded analysis, not a runtime test result.

Adjacent closed #4730 concerns catalog slug collisions, not completeness of registry decode hints. Treat this as a bounded robustness proposal, not a live incident.

### Implementation path

1. Add `src/providers/registry/model-ids.ts` with a typed classification/helper.
2. Replace the manual map list in `knownModelIdsForProvider` while retaining config IDs, transport identity checks and stale discovered hints.
3. Classify maps carefully: not every object key is a model ID. Make new model-keyed fields require an explicit classification decision.
4. Extend `tests/codex-integration/slug-codec.test.ts` and registry parity coverage using a model present only in each formerly omitted map. Update `structure/catalog.md` and `structure/providers-and-adapters.md`.

### Acceptance criteria and verification

- Each classified map independently supplies decode hints.
- Unknown/ambiguous encoded IDs retain current fail-closed or pass-through behavior as applicable.
- Transport-mismatched custom providers do not inherit unrelated registry IDs.
- Decode hints never create catalog rows or availability claims.

Register new tests in both layout inventories, preserve size caps, and update the existing structure owners. User-facing policy changes need corresponding public documentation and non-contradictory translations. Run focused tests and exact-head hosted CI during implementation; no local suite was run for this analysis.

### Checks

- [x] I searched existing issues and documentation.
- [x] This request describes a concrete OpenCodex workflow rather than merely naming a desired technology.
- [x] I removed secrets and personal data.
