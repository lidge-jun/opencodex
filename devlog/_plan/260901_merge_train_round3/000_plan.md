# 000 — merge train round 3: land the green, retire the superseded, rebase the rest

Frozen at `dev` = `132b557ad` (2.40.0), 2026-09-01T03:30Z. 55 open PRs, 47 open issues.

## Objective

Land the pull requests whose disposition requires no maintainer judgment, close the ones a
landed reimplementation has already absorbed, and leave the remaining maintainer-authored
PRs rebased onto current `dev` so their next review round reads a live head.

This train does **not** implement anything. Every production line it moves is a line some
other PR already wrote and some other reviewer already read.

## The state that makes this train possible

Three landings in the last hour changed what "red" means on this backlog:

| commit | what it changed |
| --- | --- |
| `33d32b6a3` (#3128) | pinned the WebSocket refresh account — the `server local API auth > websocket passthrough refreshes pool auth for each response.create turn` flake |
| `3e0f99a19` (#3127) | moved `dev` to 2.40.0 after the v2.39.0 release |
| `6f415baef` (#3129) | made the dev version bump actually fire |

Both of those are why the four candidates below currently show a red matrix, and neither red
is about the change under review:

- **#3104, #3109, #3112** are red on the `server-auth` WebSocket assertion. `070_outcome.md`
  of `260901_release_train_2390` diagnosed it: the credential is saved with
  `expiresAt: now + 120_000` against a `REFRESH_SKEW_MS` of `60_000`, and `startServer(0)`
  runs before `Date.now` is pinned, so the first turn can land on the wrong side of the
  skew boundary and refresh early. #3128 fixed it. Any head that predates #3128 still shows it.
- **#3122** is red on `release version line > the in-tree version is never behind a released one`.
  Its base predates the 2.40.0 bump, so the in-tree version is behind the published 2.39.0.
  Rebasing onto `132b557ad` is the whole fix.

**Therefore: no candidate is judged on a pre-rebase matrix.** Every merge in this train waits
for a green matrix on a head rebased onto `132b557ad` or later.

## Work-phase map (dependency-ordered)

```
wp0 roadmap (this unit)
 ├── wp1  #3114  docs-only, no production surface        → 010
 ├── wp2  #3122  provider PATCH validation exception     → 020
 ├── wp3  #3104  service budget + scheduler ownership    → 030   (+ closes #3009 #3064 #3039 #3067)
 ├── wp4  #3042  test-only pid probe                     → 040
 └── wp5  #3077 close, #3109/#3112 rebase                → 050
```

The order is blast-radius ascending, which here coincides with dependency order: wp1 touches no
code, wp2 touches one validation call site, wp3 touches `src/service.ts` and is the only phase
that closes issues, wp4 touches tests only, wp5 touches no `dev` state at all. wp1-wp5 are
independent of each other and depend only on wp0; they are sequenced rather than parallel
because each merge invalidates the next candidate's merge base.

## Scope boundary

**IN**

- Merging #3114, #3122, #3104, #3042 into `dev` after an exact-head green matrix.
- Closing #3039, #3067 (absorbed by #3104), #3077 (stale wrong-branch bump).
- Rebasing #3109 and #3112 onto current `dev` and force-pushing their branches.
- Dropping `926a8d8c4` from #3109 — the same change landed as #3128.
- Closing #3009 and #3064 when #3104 lands.

**OUT**

- **#3117.** It reverses a direction `b46164e78` (#3100) deliberately pinned one day earlier:
  "A configured id the provider no longer lists must not be retained on the strength of a
  format match alone; #1690 is the explicit opt-in for that." Landing #3117 is a policy
  decision about #1690, not a merge-train mechanical.
- **#3061.** `CHANGES_REQUESTED` with a substantive rebuttal: the 90 s budget reproduced the
  same failure, so the ceiling was not the only failure mode.
- **Re-implementing the review blockers on #3109/#3112.** Those are real and unresolved;
  this train rebases them and stops.
- Any `main`/`preview` promotion, npm publish, or release.
- Any new production logic.

## Verifier

`gh pr checks <n>` on the exact head, requiring every non-skipped check to pass. Run against
the post-rebase head only. Local full suite is prohibited by the operator; focused local checks
are permitted where a rebase produced a textual conflict that needs resolving.

Verified before adoption: `gh pr checks 3122` exits non-zero today and names
`release version line`, and `gh run view --job 99726180475 --log-failed` shows exactly that
one assertion. The command reads the change target because it reports the check suite bound
to the PR's head SHA.

## Terminal outcomes

- `DONE` — four merges landed, three closes recorded, two branches rebased and pushed.
- `BLOCKED` — a specific PR whose CI fails three consecutive times for an infrastructure
  reason; report it and continue the others.
- Partial completion is reported per work-phase, never averaged into a single claim.
