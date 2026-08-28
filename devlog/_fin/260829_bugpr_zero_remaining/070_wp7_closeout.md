# wp7 — Terminal closeout

The campaign reached its terminal criterion: the open pull-request query for the `bug`
label returned an empty array after starting at sixteen.

## Landed work

The bug-fix train on `dev` consists of #2835, #2822, #2821, #2785, #2839
(the credited cherry-picks from #2799 and #2798), #2845 (the credited #2638
cherry-picks), #2843 (the #2717 AgentRouter repair), #2842 (the #2810 fake-IP repair),
#2846 (the credited #2828 cherry-picks plus the #2830 repair), #2849 (the #2706 shadow
call repair), #2850 (the #2744 combo-recovery replacement), #2847 (the #2718 keyring
repair), #2844 (the doctor `env_key` repair), #2841 (the #2807 OAuth-origin rebind), and
#2848 (the #2221 native-main refresh repair).

The campaign also merged #2836 to repair the inherited version-line failure, #2840 to
clean up the CI namespace, #2837 for the roadmap and executable review gate, #2852 as the
independent follow-up to #2849, and #2851 as the independent security follow-up to #2850.

## Contributor pull-request dispositions

Pull requests #2799, #2798, #2638, #2828, #2812, #2796, #2797, #2793, #2744, #2497,
and #2807 were closed as landed through the replacement pull requests above. Their close
comments credited the original authors and linked the current-`dev` landing.

The use of `git cherry-pick -x` and `git patch-id --stable` mattered here. It allowed
approved contributor patches to land with authorship intact, while leaving contributor
fork heads alone and avoiding enforce-target checklist resets caused by force-pushes.

## Issue dispositions

Issues #2717, #2810, #2706, #2718, #2830, and #2221 were closed with references to the
merged fixes. Issue #2713 remains open because the doctor change in #2844 covered only
part of the requested behavior. Issue #2833 was closed by its reporter. Issue #2813 was
unreproducible and was not closed as fixed.

## Verification lessons

The version-line keystone demonstrated that a shared base failure can make unrelated
branches look defective. Repairing that base first removed inherited red from six pull
requests and made later branch evidence meaningful.

Green CI was repeatedly insufficient as a completion claim. Independent review found
seven fail-open paths in the review gate, three omitted cross-account origin sites in the
429 repair, caller credentials contaminating the operator's `__main__` health state, a
#2830 branch that never executed, a recovery test satisfied by unrelated plaintext, and a
temporary-file permission ordering flaw. All were fixed before closeout. The strongest
tests were anti-vacuity mutations: reintroduce the defect and confirm that the focused test
turns red.

## Governance gap

Credential-surface changes did not receive a formal non-author approval. Every credential
available in the campaign environment authenticated as the repository owner, and GitHub
does not permit self-review. Independent findings were left as comments and addressed by
follow-up commits and pull requests, but that does not satisfy the formal review rule in
`MAINTAINERS.md`. Future campaigns need a genuinely separate reviewer identity or another
enforceable governance mechanism.
