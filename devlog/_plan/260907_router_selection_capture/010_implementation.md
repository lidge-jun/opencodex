# Issue #3894: implementation plan

Satisfy-spec work, triggered by issue #3894 and the request to implement separate draft PRs. Goal: remove the direct router/selection mutation dependency. Non-goals: changing key resolution/failover or eliminating all transitive router cycles. Stop after verified draft PR; report unresolved gates. Escalate if extraction requires behavioral changes. This file records plan and evidence.

Class C2: one pure helper extracted in the existing provider module convention. Independent branch from 522ce5f8c.

Current map: router imports api-key-selection for capture; api-key-selection imports router for route resolution. Existing direct helper callers: router and matchesSelection. No package exports change.
Chosen map: both modules import api-key-selection-capture; the old api-key-selection export forwards the same function. New leaf uses only existing OcxProviderConfig and ProviderApiKeySelection type imports.
Rejected alternative: extracting routedProviderConfig would move broad routing dependencies. Other existing transitive cycles stay outside scope.

File map:
- NEW src/providers/api-key-selection-capture.ts: the existing function body unchanged, plus the two type-only imports.
- MODIFY src/providers/api-key-selection.ts: replace local implementation with named import and compatibility re-export.
- MODIFY src/router.ts: change capture import to the leaf.
- NEW tests/providers/api-key-selection-capture.test.ts: selected/unmatched/missing/duplicate pool cases, immutable snapshot, old-export identity, and Bun-parsed runtime import boundary for leaf and router. Parse actual source, exclude erased type imports; no whole-router acyclicity assertion.
- MODIFY scripts/test-layout/layout.json and tests/fixtures/test-layout-expected.json: register the new test using existing providers domain entries.
- MODIFY structure/01_runtime.md: document the helper ownership and preserved stateful selection direction.

Verification: helper tests; key-failover, provider-key-store and core-lab-boundary tests; test-layout guards; typecheck; privacy scan. Baseline focused run on unchanged code: 49 passed. Conditional test cases have concrete provider objects; boundary regression returns offending imports rather than scanning prose.

Audit: extraction is a functional dependency with no mutable globals and no changed auth behavior. Old export is preserved. A boundary test targets this exact scope; broad graph cycles are not called fixed.

## Verification before draft publication

- `bun install --frozen-lockfile`: passed; lockfile unchanged.
- Baseline key-failover/provider-key-store/Lab-boundary run: 49 passed.
- Restoring the old router import made the new boundary regression fail; restoring the extraction returned it to green.
- `bun test tests/providers/api-key-selection-capture.test.ts tests/adapters/key-failover.test.ts tests/providers/provider-key-store.test.ts tests/lab/core-lab-boundary.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts`: 73 passed, 0 failed.
- `bun run typecheck`: passed.
- `bun run privacy:scan`: passed.
- Review scope covers the 10-line pure helper, two consumers, compatibility re-export, 7 new tests, two layout entries, and the runtime ownership row. No other router cycle is claimed resolved.
- Whole-suite/maintainer approval is not attested; this is a draft handoff.
