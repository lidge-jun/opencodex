# Audit record — roadmap gate

An independent reviewer (a separate context, `gpt-6-astra` at high effort) audited
the roadmap before any branch was built. Three rounds ran; the first two failed.
The findings are recorded here because they changed the plan, and because two of
them would have produced a false completion claim.

## Round 1 — FAIL, four blocking defects

1. **Overstated CI coverage.** The plan promised platform and packaging coverage
   from the tip pull-request run. In fact `windows <n>/6` and `macos control` are
   `workflow_dispatch`-only (`ci.yml:633`, `742-743`), and `npm-global` needs
   `packaging == 'true'`, which the packaging allowlist (`ci.yml:215-229`) does not
   set for any of the four files. Fixed by adding an explicit RUN vs
   SKIPPED BY WORKFLOW matrix and forbidding the skipped families from being
   reported as passes.
2. **CI success treated as sufficient for merge.** `enforce-target` folds
   deterministic hygiene failures into its verdict (`enforce-pr-target.yml:679-692`)
   and `pr-hygiene` fails and labels on a violation (`pr-hygiene.yml:236-238`).
   `MAINTAINERS.md:61` also requires the integration decision and exact-head
   verification to be recorded. Fixed by adding those gates and the record step.
3. **Wrong ancestry object.** The plan checked whether the tip commit was an
   ancestor of `dev`. A squash merge never makes the tip an ancestor, so that check
   would have failed on a perfectly good landing — or worse, been waved through.
   Fixed by recording the squash SHA GitHub returns and testing that.
4. **Attribution assumed rather than controlled.** The repository sets
   `squash_merge_commit_message: COMMIT_MESSAGES`, so the pull-request description
   is not the landed message. A description trailer satisfies the hygiene checker
   and still leaves the contributor uncredited in the commit. Fixed by supplying the
   squash body explicitly and verifying the landed trailer before closing anything.

## Round 2 — FAIL, two blocking defects

1. **Missing administrator bypass.** `Protect dev` requires an approving review and
   code-owner review, so the merge call is refused without `--admin`. The plan named
   the policy exception without naming the mechanism that exercises it.
2. **Bot findings mistaken for all findings.** The gate covered automated review
   findings but not human ones. `MAINTAINERS.md:62-64` requires outstanding
   maintainer change requests to be resolved or explicitly withdrawn.

## Round 3 — PASS

The reviewer set the phase-1 acceptance bar: freshly fetched base SHA, both
constructed commit SHAs, evidence that layer 1 follows the base and layer 2 follows
layer 1, both authors reading `luvs01`, both `-x` provenance lines, per-layer and
cumulative name/numstat comparisons, blob comparisons against the source pull
requests, and the roadmap commit accounted for separately so it stays out of the
four-file implementation delta.

## Standing note

Local suite, typecheck and build are **NOT RUN** for this unit by owner
instruction. That is a recorded absence of evidence, not a pass.
