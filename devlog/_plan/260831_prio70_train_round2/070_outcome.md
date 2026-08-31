# 070 — outcome and receipts

Filled in as each work-phase closes. Every receipt records the command, the host, the
exit code, and pass/fail/skip counts. Local full suites are forbidden for this train,
so suite receipts name `lidge`.

## wp0 — rescan and roadmap (docs-only)

- Status: closing.
- Deliverable: 19 docs — `000` plan with the written-down rubric and component scores,
  `001` scan evidence including below-bar components, `002`-`011` audit syntheses,
  `010`-`060` decade docs for the six >=70 targets, `070` receipts.
- Research: four read-only `gpt-5.6-sol` high-effort lanes, split by cluster. Every
  load-bearing claim was re-verified in-tree by the main session before it entered a
  doc.
- Audit: ten adversarial `gpt-5.6-sol` rounds, all FAIL, each amended rather than
  argued with. Round 1 found nine blockers in the original plan. Round 2 read a stale
  index (my staging error) but produced two real refinements anyway. Round 3 found five,
  four of them **inside round 1's amendments**. Round 4 found four more, including a
  migration hazard that would have refused every manifest on disk. Round 5 cleared wp2
  and wp5. Round 6 cleared wp4. Round 7 cleared wp1 and wp6 — zero findings across five
  phases — and round 8, the first resumed reviewer, closed the exec bridge and found the
  fourth shape wp3 needed. Round 9 confirmed the partition disjoint and found two
  transition defects: pending accepted only two of four shapes, and a D row pulled back
  into C by legacy recovery would have had its user activity erased. Round 10 reduced the
  remainder to one cell — pending + shape C with an expected route event of `1` — where
  two histories produce an identical state and nothing durable separates them, so it
  refuses by design. `002`-`011` record all of it.
- Phases cleared by audit: wp1, wp2, wp4, wp5 and wp6 all drew zero findings in round 7.
  wp3 absorbed five consecutive rounds on a single predicate before round 7 revealed why
  — `rowMatchesExpectedPostImage` already existed in the tree and every version of the
  plan was reimplementing it, each missing a different branch (`008`).
- Round-1 residue: PR #3079 opened for the dangling
  `codex/devlog-entitlement-stack` branch, rebased from `1b862f5b5` onto `dev`
  = `5cec0a33e` as `b1f55b807`.

### What the scan changed about the plan

Recording this because the delta between what the titles suggested and what the tree
says is the actual output of wp0:

- **Two issues came off the board as already fixed.** #1527's four named mechanisms
  are all on `dev` (`c37843502`, `6ec79e443`, `62df78d8d`, `60526d7af`), and #3070's
  traceability half landed in `b68edc077`.
- **One came off as contradicted by the tree.** #3059 asserts a page unmount that
  `gui/src/client-resource.ts:337-345` cannot produce, and could not produce at the
  reported commit either.
- **Three PRs are fixes pointed at the wrong shape.** #3040 fails open on any
  unclassified stop, #3041 can resurrect retired model ids, and #3067 relaxes a
  path-ownership check to a same-segment wildcard. Each found a real defect; each
  remedy would have shipped a worse one.
- **Two PRs carry vacuous regressions.** #3063 changes only production code while
  claiming test coverage, and #3038's tests call the helper directly, so they pass with
  every production call site deleted.
- **One "load-bearing" comment turned out to be a trade, not a law.** The batch
  `query` omission in `src/bridge.ts:149-168` is defended as necessary for codex-rs
  rendering; wp1 trades that rendering for a strict-validator pass and says so out
  loud instead of quietly deleting the comment.
- **Two premises the plan rested on were false, and the audit caught both.** wp3's
  "OpenCodex never writes `has_user_event`" is contradicted at
  `src/codex/history-provider.ts:1158` and `:1013`, with an existing test depending on
  the write. wp5's "one updater" is contradicted by `bin/ocx.mjs:346`, reached via
  `src/update/job.ts:428`, which is the lane the reporter actually used.
- **A unit ambiguity would have made wp4's fix silently vacuous.**
  `shortResetAt` arrives in either seconds or milliseconds — the GUI disambiguates by
  magnitude at `gui/src/components/QuotaBars.tsx:355` — so a freshness comparison
  written against one assumption scores every terminal reading as unknown under the
  other.
- **Four of the five round-3 blockers were in the fixes, not the original plan.** A
  remedy that is right about the defect can still be wrong about its own boundary:
  wp3's tuple test has a reachable false positive via route-then-legacy-recover, wp2's
  release-on-supersession un-reserves right before the synchronous shutdown write,
  wp5's "free" exit codes were occupied by `dispatchCommand` rather than by
  `handleStop`, and wp6's `selfRefreshed === false` conflates external replacement with
  joining an in-flight refresh. Round 1 alone would have shipped all four as working
  code with passing tests.
- **One amendment contradicted its own test plan.** `040` added the freshness gate to
  the contract and left two fixtures describing an account with no `shortResetAt`,
  which the gate scores unknown — the switches those cases assert could never fire.

### Audit outcome — PASS at round 11

Round 11 returned **PASS with zero blocking findings**: the pending+C three-way split is
correct, the `exec`-origin justification holds (`routeExec` moves `exec → cli` and legacy
recovery leaves `cli` alone, so it cannot recreate an original `opencodex/exec/*`), the
refusal removes no restore `dev` performs today, and both new regressions are correctly
red-then-green. Implementation may begin.

Findings per round: 9, 5, 4, 4, 3, 2, 3, 3, 1, 0. Rounds 8-11 were the same reviewer
resumed rather than respawned, so each closure round judged its own prior findings.

### Receipt — wp0 (docs-only)

```
bun test tests/repo-hygiene.test.ts   -> exit 0, 12 pass / 0 fail / 23 expect()
```

That is the focused file covering a tracked `devlog/` change (no-gitlink and
tracked-devlog assertions). No source, test, config or GUI file is touched by wp0, so no
other focused set applies and no `lidge` suite run is warranted for a docs-only phase.

## wp1 — #3071 web_search_call `query`

- Status: pending.
- Receipt: _pending_

## wp2 — #3032 spill disk budget

- Status: pending.
- Receipt: _pending_

## wp3 — #3026 forked-rollout restore

- Status: pending.
- Receipt: _pending_

## wp4 — #3029 terminal short window

- Status: pending.
- Receipt: _pending_

## wp5 — #3008 stop failure taxonomy

- Status: pending.
- Receipt: _pending_

## wp6 — #3019 WHAM 401 refresh

- Status: pending.
- Receipt: _pending_
