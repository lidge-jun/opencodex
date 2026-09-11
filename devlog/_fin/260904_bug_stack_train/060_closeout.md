# 060 — Closeout

Six pull requests merged into `dev`, each proven an ancestor of the branch head:

| PR | Merge commit | Content |
|----|--------------|---------|
| #3369 | `f825858da` | OpenAI deviceauth grant (#3366 layer 1) |
| #3385 | `d060f53ab` | deviceauth surface: API, CLI, GUI, poll budgets (layer 2) |
| #3371 | `53a2adfc4` | Cursor repeated-narration breaker (from #3357) |
| #3372 | `8a0c10865` | `logs --follow` capability contract (from #3322) |
| #3373 | `d753fa53b` | Combo strategy selector (from #3335) |
| #3386 | `a33381182` | Models tab width stability (from #3333) |

Proof form for each: `git fetch origin dev && git merge-base --is-ancestor <sha> FETCH_HEAD`.

## The mistake worth remembering

Two PRs had to be rebuilt mid-train for the same reason, and CI caught both:

- `codex/carry-3333` copied `gui/src/styles.css` wholesale from #3333's head. That PR
  predates #3367 and #3382, so the copy silently reverted the Logs table clipping fix and
  the sidebar footer rework. `tests/logs-table-overflow.test.ts` failed on a declaration
  nothing had intentionally touched.
- `codex/deviceauth-surface-v2` copied the nine i18n catalogs the same way, reverting every
  key `dev` had added since — `sidebar.preferences` among them — which broke the GUI build's
  `TKey` union.

**Carrying another author's work means applying their diff, not taking their files.** A file
carries its own history with it. Both rebuilds used
`git diff <pr-merge-base> <pr-head> -- <path>` and applied that.

A third defect surfaced from the same area: `tests/dashboard-tabs.test.ts` located its
target with `indexOf(".page-tabs {")`, which matches any rule whose selector merely *ends*
in that string. Adding a scoped `.main-inner--combos > .page-tabs` rule above the base one
made the guard read the wrong block. It is now anchored to a line-start rule, and removing
`flex-wrap` from the real base rule still fails it.

## Review value

Eight reviewer rounds across the two deviceauth PRs produced, each with a reproduction:
a 32-bit timer overflow that turned a hostile `interval` into 34 auth requests in ~50ms; an
unenforced deadline that accepted a grant arriving after expiry; a cast `access_token` that
let a 200 with no token resolve a login as successful; a GUI that never actually requested
device mode, covered by a test that was false-green because its mock answered with a device
payload regardless of the request; a five-minute modal timer against a fifteen-minute grant;
budget tests that permitted the exact regression they existed to catch; and a reauth path
that could not reach the device flow at all.

None of those were visible from the diff alone.

## Still open, deliberately

See 040. #3348 and #3312 (generic 410/413 classified as retryable hops, ~2,000 lines each),
#3325 (correct, but needs a maintainer sponsorship decision for a restricted workflow
surface), and all six bug issues (reporter evidence or a product decision; three would
require weakening an auth or identity boundary to "fix" without a reproduction).
