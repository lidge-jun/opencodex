# 000_plan.md — C track: config file + init as a manual PR stack

## Objective

Land the C triage track (config-file and init surfaces) on `dev` as one manual,
dependency-ordered branch chain whose tip carries every layer. The track has two
existing contributor pull requests plus one gap discovered while planning:

| Layer | Source | Surface |
|---|---|---|
| wp1 | PR #3900 by @x3M3x | `src/config/atomic-write.ts` Bun/Windows ENOENT |
| wp2 | new (this unit) | `src/config/initialize.ts` sibling numeric flag |
| wp3 | PR #3896 by @parkjs101 | `ocx init` publication recovery guidance (closes #3893) |

wp2 exists on its own merit, not as glue. `publishInitialConfigNoReplace` still
opens its temp file with the numeric spelling that Bun miscompiles on Windows,
so shipping wp1 alone leaves first-run config publication exposed to the same
`ENOENT`. #3900 never touches `initialize.ts`; the file overlap is between wp2
and wp3 only.

## Constraints (owner-stated, this session)

- **No local product suite.** No `bun run test`, `bun run typecheck`,
  `bun run build`, or install. Every such check is recorded **NOT RUN**.
- **Push with `--no-verify`** on every layer.
- **CI on the tip only.** Verified mechanism in `040`: the lower layers are
  pushed as branches but **no pull request is opened for them** until the tip
  has landed. `.github/workflows/ci.yml` triggers on `pull_request: {}` with no
  draft filter, so opening a lower PR would start CI; draft status suppresses
  nothing.
- **Green tip merges; the rest resolve.** When the tip's exact head SHA is green
  against a current `dev` base, merge the tip, then resolve the source PRs and
  close issue #3893.
- **Original authors are preserved** with full `Co-authored-by: Name <email>`
  trailers that survive the squash (AGENTS.md "Landing another author's work").

## Build order

```
codex/c-track-init-guidance     → the ONLY pull request (base dev)   ← wp3 tip
codex/c-track-initialize-flag   → branch only, no PR                 ← wp2
codex/c-track-atomic-write      → branch only, no PR                 ← wp1
──────────────────────────────── dev
```

Each branch is based on the one below, so the tip's tree is the cumulative
result. wp2 sits between the carried PRs because wp3 inserts a line directly
after the `openSync` call that wp2 rewrites; constructing wp2 first means that
adjacent-hunk overlap is resolved once while carrying wp3. This is a chosen
construction order for a single conflict resolution, not a semantic
prerequisite — either change could be written first.

## Scope boundary

IN: the three layers above, their regression tests, the docs/structure text that
#3896 already carries, and this devlog unit.

OUT: `#3838`/`#3917` adapter work, any other triage track, release promotion,
`main`/`preview`, and any behavioral change to hard-link publication, ACL
hardening, or credential storage beyond the flag spelling.

## Verifiers

Local product gates are forbidden this session, so acceptance rests on
repository CI against the tip plus read-only inspection.

| Claim | Evidence | Status |
|---|---|---|
| Layers carry original authorship | `git log --format='%(trailers:key=Co-authored-by)'` on the tip, then on the landed commit | to run (read-only) |
| wp2 removes the numeric spelling | `rg 'constants\.O_' src/config/initialize.ts` on the pushed tip tree | to run (read-only) |
| Carried content really landed | tip tree vs. each source PR's pinned patch, then landed-merge tree comparison (see `040`) | to run (read-only) |
| Layers build and pass | repository CI on the tip head SHA, base `dev` | tip only |
| Local suite / typecheck / build | — | **NOT RUN** (owner instruction) |

## Terminal outcome

DONE requires: tip CI success on its exact head SHA against a current `dev`
base, tip merged into `dev` proven by fetched ancestry and tree comparison,
source PRs resolved with credit intact, and #3893 closed.
