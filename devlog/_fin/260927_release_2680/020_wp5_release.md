# 020 — wp5: release 2.68.0

Values for the 2.67.0 procedure: `CAND` = `origin/dev` after wp4 merges; `PV=2.68.0-preview.20260927`;
pre-move `dev-version-bump.yml --ref main -f intended-version=2.68.0 -f mode=pre-move` (dev → 2.69.0);
promotion branches `codex/260927-release-preview-2.68.0` and `codex/260927-release-main-2.68.0` built
with `git merge -s ours` and `scripts/release-version-sources.ts`; merge commits (never squash); push-event
CI and Service lifecycle at both promotion SHAs; `release.yml` preview first, then stable; verify npm
dist-tags, both GitHub releases' assets, and `latest.json` signatures; fast-forward local branches.

Heuristic CI rule (owner): a failing job blocks only when it reproduces on rerun or its log points at a
change in main..dev. Runner-stall signatures get one job rerun.

## wp5 P revalidation (2026-09-27)

- `CAND=f764765c6453a718806d3465ea966015fa233123` (`origin/dev` after #6052). Lane=all run `36294278068` (workflow_dispatch) at CAND.
- `main` `4bc92294aa` (2.67.0, npm latest), `preview` `9c6fb1ee8b` (2.67.0-preview.20260926), `dev` 2.68.0.
- `PV=2.68.0-preview.20260927`. Pre-move: `gh workflow run dev-version-bump.yml --ref main -f intended-version=2.68.0 -f mode=pre-move`
  (inputs verified on `origin/main`); its PR must change only the four version sources to 2.69.0.
- `release.yml` inputs verified: `version`, `tag`, `dry-run`, `resume-after-npm-publish`, `expected-sha`.

## Audit (astra, NEAR-PASS) — folded

- Order: the 2.69.0 pre-move PR merges before either release dispatch; `CAND` stays pinned before the bump.
- Both promotion branches start at `CAND` and merge their release branch with `-s ours`; `sync "$PV"` only on
  preview, `check 2.68.0` on stable; promotion PRs merge with `--merge --match-head-commit`, never squash.
- The heuristic CI rule never waives release gates: push-event `ci.yml` and Service lifecycle must succeed at each
  promotion merge SHA.
- Dispatch: `gh workflow run release.yml --ref preview -f version="$PV" -f tag=preview -f dry-run=false -f expected-sha=<sha>`;
  stable only after the preview run succeeds, `--ref main -f version=2.68.0 -f tag=latest`.
- Verify: `npm view @bitkyc08/opencodex dist-tags --json`; `gh release view <tag>` 25 assets, non-draft, prerelease flags;
  `latest.json` 2.68.0 with five signatures.

## wp5 execution log

- Pre-move: `dev-version-bump.yml` run `36294309818` success opened #6053 (head `7af8381049`, four version sources
  2.68.0 → 2.69.0 only). Merged by admin as `99d0a9400e` under the owner's heuristic CI rule (workflow-token PR CI
  does not start; the diff is the same four lines as every pre-move).
- Promotion: branches built in `/tmp/ocx-rel-2680` from CAND; `release-version-sources.ts check` passed for both;
  main tree equals CAND, preview differs only in four version lines. #6054 `preview` merged as `09081803c5`,
  #6055 `main` merged as `93f4231e4b` (merge commits, `--match-head-commit`).
- Runner hygiene: PR-event runs on the merged promotion branches and the superseded CAND lane=all run
  `36294278068` were cancelled one at a time so the push-event runs on `main` and `preview` could start.
  CAND's tree equals #6052's exact head, whose PR CI passed (31 pass, 6 skipped).
- Release gates pending: main CI `36294473376`, main Service lifecycle `36294473362`; preview CI `36294469680`,
  preview Service lifecycle `36294469713`.
