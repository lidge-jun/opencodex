# 000 — Scope: sort the open issue surface, land the un-reviewed bugs as a stack

## Objective

Two deliverables, one unit. First, every open issue carries a disposition its
own content justifies. Second, the bugs that nobody has actually reviewed get
built — as a stacked pull-request chain, bottom-up, one layer per defect.

Non-bug issues are label work only. Enhancements, roadmap items, and
upstream-blocked reports get their tags corrected and an evidence comment where
the disposition moved; they do not get code in this unit.

## Baseline

Measured 2026-08-03, `origin/dev` at `14b20def27f2d45f929c0dbb853fd0993ca61663`.

- 39 open issues, 16 labeled `bug`
- 27 open pull requests

The worktree HEAD is detached at `e835e789c` carrying an unrelated docs unit
(`260803_codex_desktop_toggle`). Every code claim below was read with
`git show origin/dev:<path>`, not from the worktree.

## The precedent this follows

@Wibias ran #900→#905 as a five-layer stack in this repository: each pull
request targets the preceding stack branch, titles read `stack N/M`, and every
layer carries a stack-navigation comment listing the chain with "review and
merge bottom-up". The `enforce-target` check skips the wrong-base gate for
stacked children by design (`AGENTS.md`, Branch policy). That stack was closed
on the policy it encoded, not on its mechanics — the mechanics are the part
worth reusing.

## Bug surface: who already owns what

Sixteen `bug` issues. Most are already spoken for, and re-implementing them
would duplicate an open contributor pull request.

| Issue | State | Owner |
|---|---|---|
| #586 | open PR | #935 @Wibias — Pool/Direct account mode switch |
| #893 | open PR | #928 @0xWinner98 — sparse Responses snapshot repair |
| #914, #919 | open PR | #922 @luvs01 — account-neutral network failures |
| #938 | open PR | #940 @mouzhi — UUID item-id normalization |
| #92, #241, #417 | upstream tracker | Codex CLI/Desktop, kept open for discoverability |
| #418, #796, #904 | awaiting reporter | a named capture would settle each |
| #907, #908, #915, #545, #875 | **unowned** | this unit |

The five unowned ones are the implementation surface. Everything else is a
label or a comment.

## What the research round overturned

**#907 cannot be fixed in this repository.** The working assumption was a
metadata regeneration. It is not: `scripts/generate-jawcode-metadata.ts:22-24`
reads `../jawcode/packages/ai/src/models.json`, and that canonical source
carries the same stale numbers — Terra `2.5/15/0.25/3.125` and Luna
`1/6/0.1/1.25` — across four provider bundles (`openai`, `openai-codex`,
`github-copilot`, `opencode-zen`) in a different repository,
`lidge-jun/jawcode`. Regenerating today reproduces the defect exactly.

The overlay is not an escape hatch either. `src/usage/expected-prices.ts:1-11`
scopes it to models whose jawcode rows are missing or all-zero, and
`src/usage/cost.ts:139-145` gives a valid nonzero jawcode row precedence over
it. A nonzero-but-wrong row is never reached by the overlay. Hand-editing the
generated file contradicts its own header (`src/generated/jawcode-model-metadata.ts:1-2`)
and would be silently reverted by the next regeneration — while
`tests/jawcode-metadata-sync.test.ts:21-47` byte-compares against the same
stale source, so it would fail.

**The reporter's cache-write claim is wrong, and so was one of ours.** The
report asserted cache writes should be zero. The official page publishes a
`Short context cache writes` column with nonzero values for all three models.

**#908 and #907 are independent and must not be bundled.** #908 is a missing
*multiplier* stage; #907 is a wrong *base* rate. Fixing #908 does not correct
Terra/Luna absolute estimates, and #907 landing would not add tier selection.
They touch the same file and are still two changes.

## Verified pricing (Tier 2, opened directly)

`agbrowse fetch "https://developers.openai.com/api/docs/pricing.md" --json
--browser never` → `verdict=strong_ok`, retrieved 2026-08-03. The agbrowse
endpoint resolver misroutes the HTML URL to `rss.xml`; the `.md` representation
is the one that proves.

Published table, USD per 1M tokens, `input / cachedInput / cacheWrite / output`:

| Model | Short context | Long context |
|---|---|---|
| `gpt-5.6-sol` | 5.00 / 0.50 / 6.25 / 30.00 | 10.00 / 1.00 / 12.50 / 45.00 |
| `gpt-5.6-terra` | 2.00 / 0.20 / 2.50 / 12.00 | 4.00 / 0.40 / 5.00 / 18.00 |
| `gpt-5.6-luna` | 0.20 / 0.02 / 0.25 / 1.20 | 0.40 / 0.04 / 0.50 / 1.80 |

Long context is exactly 2× input, 2× cached input, 2× cache write, 1.5× output,
applied to the whole request past `> 272,000` input tokens. Sol's short rates
match the bundle; Terra and Luna do not — which is #907, measured rather than
recalled.

Other tiers, same round: xAI Grok 4.5 at `>= 200,000` (inclusive, 2× on every
rate) and MiniMax M3 at `> 512,000`.

## Work-phase map

Dependency order. The stack is built bottom-up so each layer's diff is readable
on its own.

| Phase | Doc | Unit | Outcome |
|---|---|---|---|
| 1 | `010` | Disposition sweep: labels + evidence comments | applied |
| 2 | `020` | #908 long-context pricing tiers | code |
| 3 | `030` | #915 cooldown early-recovery probe | code |
| 4 | `060` | #545 classifier thinking round-trip | code |
| — | `040` | #875 residual — evidence, no code | comment |
| — | `050` | #907 price staleness — evidence, no code | comment |

Two issues have no implementation phase on purpose, and each says why in its
own doc rather than being quietly dropped: #875's reopen evidence tested a
commit 115 before the fix, and #907's fix belongs in `lidge-jun/jawcode`.

`#907` is not "unfixable". It is fixable — upstream. Under the current
source-of-truth policy it should not be fixed locally, which is a different and
more honest claim.

## Stack shape

#908, #915, and #545 touch disjoint files: `src/usage/`, `src/codex/`, and
`src/claude/` + `src/adapters/` respectively. Stacking them creates an
artificial ordering dependency where none exists in the code.

They are stacked anyway, deliberately, because the user asked for a stack and
because the chain gives a reviewer one entry point and a stated review order
rather than three PRs landing on `dev` in arbitrary sequence. Each layer's
"Files changed" view still shows only that layer's diff, which is the property
the precedent was built for. If a maintainer prefers to take them
independently, any layer can be retargeted to `dev` without a rebase conflict —
that is worth saying in the stack-navigation comment.
