# O2: [Feature]: Preview integration mutations using the server ownership plan

### Area

Dashboard

### What are you trying to accomplish?

Review which managed configuration fields will change before applying, overwriting, disabling or restoring a client integration.

### What prevents this today?

Existing writers already snapshot, classify foreign edits, publish atomically and journal recovery. [src/server/management/integration-routes.ts:108](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/src/server/management/integration-routes.ts#L108) exposes mutation controls, while [gui/src/pages/integrations/RestoreDialog.tsx:137](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/gui/src/pages/integrations/RestoreDialog.tsx#L137) shows generic consequences rather than the exact bounded planned paths.

### What should OpenCodex do?

Offer a read-only plan from the same server-owned classifier/writer used by mutation. Show change kinds and safe managed paths, never raw before/after values. Bind confirmation to a fingerprint and re-read at commit.

### Example usage or interface

Preview reports that a managed provider URL field will be changed and a snapshot will be created, with a foreign-edit status. If a user edits the file before confirmation, mutation rejects or requires a fresh preview instead of applying the stale plan.

### Alternatives or workarounds

Raw unified diffs can expose credentials/private settings. Client-side inference duplicates server authority. Existing status remains useful but cannot show operation-specific consequences.

### Additional context

Source snapshot: `7864869c31c41cca9830d93540238f17df8faafb` after fast-forwarding `dev` on 2026-09-19. This is source-grounded analysis, not a runtime test result.

This is a reviewability enhancement, not a claim that takeover/restore or transactional recovery is missing.

### Implementation path

1. Extract a pure planning seam in `src/integrations/plan.ts` around existing ownership classification.
2. Add authenticated preview routes and bounded response types in `src/server/management/integration-routes.ts`/`route-registry.ts`.
3. Carry operation+fingerprint from preview response through `gui/src/pages/integrations/integration-api.ts` into existing confirmation dialogs, then validate on mutation.
4. Reuse existing snapshot/rollback/foreign-edit code; do not create a second client-side planner.
5. Add read-only, privacy and stale-preview regressions; update `structure/clients/integrations.md`, management owners and the existing integration guide.

### Acceptance criteria and verification

- Preview performs no config writes, snapshot creation, secret rotation or journal mutation.
- Returned paths are from an allowlisted managed schema, bounded and value-free.
- Unchanged state: confirmed plan matches applied mutation. Changed state: safe refusal/recompute.
- Existing rollback, restore, overwrite and foreign-edit semantics stay intact; dialogs explain the state.

Register new tests in both layout inventories, preserve size caps, and update the existing structure owners. User-facing policy changes need corresponding public documentation and non-contradictory translations. Run focused tests and exact-head hosted CI during implementation; no local suite was run for this analysis.

### Checks

- [x] I searched existing issues and documentation.
- [x] This request describes a concrete OpenCodex workflow rather than merely naming a desired technology.
- [x] I removed secrets and personal data.
