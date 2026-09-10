# Phase 4: final hosted validation

Depends on phase 3. Inspect final chain ancestry and fresh PR heads, base identities and review state. No workflow, branch protection or cancellation changes. Push only with --no-verify and create draft template-complete ordinary PRs. Existing hosted workflows run on final cumulative tip; request their supported all lane through existing dispatch only if applicable. Record workflow event/ref, head SHA, run ID/URL and result. Missing/skipped/cancelled native confinement is not passing evidence.

No product implementation is planned in this validation phase. If final CI reveals a regression, amend this roadmap with a named repair cycle and source/test map before editing. Keep source-only checks distinct from executable CI. Record original PR #3458 disposition, coauthor trailer, current chain, full commits/heads, outstanding maintainer reviews, and original foundation exclusions in ignored durable handoff. Parent alone decides merge or original closure.

Acceptance: final hosted typecheck/suite and applicable native confinement outcomes at the same SHA, no fake pass from old source runs; UI render observation at current tree or explicit unresolved gap. No local suite is permitted. No live devices, remote files or deployment are part of verification. DONE requires evidence; otherwise retain unfinished criteria and report the precise missing requirement.

## Evidence reachability matrix

| Path | Activation needed | Generic suite meaning |
| --- | --- | --- |
| Codex real runtime | OCX_CODEX_BIN configured in isolated hosted job | Missing env is skipped, not verified |
| Claude real runtime | OCX_CLAUDE_BIN configured | Missing env is skipped, not verified |
| Pi real runtime | OCX_PI_BIN configured | Missing env is skipped, not verified |
| Linux confinement | bwrap + OCX_REQUIRE_LINUX_REMOTE_WORKSPACE_CONFINEMENT=1 | Early return is not confinement proof |
| Windows native helper | cargo build + live AppContainer probe | Not invoked by current workflow |
| macOS native helper | cargo fail-closed probe/direct-run | Not invoked by current workflow |

Hosted mock lifecycle tests and source review retain their narrower meaning. Any unavailable path stays in final handoff acceptance, even if aggregate CI is green. No workflow changes or live-machine pairing are authorized.
