# Maintainer dev integration policy

Depends on roadmap. Class C4; spec-satisfaction. Owner authorizes maintain/admin integration through PRs without a second maintainer approval, including self-authored PRs. Actual inspected roles for both rostered maintainers are admin; current dev rules already permit role 5 PR bypass. The contradiction is primarily normative documentation, plus future Maintain role coverage.

## Exact change map
- MODIFY MAINTAINERS.md review policy and dated change log: distinguish contributor approvals from explicitly opted-in maintainer integration to dev. Preserve actual independent technical/security review and CI duties; do not call self-integration a second-person approval. Main/preview promotions retain existing rules.
- MODIFY AGENTS.md branch/review summary: align with maintainer dev exception; PRs still required, force pushes and deletions still blocked.
- MODIFY scripts/ci/assert-mergeable-review.sh: parse explicit --maintainer-integration in any argv position, retaining optional repository positional argument. Default strict contributor-review path unchanged. Opt-in skips exactly the reviewDecision=APPROVED and qualified non-self approval checks, not review retrieval, objections or race checks. For override, require baseRefName=dev, current authenticated human actor from gh api user, membership in trusted base dev MAINTAINERS roster, and live maintain/admin role. Preserve complete review parsing, maintainer CHANGES_REQUESTED blocking and final head/base/actor authorization recheck. Print truthful integration outcome and --admin --match-head-commit instruction. Never accept a CLI-supplied actor, PR-authored roster, bot or unknown role.
- MODIFY tests/ci-workflows/assert-mergeable-review.test.ts: extend fake gh with actor/base/permissions APIs and cases while retaining all existing default strict cases.
- MODIFY docs-site/src/content/docs/contributing.md and structure/06_docs-and-release.md: link canonical exception and correct Windows dispatch-only whole-suite description found stale in structure.
- External UPDATE dev ruleset 20763889 only: add RepositoryRole actor_id=2 bypass_mode=pull_request, preserve actor_id=5 and all conditions/rules. Read snapshot immediately before update; compare after. Verify role names through GraphQL repositoryRoleName: maintain=2, admin=5; role4 is write and must never be added. Do not change main 20764415 or preview 20764486. Rollback is the saved before JSON projected to accepted API fields.

## Activation matrix and verifier
CI test fixture: authorized admin and maintain actors with no second approval on dev pass ONLY opt-in; write/outsider/bot/missing actor/role API error fail; main/preview/stack base fail; pending maintainer objections, API pagination failures, head/base races fail. Default no flag retains all prior strict failures. shell syntax can be read/checked; Bun tests and typecheck run remotely. Live REST readback proves only dev actor list changed; compare main/preview snapshots unchanged.

## Trust / bypass record
Assets repository integration history; entry script and authenticated GitHub rules API; boundary contributor metadata versus trusted dev roster/live permissions. E7 human policy plus E8 GitHub branch rules; admin can alter rules outside this helper, so helper is an early review check, not universal enforcement. PR bypass does not remove deletion/non-fast-forward rules outside PRs. Security review recorded independently in scratch; final disposition may be published after diff is public.

