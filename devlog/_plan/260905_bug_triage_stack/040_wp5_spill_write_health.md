# 040 — Continuation spill write health projection (#3522)

Work-phase: one full PABCD cycle. Closes (references #3522; stays open per maintainer plan). Carries PR #3525 (supersedes; Co-authored-by: Ingwannu <ingwannu@users.noreply.github.com>).
Source evidence lane output is reproduced below verbatim (diff-level). Stale-check
against the current tree at this cycle's P before implementing.

---

## 1) VERDICT: CARRY_EXISTING_PR

Carry [PR #3525](https://github.com/lidge-jun/opencodex/pull/3525), head `288506dc6883fa8433cf89014e72d01c1675317d`. It is **OPEN / CONFLICTING**, not implemented on inspected HEAD `6d9639165` (origin/dev had moved to `980a9fbed`; the eight PR-touched paths are identical between the two).

## 2) EVIDENCE

Current-dev anchors:

- [src/responses/state.ts:383](/Users/jun/.codex/worktrees/ef41/opencodex/src/responses/state.ts:383):
  ```ts
  } catch {
    if (ref) deleteResponseSpill(ref);
    if (states.get(job.id) === candidate && !job.cancelled) {
      spillCounters.writeFailures += 1;
      replaceWithSpillFailure(job.id, candidate);
  ```
  Exception discarded; no failure class, timestamp, or streak.

- [src/responses/state.ts:2151](/Users/jun/.codex/worktrees/ef41/opencodex/src/responses/state.ts:2151):
  ```ts
  spillWrites: spillCounters.writes,
  spillWriteFailures: spillCounters.writeFailures,
  spillReadFailures: spillCounters.readFailures,
  replayScopeMismatchDrops,
  ```
  The interface at line 2099 contains only the existing 12 numeric fields.

- [src/server/management/system-routes.ts:120](/Users/jun/.codex/worktrees/ef41/opencodex/src/server/management/system-routes.ts:120): `"responseState: responseStateMetrics(),"`. Its health route independently returns `"status: \"ok\""` at line 57.

- [tests/server/memory-watchdog.test.ts:220](/Users/jun/.codex/worktrees/ef41/opencodex/tests/server/memory-watchdog.test.ts:220):
  ```ts
  expect(responseStateValues).toHaveLength(12);
  expect(responseStateValues.every(value =>
    typeof value === "number" && Number.isFinite(value))).toBe(true);
  ```

Conflict analysis:

- PR parent: `99fc38c39d9dc9a9ba76f87e9afefe3e8fb301c0`.
- All **seven other PR-touched paths are byte-identical** between that parent and current dev (`git diff <parent> HEAD -- <seven paths>` is empty).
- The eighth path moved in **`79e03643d7cfa2b6c3c4eb8afd6179a140b197a3`, PR #3518**:
  `tests/memory-watchdog.test.ts` → `tests/server/memory-watchdog.test.ts`.
- Cross-path diff proves only import rebasing: `../src/` → `../../src/`, `./helpers/management-auth` → `../helpers/management-auth`. Thus the carry needs path adaptation, not runtime reconciliation. GitHub’s precise conflict-marker output was not generated.

## 3) DIFF-LEVEL PLAN

**MODIFY these existing files; NEW: none.**

### Runtime

[src/responses/state.ts](/Users/jun/.codex/worktrees/ef41/opencodex/src/responses/state.ts)

Carry PR’s health state, classifier, helpers, metrics, and reset logic:

```diff
- spillCounters.writes += 1;
+ noteSpillWriteSuccess(); // increments writes; clears streak; records now()

- } catch {
-   spillCounters.writeFailures += 1;
+ } catch (error) {
+   noteSpillWriteFailure(error); // increments cumulative + streak; records class/time
```

Apply across async publication, shutdown fallback, atomic replacement, oversized admission, pruning, and budget eviction—not just `runPendingResponseSpill`. Keep existing cancellation/generation guards.

```diff
  spillWriteFailures: spillCounters.writeFailures,
+ spillWriteStatus: spillWriteHealth.consecutiveFailures > 0
+   ? "degraded"
+   : spillWriteHealth.lastSuccessAt !== null ? "healthy" : "initial",
+ spillWriteConsecutiveFailures: spillWriteHealth.consecutiveFailures,
+ spillLastWriteFailureCode: spillWriteHealth.lastFailureCode,
+ spillLastWriteFailureAt: spillWriteHealth.lastFailureAt,
+ spillLastWriteSuccessAt: spillWriteHealth.lastSuccessAt,
```

Classifier: bounded four-level `cause` traversal; closed classes `EACLRETRYEXHAUSTED`, `ETIMEDOUT`, `EACCES`, `ENOSPC`, `EFBIG`, `EIO`, `ECAPACITY`, `ELOOP`, `EUNKNOWN`; map `EPERM→EACCES`, `EDQUOT→ENOSPC`. Never retain raw errors.

Wrap the existing second ACL attempt to classify repeated timeout as exhausted recovery:

```ts
catch (retryError) {
  exhaustedAclRetry = isAclTimeout(retryError);
  throw retryError;
}
// Existing outer catch:
noteSpillWriteFailure(error,
  exhaustedAclRetry ? "EACLRETRYEXHAUSTED" : undefined);
```

[src/server/management/system-routes.ts](/Users/jun/.codex/worktrees/ef41/opencodex/src/server/management/system-routes.ts)

Comment-only carry: numeric-only description → numeric/fixed-enum/timestamp description. Existing forwarding already exposes the new fields. **No auth, health, readiness, restart, or drain changes.**

### Tests

- **MODIFY** [tests/responses/responses-state.test.ts](/Users/jun/.codex/worktrees/ef41/opencodex/tests/responses/responses-state.test.ts): carry failure→failure→success and Windows exhausted-ACL→healthy-runner regressions; update initial/reset/privacy assertions.
  ```ts
  // After two failures:
  { spillWriteFailures: 2, spillWriteConsecutiveFailures: 2,
    spillWriteStatus: "degraded", spillLastWriteFailureAt: 1500 }
  // After successful publication:
  { spillWrites: 1, spillWriteFailures: 2, spillWriteConsecutiveFailures: 0,
    spillWriteStatus: "healthy", spillLastWriteFailureAt: 1500,
    spillLastWriteSuccessAt: 2000 }
  ```
  Strengthen the carry with injected unknown/nested errors containing private sentinel text; assert classification and absence of raw message/path/cause in serialized metrics.

- **MODIFY** [tests/server/memory-watchdog.test.ts](/Users/jun/.codex/worktrees/ef41/opencodex/tests/server/memory-watchdog.test.ts): transplant PR’s old-root hunks; preserve current imports.
  ```diff
  - expect(responseStateValues).toHaveLength(12);
  + expect(Object.keys(body.responseState)).toHaveLength(17);
  ```
  Replace all-number assertion with explicit status/code allowlists, nullable finite timestamps, and finite remaining numeric fields.

- **MODIFY** [tests/responses/continuation-dedup.test.ts:314](/Users/jun/.codex/worktrees/ef41/opencodex/tests/responses/continuation-dedup.test.ts:314): field-count expectation `12 → 17`.

Mappings already exist in [layout.json:768](/Users/jun/.codex/worktrees/ef41/opencodex/scripts/test-layout/layout.json:768), [layout.json:996](/Users/jun/.codex/worktrees/ef41/opencodex/scripts/test-layout/layout.json:996), and [expected fixture:605](/Users/jun/.codex/worktrees/ef41/opencodex/tests/fixtures/test-layout-expected.json:605). No registry changes needed because no new test file is proposed.

Focused verification **to run after carry**, not executed here:

```bash
bun test tests/responses/responses-state.test.ts
bun test tests/responses/continuation-dedup.test.ts
bun test tests/server/memory-watchdog.test.ts
bun test tests/responses/responses-state-write-amplification.test.ts
bun test tests/windows/windows-secret-acl.test.ts
```

### Documentation and attribution

**MODIFY**, carrying PR hunks:

- [docs-site/src/content/docs/reference/management-api.md](/Users/jun/.codex/worktrees/ef41/opencodex/docs-site/src/content/docs/reference/management-api.md): memory metrics description → include five health fields.
- [docs-site/src/content/docs/troubleshooting/windows-memory.md](/Users/jun/.codex/worktrees/ef41/opencodex/docs-site/src/content/docs/troubleshooting/windows-memory.md): add state transitions, privacy contract, authenticated `ocx observe memory --json`; clarify dashboard displays memory/size fields, not necessarily every diagnostic.
- [structure/05_gui-and-management-api.md](/Users/jun/.codex/worktrees/ef41/opencodex/structure/05_gui-and-management-api.md): document process-local projection and unchanged liveness.

Translation follow-up: corresponding `ko/ja/zh-cn/zh-tw/fr/ru/tr` Windows-memory pages currently retain “same fields” dashboard wording; qualify it consistently if carrying the English clarification.

Verified commit author:
```text
Co-authored-by: Ingwannu <ingwannu@users.noreply.github.com>
```

**Risk:** additive diagnostic contract changes numeric-only consumers. Privacy/security review is required for the new error projection under [MAINTAINERS.md:60](/Users/jun/.codex/worktrees/ef41/opencodex/MAINTAINERS.md:60). No credential/auth logic needs modification. Preserve fail-closed ACL checks, bounded retries, publication ordering, cancellation semantics, and replay behavior.

## 4) OPEN QUESTIONS / RESIDUAL UNCERTAINTY

- This fixes **observability**, not the unproven current-version Windows persistence failure. Cached maintainer comments explicitly keep #3522 open pending an exercised current-version snapshot.
- `EACLRETRYEXHAUSTED` was not captured in the original live incident; do not present it as established root cause.
- PR tests were inspected, not executed. No files, Git state, or GitHub state were changed.



## wp5 outcome — NOOP (superseded by merged #3542)

At this cycle's P (2026-09-04T23:45Z) PR #3542 — the maintainer carry of #3525 opened by a
parallel session — was already **MERGED** into `dev` (merge 7eddfb3eb 2026-09-04T23:07:34Z) with exact-head CI 28 pass /
0 fail. It carries every hunk this doc planned (spill write health projection, privacy-safe
error class, `/api/system/memory` fields, tests, docs) with the `Co-authored-by: Ingwannu`
trailer. Opening a second PR would duplicate landed work, so wp5 closes as **NOOP**.

#3522 stays open per the original author's plan (observability fix; the current-version
persistence defect is still unreproduced).

