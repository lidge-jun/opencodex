# wp4: Publish and verify the manual stack

Dependency: three implementation cycles complete. This phase changes only the
unit's evidence/closure documentation unless review or CI reveals a scoped defect.
A defect requiring code returns to its owning work phase and cascades descendants.

## Publication map

1. Push codex/cli-ux-help-foundation and create templated PR against dev.
2. Push codex/cli-ux-navigation and create PR against foundation.
3. Push codex/cli-ux-recovery and create PR against navigation.
4. Attach every PR URL to this chat and update each body with exact stack links,
   layer-specific behavior, commands/results and any unverified coverage.

Use .github/PULL_REQUEST_TEMPLATE.md sections unchanged. No native stack
registration, merge, auto-merge, workflow bypass, skip-ci or release. Changes do
not touch gui, so no GUI screenshot is required. Retain exact root/leaf/error
terminal samples for human review. No reference clone or private data is staged.

## Validation and evidence

- Verify ancestor relation, per-layer diff and remote head/base for each PR.
- Read required checks for each current head and actual tested SHA/event; missing,
  skipped/cancelled or older-head jobs are not passing evidence.
- Address independent review findings and task-caused CI failures in the owning
  layer, propagating lower changes upward. Do not mask unrelated baseline errors.
- Full suite is default before review readiness. A genuine resource exception
  records focused commands, reason, missing coverage and draft state where needed.
- Refresh required checks after every push. Poll with bounded intervals and retain
  run/check identifiers; do not rerun passed checks without a changed reason.
- Write 090_outcome.md with PR URLs, SHAs, verification and remaining limits, then
  archive this unit to devlog/_fin after its terminal published outcome is recorded.

DONE is published, reviewed and validated scope with evidence. No claim of merge
or live installation is part of the result. Goal completion requires all bound
criteria and completed PABCD cycles, not just successful Git commands.

## P revalidation: resume actual publication

Draft PRs already exist:6498(help foundation),6500(navigation),6503(recovery).
Reuse them; do not create duplicates. Publication began after each implementation
cycle so its CI could run while the next layer progressed. Complete reciprocal
stack links and layer-specific evidence in all three template bodies and verify
attachments. The current navigation head includes the independently reviewed
restore-help test migration; preserve that parent ancestry.

Verify remote head/base SHAs, layer-only diffs and ancestor relationships. Read
native-stack membership independently; confirmed empty is manual, unavailable is
unknown. No registration/conversion/dissolution/merge or other repository-policy
changes. Source repairs must land in their owning layer and propagate upward.

Readiness limitation is concrete, not a resource exemption: the local full suite
had four failures, three reproduced on baseline and one snapshot failure remains
unresolved. All PRs stay draft. Affected-scope and hosted checks are separate
facts and never retroactively make that local run pass.

Write090_outcome.md as a terminal PUBLISHED_DRAFT outcome with these limitations,
then archive the unit to_fin on the stack tip. A docs-only closure commit creates
a new final head: verify its required CI before final delivery. Record exact final
SHA/run/check evidence in PR bodies and the local delivery receipt after commit;
do not create an endless self-referential documentation-commit cycle.

DONE for this goal means completed requested draft publication, verified topology,
independent implementation reviews and accounted current-head CI. It does not
mean full-local-suite success, review readiness, merge, release or installation.

CI exposed a deterministic two-clock-read deadline extension in the unchanged
CLI restart observer.041 specifies a local C1 prerequisite fix and regression,
separate from UX diffs. Publication now includes that small predecessor plus the
three existing UX PRs; preserve their numbers, rebase/cascade owned heads, and
recheck each new head. No retries-as-fix or timeout/assertion relaxation.
