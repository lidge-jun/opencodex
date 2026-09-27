# 020 — wp5: release 2.68.0

Values for the 2.67.0 procedure: `CAND` = `origin/dev` after wp4 merges; `PV=2.68.0-preview.20260927`;
pre-move `dev-version-bump.yml --ref main -f intended-version=2.68.0 -f mode=pre-move` (dev → 2.69.0);
promotion branches `codex/260927-release-preview-2.68.0` and `codex/260927-release-main-2.68.0` built
with `git merge -s ours` and `scripts/release-version-sources.ts`; merge commits (never squash); push-event
CI and Service lifecycle at both promotion SHAs; `release.yml` preview first, then stable; verify npm
dist-tags, both GitHub releases' assets, and `latest.json` signatures; fast-forward local branches.

Heuristic CI rule (owner): a failing job blocks only when it reproduces on rerun or its log points at a
change in main..dev. Runner-stall signatures get one job rerun.
