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
