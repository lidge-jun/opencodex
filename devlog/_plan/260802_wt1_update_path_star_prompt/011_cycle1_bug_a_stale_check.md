# Cycle 1 (wp1, Bug A #871) — P-phase re-verification record

## Stale check vs pre-written 010 doc (2026-08-02, worktree codex/wt1-update-path @ dev tip)

- `src/update/notify.ts` `isNewer` confirmed unfixed on dev: latest channel does
  `const c = parseStable(current)` → `null` for `2.8.2-preview.20260731` → returns
  `false` → GUI reports `already_latest`. Bug present, doc not stale.
- Consumers confirmed: `src/update/badge.ts:69` (`updateAvailable: isNewer(cache.latest_version, current, channel)`),
  `src/update/job.ts:317` `checkForUpdate` (GUI one-click path), `src/update/job.ts:1377`.
- Existing tests: `tests/update-notify.test.ts` has latest/preview channel tables;
  `tests/update-job.test.ts` has `checkForUpdate("latest", ...)` fixtures with
  injectable `currentVersion`/`detectInstall`/`latestVersion` deps — the PR's test
  slots fit without new fixtures.

## Semantics decision (aligned with PR #871 diff)

- Current side, latest channel: `parseStable(current) ?? parsePreview(current)?.slice(0, 3)` —
  an installed preview compares by its `major.minor.patch` core.
- Target side stays strict: `parseStable(latest)` only — a preview registry target is
  never accepted on the latest channel (parity with codex-rs, existing doc comment).
- Same-base case: `2.9.1` vs installed `2.9.1-preview.N` → NOT newer. Although semver
  precedence says stable > its prerelease, the product rule matches the preview
  channel's existing O3 decision (same base = no nag); the release train promotes a
  preview to the same-base stable, so the update is content-lateral. This mirrors
  PR #871's test expectations exactly; deviating would fork behavior from the
  contributor PR under review.

## External verification (sol-medium lane, cxc-search)

| Claim | Result |
|-------|--------|
| semver: prerelease < associated release (2.9.1-preview.N < 2.9.1) | verified — SemVer §9/§11.3 (semver.org) |
| semver: numeric prerelease identifiers compare numerically | verified — SemVer §11.4.1 |
| npm: bare install resolves the `latest` dist-tag; preview train belongs on its own tag | verified — npm-dist-tag docs (Description/Purpose/Caveats) |
| npm: `2.9.1-preview.N` does NOT satisfy `^2.9.1` | verified — node-semver Prerelease Tags + Caret Ranges |

Tension resolved: strict semver says same-base stable (2.9.1) IS newer than
2.9.1-preview.N, but this repo's comparator deliberately treats same-base as
not-newer on BOTH channels (preview-channel O3 rule predates this fix; PR #871
encodes the same expectation for the latest channel). Rationale: the release
train promotes a preview to its same-base stable, so the update is
content-lateral and offering it is a nag. This is a product decision, recorded
here so a future "strict semver" refactor can find it.

## Known limitation (audit blocker 1, folded)

Respin preview tags exist in the wild: `v2.7.9-preview.20260712.1` / `.2` —
i.e. `x.y.z-preview.YYYYMMDD[.r]`. `parsePreview`'s
`/^(\d+)\.(\d+)\.(\d+)-preview\.(\d+)$/` rejects the trailing `.r`, so installs
on a respin preview remain stuck at `already_latest` even after this fix. This
gap predates the fix on BOTH channels and expanding the comparator would fork
behavior from PR #871, so it stays out of scope here. Follow-up candidate:
widen `parsePreview` to `(\d+)(?:\.(\d+))?$` and treat the respin counter as an
extra `gt` tuple element (needs its own cycle + tests).

## Implementation delta (diff-level)

- MODIFY `src/update/notify.ts` — one line in `isNewer` latest-channel branch:
  `const c = parseStable(current) ?? parsePreview(current)?.slice(0, 3);`
  plus doc-comment update naming the preview-core rule.
- MODIFY `tests/update-notify.test.ts` — add latest-channel case:
  `isNewer("2.9.1", "2.8.2-preview.20260731", "latest") === true`,
  `isNewer("2.9.1", "2.9.1-preview.20260731", "latest") === false`.
- MODIFY `tests/update-job.test.ts` — add `checkForUpdate("latest", ...)` case:
  older preview → `updateAvailable: true, canUpdate: true`; same-base preview →
  both false (`already_latest`).

## Activation scenarios (C)

1. Red: new tests fail on unmodified tree (preview current → `already_latest`).
2. Green: all three files' tests pass after the one-line change.
3. No regression: full `bun run test` + `bun run typecheck`.
