# wp6 — Stacked pull requests

## Shape

The dependency graph is two independent chains, not one line:

```
dev ── wp2 (aside backend) ── wp3 (aside GUI)
 └──── wp4 (history redesign)
 └──── wp5 (brand marks)
```

wp3 is the only child that must target another PR's head. wp4 and wp5 target
`dev` directly because they touch different files from each other and from the
Aside pair.

One overlap exists and is deliberate: wp3 adds `CLIENT_MARKS.aside` while wp5
adds six other entries to the same map. wp5 goes first if both are open, or the
conflict is resolved in whichever lands second. Recorded so review is not
surprised.

## Branches

`codex/aside-export-client` (wp2), `codex/aside-gui-surface` (wp3, based on
wp2), `codex/integrations-rollback-history` (wp4), `codex/client-brand-marks`
(wp5).

## Per-PR requirements

`.github/PULL_REQUEST_TEMPLATE.md` in full: Summary, Verification, Checklist.
`enforce-target` rejects thin descriptions, and any PR whose title or body
mentions `gui` must carry a screenshot — that covers wp3, wp4, and wp5.

`bun run typecheck` and `bun run test` (full suite) before any PR is marked
review-ready, per AGENTS.md. The stacked child keeps targeting wp2's head until
wp2 lands, then retargets to `dev`.

## Push

Requires explicit user approval per LOOP-GIT-01. The user asked for stacked PRs
in the original request, which authorizes the push for this scope.

## Outcome

Four PRs opened against `lidge-jun/opencodex`:

- #3047 wp2 `codex/aside-export-client` -> `dev`
- #3048 wp3 `codex/aside-gui-surface` -> `codex/aside-export-client`
- #3049 wp5 `codex/client-brand-marks` -> `dev`
- #3050 wp4 `codex/integrations-rollback-history` -> `dev`

Screenshots live on an unmerged `assets/aside-and-rollback-260831` branch and are
linked by raw URL from the PR bodies, following the `assets/gui-sidecar-pair-260829`
precedent. They are evidence, not shipped files, so they do not enter a code PR.

### The predicted conflict did not happen; a different one did

The `CLIENT_MARKS` overlap this document expected never materialized: wp3 does not
add an Aside mark, because `aside.com/favicon.svg` is a 404 and Aside keeps a
monogram. All four branches merge into one scratch branch with no conflict.

What did go wrong is the wp2/wp3 boundary, and CI is what found it. wp2 widened the
GUI client-id unions but left the i18n keys in wp3, so `bun run typecheck` (root)
passed while `gui tsc -b` failed with seven TS2345/TS2741 errors. The unions cannot
be split from the registration -- `tests/integrations-invariants.test.ts` compares
them against the backend registry -- so the label keys, three exhaustive
`Record<FileIntegrationClientId, TKey>` maps, and four client-list assertions moved
down into wp2. wp3 keeps what is genuinely separable: the `integration-tabs.ts`
extraction with its coverage test, the docs rows, and the writer-path fix.

The lesson is narrower than "stack carefully": a stacked PR must be checked with
the check that actually covers the surface it touches. `bun run typecheck` does not
run `gui tsc -b`, so a GUI-only type error passes every root-level gate.

### Two real defects CI surfaced

A refusal to resolve Aside's account was reported as the wrong state. An absent
`accounts.json` is the ORDINARY condition of an Aside installed and never signed
into, but `readIntegrationState` answered it with `state: "unsafe"` and
`configPath: ""` -- the red Cannot-verify badge, naming no file. It surfaced as
`tests/management-integration-routes.test.ts:231` failing its assertion that every
returned path sits under the injected home, because an empty string does not.
A client that can say where its config WOULD live now supplies an
`unresolvedPathHint`, and the read reports absent/not-installed with that location.
Mutation still refuses. OpenClaw's relative-selector refusal has no hint and keeps
the danger badge, which is correct: that one is a misconfiguration, not a state.

And `integrations.catalog.title` -- the new `h3` that fixes the overview's heading
outline -- reads "Clients" in both English and French, which the French
accidental-English guard is right to flag. It is on the intentional-English
allowlist now.

## Outcome

Seven PRs on `dev`: #3047 (`8c1294828`) the Aside client, #3050 (`efa2ba5ad`) the
bounded rollback surface, #3049 (`704d0d91a`) the first-party marks, #3048
(`93b7ee80a`) the Aside GUI surface, #3065 (`7853e8e05`) Aside's own mark and the
single-ink fix, #3060 (`a1c332e9a`) the MAINTAINERS correction, and #3074 the
regression guards. Issue #3059 tracks the one deferral.

### What the pre-merge audit changed

An adversarial reviewer ran two rounds against the stack and neither round was
ceremonial. Round 1 found that squash-merging the parent would strand the child:
the repo merges by squash, so `git rebase` of the child onto the new `dev`
conflicts add/add, and `enforce-pr-target` resolves `stackedBase` from **open**
PRs only, so #3048 flips to `wrong_base` the moment its parent lands and its
branch is deleted. The fix is `git rebase --onto <new-dev> <recorded-parent-tip>`,
with the tip captured *before* the merge because `delete_branch_on_merge` removes
the name.

Round 2 caught the more dangerous one. A fix had landed on the parent after the
child was cut, so the child was *behind* its own base while touching the same two
files. Replaying it would have auto-merged cleanly and silently reverted the
guard. The bad outcome there is not a conflict you resolve; it is the clean
rebase you do not look at. Cascade first, then `--onto`, and verify by grepping
for the guard rather than trusting the exit code.

Both are properties of *this* repository's settings, not general stacking advice.

### The claim that was wrong

`aside` was recorded here as having no first-party mark, on the evidence that
`aside.com/favicon.svg` is a 404. True of the web, wrong about the product: the
installed application ships the mark in a module the vendor named
`official-brand-symbol`. The lookup had been scoped to what a vendor publishes
for the web, and an app that ships no web assets falls through it.

Rendering all nine marks at 28px against both themes then showed three were
invisible to somebody -- `prime` white-on-transparent in light mode, `opencode`
and `kimi` near-black in dark. Every existing assertion passed: the files
existed, the `src` values were right, the geometry check was satisfied. Only
looking at them found it.
