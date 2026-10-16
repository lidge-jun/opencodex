# 060 — Delivery record

Four dependent pull requests onto `dev`, one per work phase, every push `--no-verify`,
no local test suite run at any point. Verified 2026-09-12.

| PR | branch | base | head | live CI run |
|---|---|---|---|---|
| #4324 | `codex/provider-catalog-plan` | `dev` | `67657b9655` | `34666254983` success |
| #4325 | `codex/provider-catalog-local-tab` | #4324 head | `7ae08971c7` | `34668670304` success |
| #4328 | `codex/provider-catalog-note-popup` | #4325 head | `e3fdf8fd26` | `34668670844` success |
| #4331 | `codex/provider-catalog-unified-search` | #4328 head | `68e6b028d7` | `34668669980` success |

Ancestry is a real chain, checked with `git merge-base --is-ancestor`:
`67657b9655` ⊂ `7ae08971c7` ⊂ `e3fdf8fd26` ⊂ `68e6b028d7`. Each PR's diff against its
own base carries only that phase's work; no parent commit is replayed.

## Two CI facts that are easy to misread

**Cancelled duplicate runs leave FAILURE rows on a live head.** Pushing the rebased
chain started overlapping workflow runs, and the concurrency group cancelled the older
ones. A cancelled run's `ci` aggregator concludes *failure* with
`needed job(s) did not pass: changes=cancelled`, and that row stays attached to the same
head SHA as the live green run. On `e3fdf8fd26` the failing `ci` is job `103485691739`
on cancelled run `34668670665`; the live aggregator `103488063420` on `34668670844`
succeeded. Read the run, not the rollup.

**A cancelled required check is not a passing one.** All three `enforce-target`
attempts on `e3fdf8fd26` were cancelled the same way, which left #4328 `UNSTABLE` even
though its product CI was green — `gh pr checks` maps a cancelled required check to
fail. Re-running `34668680065` produced a success on that exact head and the PR went
`CLEAN`. This was found by an independent auditor, not by reading the rollup.

#4324 reports `BLOCKED` because `dev` requires a pull-request review; that is branch
protection, not a check failure.

## What CI proved that local runs did not

The test suite was never run in this worktree, by instruction. Two defects were caught
that a local run would have caught instantly, and both were found by static review
instead:

- `CSS.escape` in the chip jump would have thrown `ReferenceError` under bun/happy-dom,
  taking the new chip test red. Replaced with a `data-catalog-group` attribute lookup
  before it ever reached CI.
- A third defect did reach CI: `gui/tests/fr-localization.test.ts` rejects a French
  value identical to its English source, and `modal.tab.local` is `"Local"` in both.
  "Local" is genuinely the same word in French and the Local *badge* was already on that
  allowlist, so the tab joined it. Fixed at the root of the stack and the two children
  were rebased onto it, which is why #4328 and #4331 were force-pushed once.

Local checks that were run: `bun x tsc --noEmit`, `cd gui && bun x tsc --noEmit -p
tsconfig.json`, and `bun run structure:check`. Everything else is **NOT RUN** locally.
