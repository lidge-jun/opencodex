# wp3 — delivery and proof

One pull request against `dev`, filled to `.github/PULL_REQUEST_TEMPLATE.md`, with
`Closes #4546` and `Closes #4550`. Pushed with `git push --no-verify`. No merge: the parent
session performs the admin squash merge.

Proof is hosted CI at the exact final head SHA. The Verification section states that the local
suite, typecheck, install and GUI build were **NOT RUN** for this unit, names the hosted run id,
and reports its conclusion at that SHA. A green run at an earlier head is not proof for a later
one, so any follow-up commit resets the evidence and the new head's run is what gets reported.

Because `enforce-target` resets the contributor readiness checklist on every push, the head
SHA is captured after the final commit, not before.
