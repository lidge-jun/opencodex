# 010 — Phase 1: make `ci.yml` reach stacked child PRs

Depends on: nothing. Blocks: `020` (shares `tests/ci-workflows.test.ts`).

## Objective

A PR whose base is another open PR's head branch must queue the same test jobs
it would queue against `dev`, without making the workflow fire on every
conceivable base branch and without loosening the `paths:` filter.

## Design decision

GitHub has no "base is another PR's head" trigger condition. The available
lever is `branches` / `branches-ignore` on the `pull_request` event, matched
against the base ref.

Options considered:

| Option | Verdict |
| --- | --- |
| Add each stack base by name | Rejected — base names are per-stack and unknowable in advance. |
| `branches: [main, dev, "codex/**"]` | **Rejected on audit.** See below. |
| `branches-ignore` | Rejected — an exclusion list has to enumerate what to exclude, which is the same unknowable set. |
| Drop `branches:`, keep `paths:` | **Chosen.** |

### Why `codex/**` was rejected

The first draft of this doc chose `codex/**`, reasoning that stacked bases live
in the `codex/` namespace. The audit falsified that. Open PR head refs today:

```
14 codex/    4 fix/    3 feat/    3 agent/    1 split/    1 ingw/
```

Any of those 12 non-`codex/` branches can become a stacked base the moment
someone opens a child against it — contributor stacks are exactly the case that
most needs CI, since contributor code is the least trusted. `codex/**` would fix
the maintainer's own stacks and leave the contributor's silently unverified,
which is the worse half of the bug.

### Why dropping `branches:` is safe here

`branches:` and `paths:` are AND-ed, and `paths:` is the filter that actually
decides whether work runs: a PR that touches nothing under `src/`, `tests/`,
`gui/`, `bin/`, `scripts/`, or the pinned root files queues nothing regardless
of base.

This is already the established pattern in this repository —
`.github/workflows/issue-quality-tests.yml` runs `pull_request` with `paths:`
and no `branches:` at all. So "scope by paths, not by base branch" is not a new
idea being introduced here; it is the convention this workflow diverges from.

The cost delta is bounded and small: of the 26 open PRs with a non-`dev`/`main`
base, only those touching a `paths:` surface would newly queue, and each of them
is a PR that *should* have been running tests all along.

The `push:` trigger is deliberately **left alone**. It stays pinned to
`[main, preview, dev]`: push CI gates the release lines, and widening it would
run the full matrix on every feature-branch push — a cost change nobody asked
for, and one the PR trigger already covers for the review path.

## Change 1 — MODIFY `.github/workflows/ci.yml`

Before (lines 4-6):

```yaml
on:
  pull_request:
    branches: [main, dev]
```

After:

```yaml
on:
  pull_request:
    # No `branches:` filter on purpose. GitHub matches it against the BASE ref,
    # so `[main, dev]` silently excluded stacked child PRs — whose base is
    # another open PR's head branch, an intentional review workflow per
    # AGENTS.md that `enforce-target` already exempts from the wrong-base gate.
    # The #951-#955 stack merged with `enforce-target`, `label`, and
    # `react-doctor` as its only check-runs: no test job ever queued for 24
    # changed files under `src/`.
    #
    # An allowlist cannot express "base is another PR's head": stacked bases
    # carry contributor prefixes (`fix/`, `feat/`, `agent/`, ...) as readily as
    # `codex/`, and contributor stacks are the ones that most need CI. `paths:`
    # below is the real scope gate — same shape as issue-quality-tests.yml,
    # which has always run `pull_request` with `paths:` and no `branches:`.
    #
    # `push:` stays pinned to the integration lines: it gates the release path,
    # and this trigger already covers review.
```

`paths:` is untouched, so a docs-only stacked PR still runs nothing.

## Change 2 — MODIFY `tests/ci-workflows.test.ts`

**Stale check (wp2 P, 2026-08-04).** The unit was drafted against a stale
checkout. On `origin/dev` the block sits at lines 243-278 (not ~89), and the
pinned `ciPaths` list has since grown `assets/**`, `README.md`, and `LICENSE`.
Neither affects this change: `paths:` stays untouched and its assertions are
left exactly as they are.

The block parses `ci.yml` and pins `on.push.branches` plus both `paths` lists.
Its type annotation declares `pull_request?: { paths?: string[] }` — it does not
even model `branches` on the PR trigger, let alone assert it. That is precisely
how the gap survived.

Extend the parsed shape:

```ts
    const ci = Bun.YAML.parse(await readText(".github/workflows/ci.yml")) as {
      on?: {
        push?: { branches?: string[]; paths?: string[] };
        pull_request?: { branches?: string[]; paths?: string[] };
      };
    };
```

And add, after the `push.branches` assertion:

```ts
    // The PR trigger must carry NO base-branch filter. GitHub matches
    // `branches:` against the BASE ref, so `[main, dev]` silently excluded
    // stacked child PRs, whose base is another open PR's head branch — the
    // #951-#955 stack merged with `enforce-target`, `label`, and `react-doctor`
    // as its only check-runs and no test job at all, for 24 changed files under
    // `src/`.
    //
    // Re-adding an allowlist is the regression this pins. It cannot be written
    // correctly: stacked bases carry contributor prefixes (`fix/`, `feat/`,
    // `agent/`) as readily as `codex/`, so any list leaves some stack silently
    // unverified. `paths:` above is the scope gate.
    expect(ci.on?.pull_request?.branches).toBeUndefined();
```

Note `push.branches` keeps its exact-set assertion. The two triggers now differ
on purpose, and the test says so.

## Verification

1. `bun test tests/ci-workflows.test.ts` — green.
2. Restore `branches: [main, dev]` in `ci.yml`, re-run: the new assertion must
   FAIL and nothing else should. Restore afterwards. (Not-vacuous proof.)
3. `bun run typecheck`, `bun run privacy:scan` — green.
4. Live: the PR carrying this change itself targets `dev`, so it proves the
   unchanged path. Stacked-base proof comes from the parsed trigger plus the
   GitHub docs semantics for `branches:` on `pull_request`.

## Risk

The change can only widen when the workflow runs, never narrow it, so no
currently-verified PR loses coverage. The cost is bounded by the untouched
`paths:` filter: a PR queues jobs only if it touches a real code surface.

The one thing to watch is CI minutes on long-lived non-integration bases. That
is the intended trade — those PRs were merging unverified — and `paths:` keeps
documentation and devlog-only PRs free.
