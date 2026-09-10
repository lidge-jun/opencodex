# Lane split, stacking, and merge control

## Why two lanes and not eight

Round 1 ran eight parallel worktrees. Every lane opened one PR, and the main
session spent most of its time on merge bookkeeping rather than on the changes.
Two lanes keep the same work but give each worktree one reviewer-visible chain.

## The split is by file ownership, not by issue count

The first draft of this plan put four issues in each lane. An audit against the
research reports found the write sets were **not** disjoint: #1711 and #3666 both
edit `src/codex/catalog/parsing.ts` (`CatalogModel`) and
`src/codex/catalog/provider-fetch.ts`, #1711's Dashboard half would collide with
#3666 and #4075 in `gui/src/pages/Models.tsx`, and three of the new tests all need
entries in `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`.

Two lanes that fight over the same files are worse than one lane, so #1711 moved
to Lane B. The lanes are 3 and 5, and every catalog, GUI, and test-layout edit
lives in one chain where stacking serializes it.

## Write sets

**Lane A — request path and service manager.**
`src/server/responses/core.ts`, `src/claude/inbound.ts`, `src/service.ts`, and
tests in `tests/responses/`, `tests/claude-integration/`, `tests/service/`.
Lane A needs **no** `layout.json` or `test-layout-expected.json` change: all three
items extend an existing test file.

**Lane B — catalog, dashboard, and management projection.**
`src/codex/catalog/` (`parsing.ts`, `provider-fetch.ts`, `sync.ts`),
`src/server/management/` (`shared.ts`, `model-rows.ts`), `src/lib/privacy.ts`,
`src/oauth/index.ts`, `src/codex/auth-api.ts`, `src/cli/models-runtime.ts`,
all of `gui/`, and tests in `tests/codex-integration/`, `tests/gui/`,
`tests/lib/`, `tests/oauth/`, `tests/server/`, `tests/cli/`. Lane B owns every
`layout.json` and `test-layout-expected.json` edit this round.

The two sets share no file. If a lane finds it needs a file the other owns, it
stops and reports rather than reaching across.

## Stack shape

Each lane publishes an ordinary manual chain, bottom-up, on the `dev` commit the
lane started from:

```
dev
  └─ lane-a/1-4129        PR base dev
       └─ lane-a/2-4148        PR base lane-a/1-4129
            └─ lane-a/3-4141        PR base lane-a/2-4148

dev
  └─ lane-b/1-3666        PR base dev
       └─ lane-b/2-4075        PR base lane-b/1-3666
            └─ lane-b/3-3859        PR base lane-b/2-4075
                 └─ lane-b/4-1711        PR base lane-b/3-3859
                      └─ lane-b/5-4038        PR base lane-b/4-1711
```

No GitHub native stacks. `enforce-target` skips the wrong-base gate for a child PR
whose base is another open PR's head branch, which is what makes this legal. After
a parent merges, the child is retargeted to `dev` — **by main-session instruction,
not by the lane**.

## Why the order inside each lane

**Lane A** ends with #4141 because PR #4152
(`fix(service): stop the test suite from mutating a live service manager`) is open,
not draft, mergeable, and rewrites the same `runLaunchctl` runner in
`src/service.ts` that #4141 has to change. It belongs to a separate task
investigating the live-proxy shutdowns. Putting #4141 last means #4152 lands first
and #4141 adopts its seam instead of racing it.

**Lane B** puts the two items the maintainer was asked about — #1711 and #4038 —
at positions 4 and 5, so a "drop it" answer removes them without restacking
anything below. #3859 is at 3 because its open question is *which surface*, not
*whether*. #3666 is at the bottom because #1711 builds on the same
`CatalogModel` edit, and #4075 sits next to #3666 since both touch
`Models.tsx`.

## Merge control

The main session merges in completion order, not lane order. The rule for each
merge:

1. The PR is not draft, `mergeable`, and its base is `dev`.
2. There is a CI run at the **exact head SHA** that concluded `success`.
   `gh run view <id> --exit-status` is the verdict; a cancelled run is not.
3. Merge, then fetch and prove `dev` ancestry before closing the issue.
4. PRs here target `dev`, so GitHub does **not** auto-close the linked issue.
   Close it manually with the merge commit as evidence.

Rebase instructions come from the main session only, and only when a merge has
actually moved `dev` under a still-open child.

## Lane operating contract

Each lane thread runs `cxc-loop` + `cxc-dev`: one PABCD cycle per stack item, its
own `xai/grok-4.6` subagents for bounded read-only verification, and
`--no-verify` pushes. A lane never runs the local suite, never merges, never
rebases without instruction, and never touches the service manager.
