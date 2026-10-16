# 050 — Delivery (wp5)

1. Ordered commits on `codex/260923-p5-ci-release-gaps`: roadmap (wp0), release preflight (wp1),
   release outcomes (wp2), shard balance (wp3), scope-gap checks (wp4), structure docs (with the
   phase that changes the described behaviour).
2. Structure text owners: `structure/ops/cross-platform-ci.md` (release order paragraph, batch
   runner paragraph, narrow jobs) and `structure/ops/docs-and-release.md` (workflow map rows for
   `ci.yml` and `release.yml`, the round-robin sentence). Stay under the manifest line budgets.
3. `git push --no-verify -u origin codex/260923-p5-ci-release-gaps`; open one PR to `dev` with
   every section of `.github/PULL_REQUEST_TEMPLATE.md`, including the security-boundary checklist
   and "local checks: NOT RUN".
4. Read exact-head hosted CI. On failure read the failing job log and fix the cause. Expected new
   legs on this PR: `setup action` x3 and `remote helper` x3 (because `ci.yml` changed).
5. Optional follow-up only if the first CI run shows drift: refresh the table from this PR's own
   Linux shard logs and push once more.
