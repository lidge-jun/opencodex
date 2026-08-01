# 015 — devlog gitlink checkout blocker

Item: dev baseline CI blocker discovered while processing PR #526.

Finding:

- `origin/dev@7fcaa9119253d010393cb457427a2868cd935718` contains gitlinks at:
  - `devlog/_chase/_cca`
  - `devlog/_chase/_litellm`
- `.gitmodules` does not contain mappings for those paths.
- GitHub Actions checkout fails before the issue-quality script can run because
  `actions/checkout` executes submodule cleanup and Git exits with:
  `fatal: No url found for submodule path 'devlog/_chase/_cca' in .gitmodules`.
- This failure reproduced on PR #526 head
  `43d0efff4569711ed192e09d4d87b62fc803153c`; recent `dev` runs are also red.

Planned bucket: `takeover-fix`.

Scope IN:

- On current `dev`, remove accidental devlog `_chase` gitlinks from the tracked
  tree or repair their metadata only if evidence shows they are intentionally
  required build inputs.
- Prefer removal because `devlog/` is planning/audit material and the referenced
  checkouts are not runtime source.
- Verify checkout/submodule state locally:
  - `git ls-tree HEAD devlog/_chase/_cca devlog/_chase/_litellm .gitmodules`
  - `git submodule status --recursive`
- Verify no source behavior changed:
  - `git diff --check`
  - targeted CI-facing check that previously failed locally, if available.

Scope OUT:

- Do not change main/preview/release branches.
- Do not rewrite unrelated devlog history.
- Do not merge #526 in the same work-phase; return to #526 after this blocker is
  fixed and hosted checks are rerun.

Expected outcome:

- A dev-target PR or direct dev commit removes the checkout-time failure.
- PR #526 can be rerun/merged after this baseline fix lands.
