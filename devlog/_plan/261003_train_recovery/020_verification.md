# Verify final dev and record production readiness

Depends on: reviewed integration landing. No production code change is planned here;
any failing behavior returns to a concrete repair plan and receives fresh evidence.

1. Read .github/workflows/ci.yml at final dev, enumerate expected jobs and supported
   workflow_dispatch inputs. Confirm the selected reference resolves to the landed SHA.
2. Dispatch the existing Cross-platform CI with lane=all on dev, after all train changes
   have landed. Preserve dispatch run ID/event/head SHA/attempt and every expected job.
   Require the returned run headSha to equal the intended candidate. At completion,
   verify dev still equals it or limit readiness explicitly to the tested SHA.
3. Watch one aggregate observation at a time with intervals appropriate for hosted jobs;
   avoid parallel polling by lanes. Pending, skipped, cancelled, approval-blocked and
   failed have distinct recorded outcomes. Do not call a zero-failure empty set passing.
4. Diagnose any failures from the actual job logs, distinguish baseline/environment from
   changed-code failures, and repair authorized regressions through PRs. Rerun only the
   failed/missing jobs only for the same SHA. A repair that changes the candidate needs
   a fresh comprehensive run; do not combine passing jobs from different SHAs.
5. Record final dev SHA, merged PR, original carry/issue dispositions, security review,
   executed Linux/macOS/Windows coverage, GUI evidence and residual live/native limits.
   No release, npm publish, main promotion, install, or deployment is part of this unit.

MODIFY 000_plan.md: append evidence-backed terminal summary and remaining acceptance limits.
NEW 090_outcome.md: concise reader handoff with exact commit/run links and deferred items.
Move this unit to devlog/_fin only after a real terminal outcome is recorded. Public records
contain shipped outcomes, never private vulnerability drafts or raw personal session data.

Proposed CI command is subject to the workflow-source check before execution:
`gh workflow run ci.yml -R lidge-jun/opencodex --ref dev -f lane=all`.
This command has not run during roadmap and does not itself prove a job passed.
