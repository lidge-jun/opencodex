# Phase 4 — PR and dev integration receipts

Dependency: `wp3`. Recheck every candidate's latest head, base, review state, and comments before any external write. This phase records final disposition and confirms integration; it does not alter main/preview, tags, versions or other lanes.

## Exact external write map

| Target | Action | Before → after |
| --- | --- | --- |
| Carried #5927 and #5497 | ADD appreciative comments linking each replacement PR and merged dev SHA, then CLOSE the superseded originals | Original contribution remains credited by `Co-authored-by` in the replacement branch commit or PR description. Do not close until replacement is on `dev`. |
| Deferred #5995, #3282, #6003, #4732, #3741 | ADD one English comment each with a concrete blocking contract and re-entry proof; KEEP open | #5995 needs permission + multi-turn fixture; #3282 needs model-specific context evidence and reduced non-GUI diff; #6003 needs bounded decoded request handling and deadline/cancellation fixtures; #4732 needs benchmark and snapshot restore semantics; #3741 needs current egress integration and security review. Avoid duplicates if a newer author revision already addresses the blocker. |
| Issues #4213, #4143, #3506, #3765, #5270, #2511 | CLOSE only if a specific merged dev PR actually resolves that issue, with an exact link; otherwise keep open with the reason in `030_issues.md` and GitHub comments | `dev` PR merge does not auto-close an issue. Do not present a partial Images improvement as resolution of both #4213 symptoms. |
| `origin/dev` | READ CI status and latest merge commits | Confirm the required integration workflow for each merged head, then the current dev CI run. If this lane's change breaks dev, fix it through a new authorized PR and recheck. |

## Merge gate repeated per selected PR

1. Fetch current `origin/dev` and compare the candidate branch's merge base. Rebase before push if stale, rerun the affected local checks, and inspect the union for file-size ratchet and exhaustive union/locale/count drift.
2. PR targets `dev`, uses all Summary/Verification/Checklist sections, documents the seven-lane local full-suite exception with exact focused commands/results, includes the original author's `Co-authored-by` trailer, and names any required security review. No screenshots are needed when no `gui/` path changes.
3. Wait for every **required** check on the exact PR head SHA to finish `success`. Check rollup absence, pending, skipped, cancelled, or old-head results are not passing evidence. Resolve valid Codex/CodeRabbit findings and current maintainer objections.
4. Record maintainer integration choice and SHA evidence in the PR, merge through a PR only, fetch and verify dev merge SHA, then inspect dev CI. Never force-push dev.

## Evidence and final report

Append the current PR number, head SHA, exact check run URL/attempt/conclusion, merge SHA, original-PR closure link, issue disposition links, commands/exit codes, and remaining limitations to `000_plan.md`. The final user report lists each assigned PR and issue, the two carried methods, dev CI result, test scope, risk, and overlap files. If a required check or branch protection is pending, keep the relevant PR open and state its exact status instead of claiming completion.
