# 000 — dev integration and release readiness (2026-10-02)

Objective: land #6441 and #6448 on `dev`, then leave the final `dev` head release-ready short of promotion.
Coordinator session 01a0fc1e-d5ec-7180-a0e8-9ef1646f7166; goalplan `integrate-two-open-prs-into-lidge-jun-opencodex`.

## Loop spec (C2, HOTL)

- Tool/credential scope: `gh` as lidge-jun (maintainer, admin merge per MAINTAINERS.md), git in the linked worktree
  `/Users/jun/Developer/new/700_projects/opencodex/.tmp/lanes/integrate` (session source, detached).
- Write scope: this unit (local, not pushed); #6448 branch `codex/opengateway-provider` files
  `src/codex/catalog/routed-gather.ts`, two new test files, the two test-layout JSON files,
  `structure/catalog.md` and `structure/providers-and-adapters.md` (one ordering sentence each).
- Forbidden: local tests of any kind (standing user instruction), promotion to preview/main, npm publish, tags, releases,
  edits to other PRs, rewriting #6448 history (an Aside agent polls it from worktree og01).
- Budget: one hosted CI run per pushed head; reruns only for a failure classified with evidence. Wall clock: this session.

## Work-phase map (dependency order)

| wp | Doc | Depends | Closes with |
|---|---|---|---|
| wp0 | this unit | — | audited roadmap |
| wp1 | 010_pr6441_land.md | wp0 | #6441 merged, decision comment |
| wp2 | 020_pr6448_review_fixes.md | wp1 | fixes pushed once, exact-head CI green, threads resolved, #6448 merged |
| wp3 | 030_release_readiness.md | wp2 | dev-head Cross-platform CI + Service lifecycle green, readiness report |

wp2 depends on wp1 only for merge sequencing: both touch neither the same source file nor the same tests, but each merge
moves `dev`, so #6448 is re-checked with merge-tree against the post-#6441 head.

## Verifiers (PLAN-VERIFIER-REAL-01)

Local tests are forbidden, so every test verifier is hosted:
- PR Cross-platform CI (`.github/workflows/ci.yml`) test shards run the whole `tests/` tree; reads the new files under
  `tests/providers/` and `tests/codex-integration/`. Exact-head evidence: `gh pr view <n> --json statusCheckRollup`.
- Windows-only wrapper test (`tests/windows/windows-service-wrappers.test.ts`, `skipIf(platform !== "win32")`) runs only in
  the windows shards, which a PR run path-filters out; it is observed in the wp3 workflow_dispatch run (grep the shard log).
- Service lifecycle (`.github/workflows/service-lifecycle.yml`) installs the real service per OS; on #6441's head run
  36989691470 linux-systemd, macos-launchd and windows-schtasks passed (normal-start path of the new wrapper).
- Static local evidence only: `git merge-tree`, file reads, JSON parse, `gh` reads.
