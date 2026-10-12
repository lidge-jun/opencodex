# P1: [Feature]: Resolve static model policy once for catalog and routing consumers

### Area

Multiple areas

### What are you trying to accomplish?

Keep client-advertised capabilities and runtime static policy consistent when provider registry defaults or operator overrides change.

### What prevents this today?

Policy fields are merged independently during preset materialization, enrichment, routing and catalog correction: [src/providers/derive.ts:221](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/providers/derive.ts#L221), [src/providers/derive.ts:473](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/providers/derive.ts#L473), [src/router.ts:300](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/router.ts#L300), [src/codex/catalog/model-hints.ts:105](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/codex/catalog/model-hints.ts#L105). The catalog correction documents prior drift. This is repeated authority, not proof of a currently failing model.

### What should OpenCodex do?

Introduce one immutable resolved static-policy result with explicit field-level precedence. Catalog and routing consume it; late account, credential, quota, health and observed transport evidence remain separate. Preserve existing wire pins and explicit operator opt-outs.

### Example usage or interface

A registry default and explicit per-model override produce the same supported effort/window/semantic policy in catalog and route projections. Later credential changes may rebind transport but must not silently replace unrelated static policy. Unknown capabilities remain unknown.

### Alternatives or workarounds

A universal numeric priority or a static copy of account health would erase distinct authority rules. A descriptor-driven shared merge is a valid smaller alternative to a rich request-wide object.

### Additional context

Source snapshot: `7864869c31c41cca9830d93540238f17df8faafb` after fast-forwarding `dev` on 2026-09-19. This is source-grounded analysis, not a runtime test result.

#3377 owns additional user-declared capability axes; this issue owns consistent consumption of existing static policy. #4579 was read and concerns execution authorization, not this metadata merge. #2358 remains the wider compatibility roadmap.

### Implementation path

1. Inventory each duplicated static field and its current precedence; add parity fixtures before changing consumers.
2. Add `src/providers/resolved-model-policy.ts` or a shared field-descriptor resolver; do not introduce a new policy language.
3. Migrate `src/providers/derive.ts`, `src/router.ts`, `src/codex/catalog/model-hints.ts` and `gather-capture.ts` incrementally. Preserve gather-flight authority capture.
4. Route adapter static selection through the result in `src/server/adapter-resolve.ts`, preserving late binding in `src/server/responses/request-transport.ts`. If adding a RouteResult field, enumerate builder, every consumer and snapshots; no persistence serializer is needed unless persistence is explicitly added.
5. Add `tests/providers/resolved-model-policy.test.ts` and parity/cold-catalog cases. Update `structure/providers-and-adapters.md`, `structure/catalog.md`, `structure/config.md` and routing owners.

### Acceptance criteria and verification

- Existing precedence is byte/behavior-equivalent for current fixtures before cleanup.
- Registry default, explicit override, custom row, unknown and discovered hints are compared across catalog and route consumers.
- Live evidence cannot widen a static hard limit; credentials/health do not become frozen request policy.
- Hard pins, aliases and explicit false values retain their meaning.

Register new tests in both layout inventories, preserve size caps, and update the existing structure owners. User-facing policy changes need corresponding public documentation and non-contradictory translations. Run focused tests and exact-head hosted CI during implementation; no local suite was run for this analysis.

### Checks

- [x] I searched existing issues and documentation.
- [x] This request describes a concrete OpenCodex workflow rather than merely naming a desired technology.
- [x] I removed secrets and personal data.
