# 005 — Audit round r1-20260818030046: FAIL, 6 findings, all accepted

Reviewer: independent sol/high agent, read-only, told to break the plan before any
rebase step ran. Verdict **FAIL**. Every finding was re-verified against the tree
before absorption; none was waved through and none was argued away.

## F1 (High) — Cursor tool-result images never reach the encoder in production

**Verified.** The chain:

1. `src/providers/registry.ts:978-982` puts **every** Cursor model in
   `noVisionModels`, with the comment "Cursor's wire protocol never forwards image
   parts (request-builder emits an unsupported-content marker), so the vision
   sidecar covers ALL cursor models."
2. `src/server/responses/core.ts:2225-2243` runs the sidecar before the adapter:
   `describeImagesInPlace` when a plan exists, else `stripImagesInPlace` fail-closed.
3. `src/vision/index.ts:252-259` — `carriesImages()` explicitly includes
   `toolResult`. `:565-581` replaces each image part with a text description.
4. `tests/cursor-tool-result-image.test.ts:52-77` calls `encodeCursorRunRequest`
   directly with hand-built `rawMessages`, so it never crosses that preprocessing.

So the 020 encoder work is correct in itself and **unreachable in production**. The
registry comment it was built against is now half-stale: the request-builder marker
is still true for USER images, but no longer true for tool results.

**Disposition: accepted, and explicitly NOT fixed in this unit.** The fix is a
capability-policy change spanning `src/providers/registry.ts` and
`src/vision/index.ts`, and the reviewer is right that simply dropping Cursor from
`noVisionModels` is unsafe because user-message images are still flattened at
`src/adapters/cursor/request-builder.ts:206-214` — the model would then get
neither the image nor a description. It needs role-aware preprocessing plus an
end-to-end regression through the server path.

Two things this unit DOES do about it: record it as follow-up 1 in `000`, and
correct the overstated capability claim so no later doc reads as if the capability
shipped end-to-end.

## F2 (High) — the merge bypasses a gate `MAINTAINERS.md` requires

**Verified.** `MAINTAINERS.md:48-49`: "A pull request requires approval from at
least one maintainer and successful required CI checks before merge."
`AGENTS.md:251-253` makes `MAINTAINERS.md` authoritative over `AGENTS.md`.

The user waived CI checking and granted admin merge. That is the repository owner
exercising owner authority, which is a real thing — but it does not make the merge
*policy-satisfying*, and lidge is Linux-only while CI covers Linux, Windows, and
macOS. Windows-sensitive surfaces are exactly where this repository has been bitten
before.

**Disposition: accepted as a stated governance exception, not as compliance.**
`040` now records: (a) the user's waiver is the authority for merging without CI;
(b) the merge is therefore an owner-authorized exception; (c) the platform gap is
named — Linux-only evidence; (d) the readiness note in `050` must not claim
"policy-compliant release-ready", only "gates green on Linux, CI waived by owner".
A release-readiness claim that hides this is the failure mode.

## F3 (Medium) — the surviving EOF shape drops partial usage

**Verified, and this one needs code.**

- Thrown path: `attachPartialUsage` (`live-transport.ts:1195-1199`) puts
  `partialUsage` on the error, and `src/adapters/cursor.ts:181-192` copies it into
  the emitted `error` event.
- Event path: `finalizeTurnEvents` returns
  `[{ type: "error", message }]` with **no usage**
  (`protobuf-events.ts:1361-1372`), even though `CursorServerMessage`'s error
  variant carries `usage?: OcxUsage` (`src/adapters/cursor/types.ts:44-48`) and
  `resolvedTurnUsage(state)` is right there at `:1340`, already used by the `done`
  branch at `:1376`.

So choosing dev's shape (correct on its own merits) would silently trade away
usage reporting on truncated turns. That is a real regression, not a style point.

**Disposition: accepted. New work-phase `wp2b-eof-usage`, doc `015`.** The EOF
error gets `usage: resolvedTurnUsage(state)`, with a regression test that fails
before the change.

## F4 (Medium) — the three-PR stack cannot be formed at clean boundaries

**Verified.** `git log --oneline --reverse <base>..cursor-call` shows ten devlog
commits before the first code commit, then docs interleaved after each
implementation phase (`dfb6fb884`, `6d9744283`, `3f5bf955d`, `f10108315`,
`fe2237038`, `66b9df9ef`). A "PR1 = adapter code only, PR3 = all devlog" split
requires reordering or cherry-picking, which makes it not a stack of this history.

The reviewer also caught a verification hole: `020` verifies only the final tip,
while `030` planned to reuse that evidence for every layer. `AGENTS.md:178-180`
wants each non-trivial PR verified.

**Disposition: accepted. `030` is rewritten** to open ONE PR from `cursor-call`
to `dev`, with the reasoning recorded, and criterion `c6` is reworded from
"stacked PRs" to "PR(s) matching the actual topology". The user asked for a stacked
PR; the honest answer is that this history is one linear chain and a fabricated
split would be less reviewable, so the plan says so out loud instead of
manufacturing three PRs whose contents do not match their titles.

## F5 (Medium) — gates sequenced after the merge, and `audit:high` missing

**Verified.** `scripts/release.ts:374` runs `bun run audit:high` and `:380` runs
`bun run privacy:scan`; `package.json:52` shows `prepush` runs typecheck, gui
lint, test, and privacy:scan. Deferring privacy:scan until after the merge means a
PR could be merged with it red.

**Disposition: accepted.** `020` now runs `privacy:scan` and `audit:high` BEFORE
the PR, `030` requires the docs determination before ticking the template box, and
`050` re-runs the gates on merged `dev` as confirmation rather than as first
contact.

## F6 (Low) — the inventory's counts were wrong

**Verified.** The snapshot touches 28 paths, not 18; the table collapsed ten devlog
files into one row while the prose said "all 18 files". And `cursor-call` is now 32
commits (the plan commit itself), so `origin/dev..cursor-call` no longer returns 31.

**Disposition: accepted.** `000` now states 28 paths (18 source/test + 10 devlog)
and 32 commits, and distinguishes the snapshot ref from the moving branch.

## What survived the attack

Recorded because a surviving claim is evidence too:

- No compile break from dev's changes to `src/types.ts`, `tool-definitions.ts`,
  `tool-catalog-nudge.ts`, `parser.ts`, `router.ts`, `core.ts`, `registry.ts`.
- A thrown `CursorStreamTruncatedError` would NOT cause a retry: retry needs no
  emitted event, an uncommitted request, and a transient error
  (`transport-retry.ts:92-105`), and the request is committed on HTTP/2 connect.
  So "the event shape loses a useful retry" is not a reason to keep the throw.
- The literal merged EOF block uses the right variables and preserves dev's guard
  ordering; `|| this.emittedTerminal` swallows no dev-covered case.
- `CursorStreamTruncatedError` becomes dead code after the import is dropped, but
  compiles.
- The Google patch location is right: `parseResponse` at `:812`, `candidates` in
  scope from `:894`, insertion after the truncation guard is safe.
- GUI lint/build N/A for a source-only diff is reasonable.

