# CL-09 Passive Production Evidence Implementation Plan

**Goal:** Implement the approved CL-09 V1 contract on `feat/cl-09-passive-production-evidence` without changing canonical Compatibility Lab verdict semantics or production routing behavior.

**Authority:** `devlog/_fin/260807_compatibility_lab/009_cl09_passive_production_evidence.md`

**Current base:** `dev@e8db4e0365b12a314d1c08ec2cf81599efe5b2d3`, a later `dev` descendant of the CL-08 merge `3b8f9487676fe258d76295e49e7db75aca26a4cb` used as the implementation snapshot.

## Task 1 - Exact production-attempt subject linkage

**Files:**
- `src/usage/log.ts`
- `src/routing/compatibility/subject.ts`
- `src/server/responses/core.ts`
- focused request-log/usage/compatibility tests

1. Add RED tests proving an optional exact Lab route-subject ID survives persisted-attempt normalization, malformed values are omitted, and legacy rows remain compatible.
2. Add RED tests proving the production subject resolver preserves existing CL-06 Responses semantics and distinguishes supported inbound protocol surfaces.
3. Add RED request execution tests proving each actual fallback/combo attempt receives the exact subject ID for the route it executed, while subject-link failure never changes request success/failure.
4. Implement only the minimum additive production-path linkage. Reuse the existing Lab `RouteSubjectV1` / `subjectIdForSubject` identity authority. Do not query the Lab ledger, Lab SQLite, history, or network on the request path.

## Task 2 - Bounded passive query layer

**Files:**
- new focused module under `src/lab/query/`
- `src/lab/query/index.ts`
- focused passive-query tests

1. Add RED tests for strict allowlisted output, deterministic bounded scanning/pagination, exact-subject filtering, conservative outcome classification, and deletion/retention behavior.
2. Implement `PassiveRouteSignalV1` as a read-side projection over existing normalized usage history. Do not create a new ledger, SQLite authority, artifact store, or CL-02 event.
3. Expose subject-level summaries for recent attempts, successes, route-error diagnostic signals, and last observed attempt.
4. Keep generic HTTP failures diagnostic/unknown. Passive signals never alter compatibility verdicts or freshness.

## Task 3 - Existing Lab read surfaces

**Files:**
- `src/server/management/lab-routes.ts`
- `src/cli/lab.ts`
- `gui/src/pages/compatibility-matrix-api.ts`
- `gui/src/pages/compatibility-matrix-shared.ts`
- `gui/src/pages/CompatibilityMatrix.tsx`
- minimal Lab i18n/style files only if needed
- focused API/CLI/UI tests

1. Add RED API and CLI tests for bounded passive reads and explicit `not verification` semantics.
2. Add RED UI/shared-model tests proving passive production data is visually separate from canonical Lab verdicts.
3. Implement additive endpoints/commands/components using existing authentication, pagination, and Compatibility Matrix conventions. Do not create a new product area or combined score.

## Task 4 - Adversarial isolation and privacy

**Files:** focused regressions only; production files only if a defect is found.

1. Prove passive capture/read paths cause zero provider sends and no request replay/mirroring.
2. Prove passive data does not change Routing Profile evaluation, Router Intelligence eligibility/score/selection, canonical Lab verdict/freshness, or CL-08 planner output.
3. Seed prompt, response, tool, credential, account, and raw-error canaries and prove none appear in passive API/CLI/UI payloads, Lab JSONL/SQLite/artifacts, or CL-09 diagnostics.
4. Keep existing Shadow Call Intercept tests unchanged and green.

## Task 5 - Verification and handoff

1. Run focused tests through GitHub Actions because this execution environment has no Bun runtime.
2. Verify `bun x tsc --noEmit`, `bun run privacy:scan`, repo hygiene, focused Lab/request/routing tests, Cross-platform CI, React Doctor, and `git diff --check` equivalents/checks in CI.
3. Inspect CodeRabbit/review threads and fix valid findings without widening scope.
4. Update PR #1489 description from contract-only to the delivered implementation and leave it draft for independent final review.
5. Do not merge.

## Implementation status

Tasks 1-4 are implemented on the PR branch. The implementation uses the existing exact `RouteSubjectV1` identity per real attempt, a bounded read-only production-signal adapter over `usage.jsonl`, and additive Lab API/CLI/Compatibility Matrix read surfaces. Focused CL-09 tests cover legacy/malformed linkage, exact fallback attribution, bounded scans/results, strict data minimization with privacy canaries, source-retention behavior, and static no-feedback guards for routing and CL-08 planning.

The final verification gate is intentionally not marked complete here until the exact final head passes required CI/review checks. PR #1489 remains open and must not be merged before independent final review.
