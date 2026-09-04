# wp0 verification receipt — docs-only work-phase

Work-phase: wp0 (docs-only roadmap cycle, LOOP-DOCS-FIRST-01)
Branch: codex/260904-fast-row-core
Date: 2026-09-04

## What was produced

devlog/_plan/260904_external_fast_wire/
  000_plan.md                   research + the separator decision + phase map
  005_audit_round1.md           per-blocker disposition + round-2 outcome
  010_wp1_fast_row_core.md      grammar, eligibility, config flag  -> wp1
  020_wp2_listing.md            listing publication                -> wp2
  030_wp3_ingress.md            five-ingress round-trip            -> wp3
  040_wp4_docs_and_landing.md   docs + stacked-PR landing          -> wp4

## Why no test run

No production code changed in this phase; the diff is entirely under devlog/.
Nothing in the build, typecheck, or test path reads from devlog/ (AGENTS.md),
so a focused test would exercise nothing this phase produced. The applicable
verification for a plan is adversarial review, recorded below.

## Verification performed

Eight rounds of independent adversarial audit (gpt-5.6-sol, medium, read-only,
no file writes, no local suite). Every finding was checked against source before
acceptance.

  round 1  FAIL  8 blockers
  round 2  FAIL  appended amendments left docs self-contradictory; the composite
                 guard introduced for B5 was asymmetric and suppressed rows the
                 unit itself publishes
  round 3  FAIL  the known-id set is the wrong oracle for a routable base: bare
                 natives carry no declared models list, so gpt-5.6-sol--fast
                 would be published and then refused at ingress
  round 4  FAIL  fastRowBases named but never defined; nested-marker guard wired
                 into no call site; collision set a placeholder comment
  round 5  FAIL  the wrapper regressed the shipped cursorEffortRows path
  round 6  FAIL  visibleNativeSlugs both reads the catalog and shrinks with
                 runtime state; eager thunk evaluation on the off path
  round 7  FAIL  the Claude predicate was passed unconditionally, which would
                 have enabled the feature on a default install
  round 8  PASS  "No remaining compile, scope, type, behavioral, or
                 underspecified-symbol blocker was found across 010 -> 020 ->
                 030. The plan is ready to implement."

## Criterion closed

c1 — the unit's decade docs map 1:1 onto wp1..wp4.
