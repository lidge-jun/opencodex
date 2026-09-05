# 260905 — RESOLVABLE_NOW split train (stacked PRs)

> Historical full-debt objective. The user's later cutoff is governed by800,
> 801,810 and820: consolidate the existing14 split PRs, run two full regression
> cycles, and deliver only the final head. All further implementation is
> deferred; the original68-row objective is not claimed complete. Peer
> coordination is closed. Older recipes below are not current execution authority.

Date: 2026-09-05. Worktree a2c0, docs branch `codex/260905-modular-debt-ledger-docs`
at 4cc219549 (source basis 980a9fbed; origin/dev tip at unit open 583d6a91b,
6 commits ahead, only one of which touches a NOW file — see 001). Session
01a06e97-b9d8-7250-8204-bb788338c288, goalplan
`.codexclaw/goalplans/reduce-the-68-resolvable-now-modularization-debt/`.
Input ledger: `devlog/_plan/260905_modular_debt_ledger/021_ledger.md` (68 rows
with `RESOLVABLE_NOW`); lane evidence in that unit's 011–016.

## Objective

Bring each of the 68 files under the cxc-dev §1 400-line limit by pure-move
splits (leaf modules + barrel re-exports), published as stacked PRs against
`dev`, each layer independently reviewable and mergeable. Zero behavior
change; every existing export stays importable from its original path.
Per-file success is `RESOLVED` or `RESIDUAL-FN` (003 RESIDUAL-ACCOUNTING-01);
the closeout tallies both and only the first counts as resolved.

## Constraints (binding on every layer)

- Pure move only. No renames of exported identifiers, no signature changes,
  no deletion of exports, no "while I'm here" fixes. A behavior defect found
  during a move is recorded in the decade doc and left alone.
- New leaf files ≤400 lines. A residual original file above400 requires a
  bounded declared successor chain (003 INTERMEDIATE-RESIDUAL-01), or the
  explicit final-state RESIDUAL-FN-01 exception in003. The exception requires
  one unsplittable function to be the sole cause after all permitted moves;
  it is recorded as unresolved function debt, not a resolved file.
- The ≤500-line PR cap is measured on the non-move diff for pure-move layers
  (003 PURE-MOVE-SIZE-01); non-move diff ≤150 lines.
- Re-export binds nothing locally (260818 WP1 lesson): internal call sites in
  the residual file import from the leaf explicitly.
- Text-oracle tests that read a split file as source (001 column
  `textoracle`) are retargeted to the leaf **without weakening**; the
  decade doc names each and the C phase drives the retargeted guard red once
  when it is a guard.
- `tests/lab/core-lab-boundary.test.ts` PROTECTED roots are never edited;
  a new leaf imported from a protected root must not reach `src/lab`.
- Verification from WP400 onward: typecheck, focused tests, privacy scan and
  full suite run in an isolated checkout on `ssh lidge`; no local suites.
- Git: layer branches `codex/split-<slug>`. Only declared dependency edges
  use a lower layer's branch; independent layers target `dev`, as specified
  by003 STACK-INDEPENDENCE-01 and002. Push and PR creation are pre-authorized;
  admin landing follows003 USER-ADMIN-LANDING-01 after passing checks.
  Cascade only affected dependent branches when their lower layer changes,
  using explicit `--force-with-lease` protection. Preserve checkpoint and
  unrelated refs; do not let automatic update-refs move them. Managed-worktree
  identity and current verification rules in003 remain binding.
- Open-stack depth cap: 5 dependent PRs. S04 contains six total layers,
  including prerequisite layer 105, but STACK-INDEPENDENCE-01 replaced the initial
  six-deep linear proposal: its longest current base chain is 3. Across the
  77-layer map, the longest planned chain is 4. The former S04 depth-six
  exception is historical, not permission to create a six-deep stack now.
- From WP400 onward, code and receipts use the existing a2c0 worktree in
  place (003 WORKTREE-EVIDENCE-01). Preserve each previous branch before
  selecting the next layer branch. Never relocate or recreate a2c0.

## Work-phase map (dependency-ordered)

| WP | Deliverable | Depends on | Verifier |
|---|---|---|---|
| wp1 | 000–003, including binding parent decisions, + every layer's decade doc (010…750) at diff level | — | docs checks (numbered only, every layer has a doc, every NOW file appears in exactly one stack, 003 amendments agree with 000/002 and the layer plans); privacy scan |
| wp2… | one layer per work-phase, dependency-ordered by the base edges in 002; independent groups may be interleaved | its declared base layer, if any | the current decade document's Verification and Accept criteria sections |

Total: 77 implementation layers across 21 stacks (002_layer_map.md; 105 and
625 appended per 003).

## Out of scope

The 151 `RESOLVABLE_AFTER` and 19 `ACCEPTED` rows; core.ts / config.ts /
service.ts / auth-api.ts; releases and direct branch pushes. Reviewed admin
landing after passing CI is now authorized by USER-ADMIN-LANDING-01 in003.

## Terminal outcome expected

DONE when every approved layer in002 has passing final-head CI and an admin
landing recorded with its review, stack-safety and dev-ancestry evidence.
The user's later delivery instruction supersedes the initial open-PR-only end.

## Completion spine

- WP400 closed through C→D with head `bbf8d3cd25ccf70eb595bc7982f63528d060c1bd`, ready PR #3611 against dev, clean remote receipt, all current logical CI checks passed/configured-skipped, and zero unresolved review threads. The CLI returned to IDLE and immediately entered P for WP450. The 1298-line facade still has its declared WP410 successor; this is layer completion, not completion of all68files.
- Earlier layer records remain in their decade documents. Global criterion c-5 still requires final reconciliation, including the known older verification debts; no whole-goal completion is claimed.
