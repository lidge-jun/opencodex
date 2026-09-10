# 031 — wp3 disposition: PR #2986 / #2083 do NOT land in this train

## Decision

**NEEDS_REWORK, not merged.** The roadmap (030_phase3.md) assumed #2986 was a clean carry
awaiting a maintainer merge. Refreshing the live state at execution time contradicted that.

## Evidence at execution time

- `gh pr view 2986` — `OPEN`, `mergeStateStatus: BLOCKED`,
  head `842170b6f3d076a8274c1cba8824f3e3c56f0bb7`.
- `reviewDecision: CHANGES_REQUESTED`, from maintainer @Ingwannu — not a stale bot nit.
- `git rev-list --count 870a2adb6eaccc9da9ea9832a596e1b2650ab1ea..origin/dev` → **179**.
  The PR base is 179 commits behind `dev`, so its green CI describes a tree that no longer
  exists — the same freshness problem that caused the carry in the first place.

## What the maintainer asked for

Three runtime edge cases, each concrete and each still open:

1. `src/images/fulfill.ts` resolves `aspect_ratio: "auto"` to `undefined` before calling
   `callXaiImages`, so `resolveAspectRatio()` treats the field as absent and derives a ratio
   from `size`. An explicit Auto selection therefore stops suppressing size-derived selection.
2. `src/responses/parser.ts` replaces only the *first* unnamespaced `image_gen` when a hosted
   declaration arrives. With both an ordinary and a custom root declaration ahead of it, the
   second survives and the catalog stays ambiguous.
3. The default downloader in `connectPublicHttps` passes `maxBytes: undefined` to
   `pinnedHttpGet`, dropping the `MAX_DOWNLOAD_BYTES` cap when a caller omits a limit.

Plus a docs correction: the xAI `/v1/images` relay runs only when `bridgeEnabled === true`
**and** `images.provider` is omitted; an explicit image provider owns the route.

## Why this train does not do it

Merging over an explicit maintainer `CHANGES_REQUESTED` with `--admin` would spend the
maintainer's review authority to bypass the maintainer. Item 3 is a byte-cap regression on a
credentialless download path — a security-boundary defect, exactly the class
`MAINTAINERS.md` says needs review rather than an override.

The rework is tractable (four small edits plus a rebase) but it is a different unit of work
from "land a reviewed PR", and it belongs to the author on the same branch, which is what the
maintainer explicitly asked for: *"Please address these on the same branch and rerun the
focused image/parser suites."*

## Outcome

- #2986: left open, awaiting author rework. No admin merge.
- #2083: left open. Closing it as `landed-via-maintainer` would be false — nothing landed.
- Train continues to wp4 (#3094), wp5 (#3108), wp6 (#3158 docs).

