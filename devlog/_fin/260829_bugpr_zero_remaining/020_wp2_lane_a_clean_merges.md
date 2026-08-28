# wp2 — Contributor patch preservation

This lane completed through #2839, which landed the credited patches from contributor pull
requests #2799 and #2798. Both contributor pull requests were then closed as landed with
cross-references.

The campaign did not force-push the contributor fork branches. A force-push would have
reset the enforce-target four-box readiness checklist and detached the existing review
evidence from the branch state. Instead, the approved commits were applied to a
maintainer-owned current-`dev` branch with `git cherry-pick -x`.

Before landing, the original and carried-forward patches were compared with
`git patch-id --stable`; authorship and patch intent were preserved. Focused tests covered
the catalog verbosity behavior from #2799 and the destination-policy behavior from #2798.

#2798 touched a credential destination boundary. Its findings were addressed, but it is
part of the campaign-wide governance gap recorded in `070_wp7_closeout.md`: no available
credential could provide a formal non-author approval.
