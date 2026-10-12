# 010 — R1: rebase the mega-file split stack

Work-phase: wp2. Scope: **review + rebase + push. No merges.**

## Why the CI is red, precisely

**Corrected 2026-08-19 after an independent audit lane refuted the first
version of this section.** The original text named the right mechanism and the
wrong direction; both corrections are below.

The failing assertion in shard 2/4 is a source-invariant test that reads code
as text. Run `32130164359` reports:

```
Expected to contain: "invalidateCodexModelsCacheWithPermit(permit, owningCodexHome)"
Received source:     invalidateCodexModelsCacheWithPermit(permit, owningCodexHome, { allowWhenDesiredDisabled: true })
```

So the **test** carried the old two-argument assertion and the **source**
carried the new three-argument call. The three-argument call arrived on dev in
`91979cf14`; `6c0bde453` then updated the assertion to match — but it landed
*after* this run. GitHub merges the PR head with the base before running CI, so
the run executed **dev's newer source against the PR's older test**.

That is the inverse of what this document first claimed ("dev's newer test
against the PR's older source"). The conclusion — stale-base merge skew, not a
defect in the extraction — survives; the mechanism statement had to be fixed.

The failure set is also larger than first recorded. Actual reds: test 1/4
(hidden raw reasoning), 2/4 (the sync-cache assertion above), 3/4 (Command Code
catalog), 4/4 (server local API auth), gates (Models-page GUI), and macos
(multiple). Six legs, not four.

The control: `#2023` is a strict history superset of `#2019`
(`git merge-base --is-ancestor 194f9f2a b2ac2500` exits 0), and **every
cross-platform job passes on its base** — shards 1-4, gates, macos, keyring,
npm-global. It is *not* "fully green": `hygiene` and `enforce-target` fail on
it, as they do on every PR in this stack.

**What the control does and does not prove.** It shows the extraction does not
break the suite when the suite and the source agree. It does not prove the
rebased `#2019` head is defect-free against *current* dev — only a CI run on
the new head can. Treat "stale base" as the hypothesis this rebase tests, not
as an established fact.

## Verified rebase cost

A scratch rebase of `codex/split-wp1b-type-clusters` onto `origin/dev`
(102 commits) conflicts in exactly one file, `src/types.ts`, with **3 hunks**.

Three dev commits touched `src/types.ts` since the fork point (`b04cd26e7`):

| Commit | Change |
|---|---|
| `11e03eb44` | replay: durable thought signatures per credential (#2078) |
| `fd85c8238` | cursor: HTTP/1.1 compatibility transport (#1903) |
| `b5a98d690` | release-audit regressions from the 260818 merge train |

All three add or modify type declarations. Because WP1b turns `types.ts` into
a pure barrel, each conflict resolves the same way: **the new declaration moves
to the leaf that owns its cluster, and the barrel gains a re-export line.**
This is mechanical, but it is not automatic — resolving it by taking "ours"
would silently drop three landed changes.

## Order

`#2019` and `#2036` are independent; `#2023` is a child of `#2019`.

1. Rebase `codex/split-wp1-types` onto `origin/dev`; resolve `types.ts`;
   force-push. Confirm the four shards go green.
2. Rebase `codex/split-wp1b-type-clusters` onto the NEW `#2019` head, not onto
   dev. Rebasing it onto dev directly would orphan the parent PR's diff.
3. Rebase `codex/split-wp2a-config-names` onto `origin/dev` (42 behind, already
   green — this is upkeep, not a fix).

All three branches are ours (`lidge-jun`), so force-push is in scope.

## The hygiene failure is real and is not fixed by rebasing

All three PRs fail `hygiene: missing_regression_test`: they change `src/`
without changing a test. That gate is correct here — and the honest answer is
`test-exception-approved`, not a manufactured test.

A pure-move PR's oracle is the ~400 test files that import through the barrel
plus `tsc --noEmit`. A new test asserting "the barrel re-exports `OcxTool`"
restates what the compiler already proves and would pass even if the extraction
were wrong in every way that matters.

Verified: dev's `src/types.ts` exports 85 names; the WP1b barrel re-exports all
85 across six leaves (`tools`, `wire`, `request`, `config`, `provider`,
`accounts`), reducing 1884 lines to 103.

## Exit criteria

- `c-2019`: new head pushed; the four previously-red shards no longer FAILURE.
- `c-2023`: rebased onto the new parent head; base ancestry correct.
- `c-2036`: rebased onto dev; still green.
- No merges. No `src/` change beyond conflict resolution.
