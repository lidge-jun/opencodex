# 085 — p3228 landing

- Carry PR #3239 (branch `codex/260902-p3228-carry`): the source hunks of #3228 with `Co-authored-by` credit; the bundled GUI editor left for a feature PR with a screenshot.
- Admin squash-merge → `744d12d02` on `dev`; ancestry proven. #3228 closed as landed (source half) with the split explained.
- Reviewer Cicero (xai/grok-4.6) pass; local red-green on the carry worktree (test fails without the src hunk, 60 pass with).
- Checks: subagent-model-fallback focused file, typecheck, privacy:scan.
- Non-blocking caveat recorded: entitlement filtering still uses the null initial chain (`core.ts:2945`); the first synthetic candidate `gpt-5.5` is ungated.

