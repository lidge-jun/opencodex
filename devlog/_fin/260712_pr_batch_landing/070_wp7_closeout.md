# WP7 — Closeout

## Steps

1. `gh pr list --state open` — confirm none of #96–#103 open.
2. `gh run list --branch main --limit 3` — latest run green (CI runs on main push).
3. Fast-forward dev: `git push origin origin/main:dev` (dev==main precedent, keeps flow intact).
4. PR comments: each merged PR gets a short disposition comment naming the review fix folded in
   (#96 security hardening amendments, #97 gate restore, #99 cancellation guard) so the fork
   author sees what changed on their branch. Approved-as-is PRs need no comment beyond merge.
5. Devlog: `_fin` holds decade-numbered feature units (100_*, 110_*...), while dated units
   stay in `_plan` (precedent: 260710_codex_warmup_preview_release) — this unit STAYS in
   `_plan`; append a DONE section to 000_plan.md with merge SHAs. Commit devlog updates to main.
6. Goalplan: mark criteria met with captured evidence; `cxc loop validate` must pass (E8).

Expected repository diff: devlog unit updates only (000 DONE section); everything else is
PR-state/CI verification (merge-only closeout). Rollback policy: 000 §Rollback.

## Accept criteria

- c8: zero open batch PRs + disposition comments posted.
- c9: latest main CI run success.
