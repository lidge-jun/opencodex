# 000 — wp9-devlog-gitlink-ci-fix: Plan

> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## Objective

Fix the dev baseline checkout failure discovered while processing PR #526.

Observed failure:

- PR #526 head `43d0efff4569711ed192e09d4d87b62fc803153c` failed
  `Issue quality tests / test` before tests during GitHub Actions checkout.
- Failure text:
  `fatal: No url found for submodule path 'devlog/_chase/_cca' in .gitmodules`.
- Current `origin/dev@7fcaa9119253d010393cb457427a2868cd935718` has the same
  broken metadata:
  - `devlog/_chase/_cca` is a `160000` gitlink.
  - `devlog/_chase/_litellm` is a `160000` gitlink.
  - `devlog/_fin/opencode-cursor` is also a `160000` gitlink and appears after
    the first two are removed.
  - `.gitmodules` is absent/no mapping for those paths.
- The gitlinks were introduced by docs-only commit
  `43fd06bc3 docs(devlog): close the docs-only roadmap cycle for the governance intake`.

Outcome:

- Remove only the accidental devlog `_chase` gitlinks from a dev-target branch.
- Restore checkout/submodule commands to non-erroring state.
- Land this baseline CI repair before rerunning/merging PR #526.

## Loop-spec

- Loop archetype: verifier-defined.
- Write scope:
  - DELETE gitlink `devlog/_chase/_cca`.
  - DELETE gitlink `devlog/_chase/_litellm`.
  - DELETE gitlink `devlog/_fin/opencode-cursor`.
- Out of scope:
  - No runtime source changes.
  - No `main`, `preview`, or release-branch changes.
  - No rewrite of historical devlog content under `devlog/_chase/_model`.
  - No #526 merge in this work-phase.
- Budget / bounds:
  - One small branch from `origin/dev`.
  - Push and open/merge a dev-target PR if local verification passes.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| WP9 | `010_phase1.md` | remove broken devlog gitlinks and verify checkout/submodule state | PR #526 hosted checkout failure |

## Accept criteria

- `git ls-tree HEAD devlog/_chase/_cca devlog/_chase/_litellm devlog/_fin/opencode-cursor`
  prints no `160000` entries after the fix.
- `git submodule status --recursive` exits 0.
- `git diff --check origin/dev` exits 0.
- A dev-target PR/merge or documented blocker exists for the baseline repair.
