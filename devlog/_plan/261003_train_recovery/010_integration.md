# Assemble and review the existing patches

Depends on: roadmap closure. Existing production code is not recreated during roadmap.

## Exact baseline delta

In the coordinator checkout on codex/recover-train-261003, preserve current docs commit,
then merge da40c734a558ea32ce391613f5a0309d14cfce81, then origin/dev after a fresh fetch.
Inspect each conflict with both source hunks and the owning invariant; never concatenate
JSON or prose mechanically. Preserve the two existing union fixes 2a3652c4da and
da40c734a5. Exact inherited file deltas are the existing git objects, inspected with
`git diff 762501439442fa00ec950802e9285f72af949167...da40c734a558ea32ce391613f5a0309d14cfce81`.
No deletion or rewrite of original worktrees/branches is needed.

Lane E adds the exact existing issue deltas from 8e2152fa30913955b6640b61b14f6bc522eb3301
and 3fec4a4e312cefe7fe5e11f313e1b6bdefc66148, based on da40c734a5. Their authoritative
before/after patches are `git show <sha>`. The first changes Claude model-force config,
launch env, management routes, CLI, Subagents UI/tests/docs. The second changes RemoteLink
UI, all locale catalogs, its focused tests, docs and structure/remote-link.md.
These are modifications/new files exactly enumerated by `git diff-tree --no-commit-id
--name-status -r <sha>`; no speculative implementation outside those deltas is prescribed.
New defect repairs require a concrete lane plan with paths and activation evidence first.

## Five lane ownerships

- A: original A Responses/SSE/provider/header/log contracts and adjacent tests/docs.
- B: original B account/credit/trust/buffer boundaries and negative tests/docs.
- C: original C platform/CLI/service/shim/desktop zoom and adjacent tests/docs.
- D: original D GUI/usage/compaction/client exports/locale and adjacent tests/docs.
- E: #6313 and #6223 complete implementation, their tests and interface/doc updates.

Each task starts from the same train snapshot in its own managed worktree and uses
inherited subagents for bounded investigation/review. Preliminary dispatch is read-only.
Only after the roadmap closes does the coordinator grant implementation. Each lane
creates its own codex/recover-train-261003-<letter> branch and returns commits; no lane
push/PR/merge/CI permission. Shared locale/layout/docs conflicts are coordinator-owned
at integration time. E resolves conflicts between its two issue patches; main resolves
conflicts between lanes. No concurrent writer touches the coordinator branch.

## Activation and review acceptance

A: forced-answer tool declarations, CR/LF framing, opt-in metadata/header behavior and
ordinary-path stripping; no credential headers. B: default-off credit spending, scoped
provider access, oversized catalog/image/stream bounds and trust rejection. C: quoting
and stopped-port detection, nonblocking mirror reads, stable fnm launch, zoom persistence.
D: rapid visibility toggles, weighted throughput, source-scoped compaction, editor override
preservation and exhaustive locale coverage. E: unset force preserves launch behavior;
set force reaches runtime/CLI/API/UI; invalid model rejected; RemoteLink failed/empty/retry,
manual entry, keyboard access and fingerprint confirmation remain distinct and usable.

Run only explicit focused test files in bounded sequential batches (GUI --isolate).
New tests register both layout maps. Reuse available dependency trees without installing.
Missing dependencies are missing evidence. Coordinate typechecks to avoid resource contention.
Rendered UI evidence must be observed; keep screenshots off the PR branch and publish
through the existing pr-assets mechanism if needed for the final PR description.

## Final integration operation

Inspect lane diffs and negative-path evidence, fix union conflicts and generated maps,
check co-author trailers and docs ownership, record explicit security review. Preserve
required CI and existing maintainer objections. User steering now requires rolling landing: publish the verified A-D candidate first,
then E as a separate follow-up PR. Open each ready PR targeting dev with all template sections, accurate verification limits and
GUI evidence. Attach it to this chat. Revalidate live actor, base, head, reviews, membership
and check evidence before coordinator-authorized maintainer integration. Do not bypass
failed required checks. Use an ordinary PR, not native stack operations.

User delivery correction: do not hold verified A-D behind E. Required checks gate each
PR; the full manual cross-platform run remains after the last dev landing. This changes
delivery order, not scope or verification requirements.
