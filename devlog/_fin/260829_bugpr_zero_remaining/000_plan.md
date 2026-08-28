# 260829 — Bug-PR zero-remaining campaign

This unit records a completed campaign. The repository began with sixteen open pull
requests carrying the `bug` label and ended with none. All changes traveled through pull
requests targeting `dev`; neither `main` nor `preview` moved as part of this work.

## Terminal outcome

Fifteen bug-fix pull requests landed on `dev`: #2835, #2822, #2821, #2785, #2839,
#2845, #2843, #2842, #2846, #2849, #2850, #2847, #2844, #2841, and #2848. Five
campaign-enabling or corrective pull requests also landed: the version-line keystone
#2836, CI cleanup #2840, the roadmap and review gate #2837, and the independent-review
follow-ups #2852 and #2851.

Contributor branches that were superseded by current-`dev` landings were closed with
credit and cross-references: #2799, #2798, #2638, #2828, #2812, #2796, #2797, #2793,
#2744, #2497, and #2807.

Issues #2717, #2810, #2706, #2718, #2830, and #2221 were closed after their fixes
reached `dev`. Issue #2713 remains open because #2844 addressed only part of its scope.
Issue #2833 was closed by its reporter, and #2813 was recorded as unreproducible.

## What changed the campaign

The campaign initially looked like a collection of unrelated red branches. In fact,
`package.json` on `dev` was behind an already-published preview tag, so
`tests/release-version-line.test.ts` failed on every descendant commit. Six bug pull
requests inherited the same failure. Landing #2836 first removed that shared false signal
and was more valuable than repairing any one branch in isolation.

Approved contributor work was carried forward with `git cherry-pick -x`. Before a
replacement landed, its author patch was compared with `git patch-id --stable`. This
preserved authorship and avoided force-pushing fork branches, which would have invalidated
their enforce-target review-readiness checklists.

Independent adversarial review repeatedly found defects after the work appeared complete.
It found seven fail-open paths in the review gate, including pagination data combined with
`jq add` in a way that merged review objects and erased reviewers. It found three more
cross-account origin sites in the 429 recovery work and found caller credentials sharing
the operator account's `__main__` health state. It also found a #2830 repair that could not
execute because it sat behind `orphans.length === 0`, a recovery test that passed on
unrelated plaintext, and secret bytes written before temporary-file permissions were
hardened. Each defect was fixed in public history. Mutation checks that restored the bug
and required the regression test to fail supplied evidence that ordinary green CI did not.

## Open governance gap

Every credential-surface merge in this campaign lacked a formal non-author approval. All
available repository credentials authenticated as the repository owner, and GitHub rejects
self-review. Independent findings were posted as pull-request comments and were repaired,
but comments are not the non-author security approval required by `MAINTAINERS.md`. This is
an unresolved governance gap, not a completed review requirement.

## Record map

The numbered documents preserve the investigation and lane history. `001` and `002`
record the audit corrections. `010` records the version-line keystone. `020` through `060`
record the merge and reimplementation lanes. `070` is the final disposition ledger, and
`080` records the current-head re-audit of #2638 and #2828.
