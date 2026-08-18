# 060 — Release readiness for the cursor-call integration

**Verdict: dev is releasable. Recommend cutting `2.25.0` — a minor, not a patch.
The decision is the maintainer's; this note recommends and does not act.**

## What landed

| PR | Merge | Content |
|----|-------|---------|
| [#1993](https://github.com/lidge-jun/opencodex/pull/1993) | `228295b3f` | Cursor wire: clean-EOF terminal gate, real `McpImageContent` in tool results |
| [#1994](https://github.com/lidge-jun/opencodex/pull/1994) | `bb3e5db19` | Unexpected server-side CANCEL provenance |
| [#1995](https://github.com/lidge-jun/opencodex/pull/1995) | `4f72d6f75` | Bridge/adapter terminal semantics + WP2b EOF usage |

`dev` = `4f72d6f7555013ab231de78233d2aa95bd1e439c`.

Ancestry proven rather than assumed:

    git merge-base --is-ancestor ff4b0bb4e627354bb57aa7317e690482b2a95312 4f72d6f755  # exit 0
    git merge-base --is-ancestor 4f72d6f755 origin/dev                                # exit 0

## Gates, at the MERGED SHA

A merge commit is a tree nobody has tested until it is tested, so these ran against
`4f72d6f755` itself — not the pre-merge tip — in a dedicated lidge worktree pinned to
that SHA (`/tmp/ocx-dev-4f72d6f75`), with HEAD re-asserted before each gate.

| Gate | Result |
|------|--------|
| `bun x tsc --noEmit` | exit 0, no output |
| `bun run privacy:scan` | `Privacy scan passed` |
| `bun run audit:high` | `No vulnerabilities found` (root and gui) |
| `bun run build:gui` | `✓ built in 205ms`, `prepare:package` ran |
| `bun test --isolate tests` | green |

The same five were green at the pre-merge tip `ff4b0bb4e`. Both runs are in
`.tmp/cursor-call-receipts.log`.

## Governance: this was owner authority, not compliance

Stated plainly because a readiness note that hides it is worthless.

`MAINTAINERS.md:48-49` requires maintainer approval **and** successful required CI
checks before merge. The user waived CI and granted admin merge, and all three PRs
were merged with `--admin`. That is the repository owner exercising owner authority
over their own repository. It is **not** policy compliance, and this note does not
claim it is.

The platform gap that follows: lidge is Linux; CI covers Linux, Windows and macOS.
This campaign's diff contains no shim, installer, PowerShell, platform dispatch, or
Windows path handling, which is why Linux evidence is adequate *for this diff*. It is
not a claim that Linux equals CI.

Cross-platform CI did start on the merge commit and was `in_progress` when this note
was written. Nothing here waited on it.

## What publishing would still require

`scripts/release.ts` is the release authority, and it waits for a successful
**Cross-platform CI** run AND a successful **Service lifecycle** run at the exact
release SHA (`:393-401`). So a "go" is not one command away: the release commit has
to be pushed and both workflows have to pass at that SHA before the workflow
dispatch. Anyone reading a green gate table and assuming `bun run release` will just
work would be wrong.

## Version state, read live

    live main   e2d4621d431f3c0a97d67abbcd875b50c73ac661
    live dev    4f72d6f7555013ab231de78233d2aa95bd1e439c
    npm         { preview: '2.23.0-preview.20260816', latest: '2.24.2' }
    releases    v2.24.2 (latest), v2.24.1, v2.24.0

`dev` advanced to `aad8e26014dab0921c768a639f9d324af6f1fa27` when this note itself
merged. That commit adds this file and nothing else
(`git diff --name-only 4f72d6f755 aad8e2601` → one path), so the gate evidence above
still describes the code on `dev`.

## Workflow state at the gated SHA — measured, not assumed

The objective asked whether the two workflows `scripts/release.ts` waits for exist
for this SHA. They do not, and the reasons differ:

| Workflow | State at `4f72d6f755` | Why |
|----------|----------------------|-----|
| Cross-platform CI | `in_progress` (run `32104616258`, started 05:53:03Z) | started automatically on the merge; still running when this note was written |
| Service lifecycle | **never ran** | correct: it triggers only on `src/service.ts`, `src/cli.ts`, `src/cli/index.ts`, `src/lib/bun-runtime.ts`, `package.json`, `bun.lock`, or its own workflow file (`.github/workflows/service-lifecycle.yml:6-16`). This campaign touched none of them — verified with `git diff --name-only` across the whole merge range |

**This is not a blocker, and the distinction matters.** `release.ts:397-401` waits
for Service lifecycle at the RELEASE commit, and the release commit always bumps
`package.json` — which is a trigger path. So the workflow will fire when the release
is cut. Its absence here means the campaign did not touch service-lifecycle surface,
not that a gate was skipped.

What this does mean: **no cross-platform evidence exists for this code yet.** The CI
run is unfinished and nothing has waited on it. Windows and macOS remain unverified
for this diff, and the Linux-only argument above is the whole of the platform
evidence.

## Recommendation: 2.25.0

A minor rather than a patch, because the externally observable behaviour of a failed
turn changed. A turn that previously came back `completed` with a vanished tool call
now reports `failed` with a truncation error; an unrequested CANCEL that used to
return silently is now a typed transport failure; and a truncated compaction turn no
longer installs half-written replacement history. Anything downstream that keyed on
"the proxy said completed" sees new behaviour — correct behaviour, but new.

The maintainer decides. This note recommends.

## Promotion sequence, prepared and NOT executed

    # dev -> preview
    git fetch origin
    git checkout preview && git merge --no-ff origin/dev
    git push origin preview

    # dev -> main (release train)
    git checkout main && git merge --no-ff origin/dev
    git push origin main

Preconditions before running either:

1. **Cross-platform CI green.** Run `32104616258` was still `in_progress` at the
   time of writing; check it before promoting:

       gh run view 32104616258 --json status,conclusion

   This is the only outstanding technical precondition, and it is the one the
   owner's CI waiver covered for the merge but does NOT cover for a release —
   `release.ts` blocks on it regardless of what a human waived earlier.
2. **Service lifecycle** needs nothing here: it did not run at this SHA because the
   campaign touched none of its trigger paths, and it will fire on the release
   commit's `package.json` bump. Do not wait for it on `dev`.
3. **A version decision** (see the recommendation above). The promotion itself does
   not bump; `scripts/release.ts` owns that and is the only sanctioned publish path
   — never a direct `npm publish`.

## Open follow-ups a reader would otherwise assume were fixed

1. **Cursor tool-result images do NOT reach production.** The encoder emits real
   `McpImageContent`, and that part is correct — but every Cursor model is in
   `noVisionModels` (`providers/registry.ts:978-982`), so the vision sidecar
   describes or strips images before the adapter runs
   (`core.ts:2225-2243`, `vision/index.ts:252-259,565-581`). The campaign's own
   docs overstated this once and were corrected. Closing it needs role-aware vision
   preprocessing plus an end-to-end regression through the server path.
2. **Kiro** `completionMode: "disabled"` observes the normalized reason then emits
   `done` without `stopReason` (`kiro.ts:1315`, `:1485`), so `MAX_TOKENS` and
   `MODEL_CONTEXT_WINDOW_EXCEEDED` vanish.
3. **Google ordinary mode** forwards only `MAX_TOKENS` plus five safety values
   (`google.ts:786-795`); `MALFORMED_RESPONSE`, `UNEXPECTED_TOOL_CALL`,
   `IMAGE_SAFETY` and `LANGUAGE` still become reasonless `done`.
4. **User-message images** are still flattened in `cursor/request-builder.ts`.
5. **Phase 030 (xai `apply_patch`) was NOT REPRODUCED.** A live probe had both
   `xai/grok-4.6` and `cursor/grok-4.6` using `apply_patch` successfully. dev's
   `bc229433a` + `8a4040384` independently fixed the code-mode guidance that had
   forbidden a separately-advertised top-level `apply_patch`, which is the same
   affordance surface 030 suspected. No code was written for it, deliberately.

## Issues closed with this work

`#1866` (Computer Use tool results empty/truncated) is the one this campaign
actually answers. `#1992`, `#1938` and `#1527` were closed as part of the Cursor
sweep with explicit notes about what the merge does and does not cover — #1992's
injected-policy prose is untouched, #1938's integer-for-string coercion is a separate
path, and #1527's rate-limit asymmetry is unaddressed while its silent-collapse half
is fixed. Each says so and invites a reopen.
