# Outcome — DONE

The Models page is a three-tab workspace (Models / Combos / Routing) and the sidebar is
nine rows. 16 commits, 43 files, +3117/-442.

## What shipped

| Before | After |
|--------|-------|
| 11 sidebar rows | 9 |
| `#combos` a hidden page reachable only from a card link | `#models/combos`, a sibling tab |
| `#routing` its own sidebar row | `#models/routing` |
| Duplicate `Claude` row + `isNavEntryActive` correction | one row per page |
| Catalog polling while you read another surface | gated on the catalog tab |

Old links keep working: `#combos`, `#routing`, and their `/anything` suffixes redirect
to the nested destination, passively, so Back is never trapped.

## Phases

| Phase | Reviewer | What it took |
|-------|----------|--------------|
| wp00 roadmap | FAIL → FAIL → NEAR-PASS | 13 blockers folded in before a line of code |
| wp01 hash contract | PASS | test gaps closed on review |
| wp02a nested workspace | FAIL → FAIL → NEAR-PASS | draft loss, cancellation, subtitle overflow |
| wp02b route cutover | NEAR-PASS | docs, i18n, dead-code residue |
| wp03 pill demotion | PASS | a11y gap deferred to wp04 |
| wp04 close-out | FAIL → FAIL → PASS | late-load guard, IDREFs, hidden-panel cascade |

## What the reviewer caught that five green gates did not

Every phase ended with typecheck, both test suites, lint, and build green. The defects
below were all present in a green tree:

1. **The catalog's loading and cold-failure branches were component-level early
   returns.** Correct for a page that is only a catalog, fatal for one that owns three
   tabs: a slow catalog unmounted the entire workspace and took unsaved combo drafts
   with it. I had reproduced the draft loss in a browser and misdiagnosed it as the
   disabled-resource path; a MutationObserver showed no DOM removal, which confused me
   until the review named the early return.
2. **A save or delete resolving after the tab was hidden started a fresh load** — new
   controller, four requests, current generation, writing into a panel nobody was
   looking at. Aborting what is already running does not stop what starts next.
3. **Author `display: flex` beats the UA's `[hidden] { display: none }`.** Mounting both
   panels to fix broken `aria-controls` IDREFs left a hidden panel painting anyway.
   Self-inflicted, one commit old, invisible to every static check.
4. **`bun run test` does not run `gui/tests/`.** `scripts/test.ts` defaults to
   `./tests/`; the 116-file GUI suite needs its own command. I asserted the opposite in
   the document that defines what "green" means.

## Two habits worth keeping

**Verify the verification.** The `bun run test` claim was an assumption upgraded to fact
inside the roadmap. One `sed` of `scripts/test.ts` would have caught it. It survived
because I wrote it down confidently.

**A rule is not a mechanism.** "Gate the network, never the tree" is a correct invariant
and an unimplementable instruction. Both times I stated a principle and moved on, the
reviewer had to supply the design — and my first attempt at the ref-based version would
have failed lint. Diff-level means the diff.

A corollary earned the hard way: **a test that passes against the reverted fix is not a
test.** Two of mine did — a poll assertion waiting 60ms against a 10-second interval, and
a lifecycle test that never reached the code path it named. Every regression test here
was subsequently driven red against its own reverted fix before being trusted.

## Accepted residuals

Reviewer-confirmed as merge-acceptable, none introduced by this unit:

- Shadow/V2 requests already in flight are not aborted; only future scheduling stops.
- The catalog's mutation refresh owns an untracked controller and can finish after the
  tab is left. User-initiated, not polling.
- The Combos tab shows no cross-tab error badge; failures are visible inside the panel.

## Cost, stated plainly

Routing (beta) loses sidebar discoverability. It is a young feature and moving it one
level in means fewer people stumble onto it. The mitigations are real but partial: the
strip is visible the moment anyone opens Models, the tab carries a live profile count,
and the subtitle names routing directly. This is a trade, not a free win.

Claude loses nothing — the row was a shortcut into a tab that still exists at the same
address.

## Not done

Nothing is pushed and no PR exists. Both need explicit approval.
