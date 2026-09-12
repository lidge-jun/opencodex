# 050 — Delivery record

Snapshot: 2026-09-08T14:10Z. `origin/dev` = `e2bf1672c` (was `29bb221c3` at unit start).

## What landed

| Layer | PR | Merge SHA | Head SHA | Source | Author credit |
|-------|----|-----------|----------|--------|---------------|
| L1 CodeBuddy Global/CN | #4026 | `b77b05aa5` | `769e4208f` | #3340 (4 commits, cherry-pick -x) + layout move | Flowershangfromthebranches (author field + trailer) |
| L2 Qoder Global | #4027 | `753ecb813` | `5adf130da` | #3349 (cherry-pick -x) + layout move + audit fix | Flowershangfromthebranches |
| L3 Qoder CN | #4028 | `07ac34b2d` | `615c5c62c` | #3350 (cherry-pick -x) | Flowershangfromthebranches; Liang-Psych trailer for #3010 direction |
| L4 marks/docs | #4029 | `9f0721299` | `6ba1e6750` | maintainer | — |
| L5 Hermes YAML | #4030 | `5bb8faf7b` | `295bcf82b` | #3990 (cherry-pick -x) + fr/zh-TW sync | rrmlima |
| L6 Gemini tail | #4031 | `e2bf1672c` | `16d49ceab` | #3988 (cherry-pick -x) + single-owner fix | rrmlima (trailer; carried commit author is `root`) |

## Proof

- CI: `ci.yml` `lane=all` run **34231255231** on `16d49ceab`: 26/26 jobs success. `windows 4/6`
  failed once on `tests/codex-integration/token-guardian.test.ts` afterEach `EPERM rm` of its
  temp dir (a file the stack does not touch); same-SHA rerun of that job passed. Earlier run
  34228268757 on `ba3912ce8` was cancelled when the head moved and is diagnostic only.
- Ancestry: all six merge SHAs and all six head SHAs are ancestors of fetched `origin/dev`.
- Tree: `origin/dev^{tree}` = `2201b9e54…` = `16d49ceab^{tree}`. Landed tree equals certified head.
- Hygiene/enforce-target: green on every PR before merge after two repairs (trailers moved to
  the body end where `pr-carry-attribution.cjs` reads them; L4 got pinned icon tests for
  `missing_regression_test` and a before/after screenshot for the GUI gate).

## NOT RUN (by maintainer instruction)

`bun install`, `bun run typecheck`, `bun run test`, `bun run test:changed`, `bun run build:gui`,
`bun run privacy:scan`, `bun run lint:gui` — none executed locally. Every Git mutation ran with
`-c core.hooksPath=/dev/null`; pushes used `--no-verify`. Hosted CI is the only execution proof.

## Audit dispositions

Round 1 (L1–L3): blocker 1 `captured.effectiveAlias` folded (`5adf130da`); blocker 3 auth regex
folded (same commit); blocker 2 tool-less conformance exemption → residual, follow-up; blocker 4
`noVisionModels` → rebutted (repository convention). Round 2 (L4–L6): double `(continue)` nudge
folded (`16d49ceab`); fr/zh-TW Hermes contradiction folded (`295bcf82b`); seven locale copies of
the adapter list still stop at `azure-openai` (predates this unit; residual).

## Closeouts

#3340 (auto-closed by merge; credit comment added), #3349, #3350, #3990, #3988 closed as
superseded with credit; #3010 closed as superseded by the PAT design with credit to Liang-Psych.

## Secondary PR dispositions (not closed)

DEFER #3833 (layout seed trap, design call), #3952 (split required). REJECT for this stack
#3639, #3283, #3282, #2230 (C4 surfaces, conflicts, or maintainer-required security review).
See 013.

## Residuals for a follow-up

1. Guard test proving `codebuddy`/`qoder` still expose no tool catalog (audit round 1, blocker 2).
2. Locale adapter tables (ko/ja/zh-cn/zh-tw/fr/ru/tr reference/configuration/providers.md).
3. `docs/qoder-cli-provider.md` lives outside docs-site; consider folding into the guide.
4. Windows shard flake: `token-guardian.test.ts` temp-dir `EPERM` on cleanup.
