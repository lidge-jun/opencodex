# 022 — Stack closeout (wp3 D)

| PR | Base | Head | CI rollup |
|---|---|---|---|
| #3230 feat(server): advertise api_types and capabilities on the raw /v1/models list | `dev` | `bc186b59e` | 26 success, 1 skipped, 0 failing (Linux 4 shards, macOS, Windows/macOS/Ubuntu npm-global, keyring x3, gates, storage policy, api usage, enforce-target) |
| #3231 docs: Cursor Private Inference connector guide | `codex/cursor-local-models-schema` | `af8b45cb5` | 9 success, 8 skipped, 0 failing |

Raw `gh pr view --json` output: `021_pr_rollup.json`.

Pushes used `--no-verify` per the user's clarified instruction (skip the local full suite; CI on
the exact head is the gate). The repo's `prepush` script runs the full suite, which is why the
hook had to be bypassed rather than run.

Late fold-ins after the first push: CodeRabbit's `positiveInt(0.5) → 0` finding (commit
`bc186b59e`, regression assertion added); layer 2 was cascaded onto the new layer-1 tip
(`git rebase`, `--force-with-lease`) so `git log layer1..layer2` shows only the docs commit.

Not done, by design: no merge (user authorised opening PRs only). After #3230 lands, retarget
#3231 to `dev`. Terminal outcome for this unit: **DONE** for the three work-phases; merging is
the next human action.

Loose ends outside the repo: the Cursor Private Inference spike app/profile under `/tmp`
were scratch only. Do not start a sibling proxy against the machine OpenCodex home;
the service port stays 10100.
