# #4147 — land contributor PR #4153, do not reimplement

## State at plan time

PR #4153 `fix(zcode): export reasoning configuration for thought-capable models`,
author `richardfeiliu-a11y`, head `fix/zcode-export-reasoning`, base `dev`.
Draft, `MERGEABLE`, `mergeStateStatus: BLOCKED`, four checks concluded `SUCCESS`.
Touches exactly `src/clients/config-export/zcode.ts`,
`tests/config/client-config-export.test.ts`, `tests/providers/zcode-client.test.ts`.

## Why this is a landing task, not an implementation task

The contributor resolved the one question the triage comment raised. The issue body
said ZCode reads `model.reasoning.levels`; the Expected block said
`reasoning.variants` / `defaultVariant`. He checked a live `~/.zcode/v2/config.json`
and the shipped parser in `ZCode.app` and reported that the on-disk schema is
`enabled` + `variants` + `defaultVariant`, and that `levels` is the in-memory
object after `openCodeReasoningToModelReasoning` parses it. That matches the
3.7.7 / 3.8.1 contract comment already on `ZcodeModelEntry`.

Reimplementing this would throw away verified external evidence and the
contributor's authorship. `AGENTS.md` requires a `Co-authored-by` trailer for
carrying someone else's work, and `CREDITS.md` exists because 27 landings did it
wrong. Landing the PR as his avoids the problem entirely.

## Vocabulary he chose, and why it is right

- Drop `none` — it is Codex's omit-sentinel and OpenCode V2 already filters it.
  ZCode builtins express that idea as `off` / `enabled`.
- Keep `ultra` when the catalog ladder has it. ZCode renders `variants` as picker
  labels and forwards the selection as `reasoning_effort`; hiding `ultra` would
  drop a real tier. `omp`'s no-`ultra` vocabulary is omp-specific.
- Set `defaultVariant` only when `defaultReasoningEffort` survives into the
  emitted list.

## Work

1. Read the diff against the confirmed schema and against the sibling exporters
   (`omp.ts` emits `reasoning: true` + `thinking.efforts`; `dsh.ts` emits a
   `reasoningEfforts` map; OpenCode V2 emits variants).
2. Fork PRs can sit at `action_required`. Approve the workflow runs with
   `gh api -X POST repos/lidge-jun/opencodex/actions/runs/<id>/approve` and wait
   for a real conclusion at the exact head SHA.
3. The readiness gate keeps a contributor PR in draft until its four-box checklist
   is complete, and it re-drafts a PR whose head is more than 10 commits behind
   `dev`. Bring it current by **merge, not rebase**, so authorship survives.
4. Merge, then close #4147 with the merge commit as evidence.

## Not needed

`maintainer-sponsored` applies to `src/oauth/` and `src/codex/auth-api.ts`. This
PR touches neither.
