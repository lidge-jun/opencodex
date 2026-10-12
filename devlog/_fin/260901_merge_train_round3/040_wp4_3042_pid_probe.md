# 040 — wp4: land #3042 (probe for a free pid instead of assuming 4242 is dead)

PR #3042, author `lifrary` (fork, `maintainerCanModify = true`), branch
`fix/test-dead-pid-probe`, labels `chore` + `review-ready`. `+44 −23` across 4 files.
One commit: `d3c3e3aa`.

## The defect

Nine sites across three suites stand in for an exited process with a hardcoded pid:

```ts
const deadPid = process.pid === 4242 ? 4243 : 4242;
```

The code under test asks the kernel whether that owner is still alive. The pid is only dead
until an unrelated process happens to hold it — at which point production answers correctly,
the test reads that as a miss, and the failure looks like a defect in the code rather than in
the fixture. This is the same class of latent cross-platform flake as the `server-auth`
WebSocket assertion #3128 just removed, and it is worth landing for the same reason: a test
that fails for a reason unrelated to its subject taxes every release train.

## Position

57 commits behind `dev` — the furthest behind of the four candidates. Test-only, four files,
so a rebase is cheap even at that distance, but conflicts are likelier than for the others.

Its currently-visible checks are only the lightweight set (`enforce-target`, `hygiene`,
`label`, `resolve-pr`, CodeRabbit) — all pass. The heavy matrix has not run on this head at
all, so a green matrix on the rebased head is the first real signal this change has produced.

## Amended by audit round 1 (blocker 3): carry, do not force-push

`lifrary` has `read` permission, so `.github/workflows/enforce-pr-target.yml:740-746`
applies the contributor readiness checklist. A maintainer force-push re-drafts the PR and
resets boxes only the author can tick. Same disposition as #3122: cherry-pick onto a
maintainer branch with authorship preserved.

The overlap is one file: `tests/responses-state.test.ts`. The dev-side additions sit earlier
in the file than this PR's `findDeadPid()` sites, so a textual conflict is unlikely despite
the 59-commit distance.

## Steps

1. `git checkout -b codex/3042-dead-pid-probe origin/dev`.
2. `git cherry-pick -x d3c3e3aa`, authorship preserved.
3. Resolve conflicts by re-applying the probe helper at each site; if a site disappeared in
   the 59 intervening commits, drop that hunk rather than resurrecting it.
4. `bun test tests/responses-state.test.ts tests/doctor.test.ts tests/cli-status-json.test.ts`
   — the three suites this PR touches. Focused, permitted.
5. Push the maintainer branch, open a PR crediting @lifrary and linking #3042.
6. Wait for the full matrix, merge, then close #3042 with credit.

## Accept criteria

- Carrier head's matrix green, including all four `test` shards on both macOS and Windows —
  this change exists to make those shards deterministic, so anything less proves nothing.
- No production file in the diff. If the rebase pulls one in, stop.
- `git log origin/dev` shows the commit authored by @lifrary.
