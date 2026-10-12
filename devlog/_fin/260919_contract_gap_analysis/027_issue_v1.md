# V1: [Feature]: Separate contract authority from source review fan-out in the structure manifest

### Area

Documentation

### What are you trying to accomplish?

Let maintainers find one authoritative statement for each cross-cutting contract while still reviewing all documents affected by a source-area change.

### What prevents this today?

[scripts/structure-ssot.ts:31](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/scripts/structure-ssot.ts#L31) represents related source paths but no contract owner/dependent distinction. [structure/AGENTS.md:45](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/structure/AGENTS.md#L45) makes every mapped document an update obligation; [structure/INDEX.md:126](https://github.com/lidge-jun/opencodex/blob/7864869c31c41cca9830d93540238f17df8faafb/structure/INDEX.md#L126) maps the broad server area to many documents. Repeated cross-cutting preambles already appear in runtime/config/transport documents.

### What should OpenCodex do?

Keep many-to-many source review coverage, add stable contract authority links and distinguish review obligations from actual content changes. Consumer docs link to the owner instead of repeating the same normative prose.

### Example usage or interface

A change under `src/server/` still lists every relevant document for review. A named streaming contract points to one owner anchor; only changed dependent explanations need edits. No automatic claim of semantic proof is made from link validation.

### Alternatives or workarounds

A prose-only cleanup is smaller but leaves authority navigation manual. One owner per source directory is explicitly wrong for this repository and is not proposed.

### Additional context

Source snapshot: `7864869c31c41cca9830d93540238f17df8faafb` after fast-forwarding `dev` on 2026-09-19. This is source-grounded analysis, not a runtime test result.

This preserves the existing checker and mutation-tested structural guards. It does not replace structural invariants with runtime-only tests.

### Implementation path

1. Add a versioned optional `contracts` section in `structure/manifest.json`: stable ID, owner document+anchor, dependent documents.
2. Update `scripts/structure-ssot.ts` parsing, validation and index generation; reject duplicate IDs, missing files/anchors and invalid dependents.
3. Regenerate `structure/INDEX.md`; never hand-edit generated output.
4. Amend `structure/AGENTS.md` to require review of all mapped documents and updates to the owner plus affected dependents.
5. Migrate a few existing duplicated contracts with preserved links before expanding coverage. Extend `tests/ci-workflows/structure-ssot.test.ts` with malformed-manifest and generated-output cases.

### Acceptance criteria and verification

- Existing many-to-many source ownership remains accepted.
- Duplicate/missing authority entries fail the checker; valid consumer links appear in generated navigation.
- Unrelated source changes do not require copied unchanged-behavior prose.
- The checker continues to claim topology and declared binding only, not behavioral correctness.

Register new tests in both layout inventories, preserve size caps, and update the existing structure owners. User-facing policy changes need corresponding public documentation and non-contradictory translations. Run focused tests and exact-head hosted CI during implementation; no local suite was run for this analysis.

### Checks

- [x] I searched existing issues and documentation.
- [x] This request describes a concrete OpenCodex workflow rather than merely naming a desired technology.
- [x] I removed secrets and personal data.
