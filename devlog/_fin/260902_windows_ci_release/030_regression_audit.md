# 030 — Regression audit main..dev

After 010/020 land: `git log --oneline origin/main..origin/dev`, split into 4 lanes (src first half,
src second half, tests-only + gui, security boundary per MAINTAINERS.md) and dispatch read-only
sol/high reviewers in parallel. Each returns VERDICT + per-commit user-impact notes. Record
verbatim tails in `031_verdicts.md`. Any medium+ finding becomes a fix cycle before 040.
