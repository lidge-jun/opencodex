# Audit verdicts — five parallel lanes, `gpt-5.6-sol` at `high`

Dispatched read-only against `origin/main...origin/dev` (`ebb4d552e` → `9af3a7beb`).
Every lane returned `VERDICT: PASS`. No release blocker in any scope.

## Lane A — core request and routing path

PASS. Covered the dated-model fold and its direction guard
(`src/codex/catalog/provider-fetch.ts:943`, `:1004`, `:1737`), spill admission /
reservation / eviction and synchronous replay materialization
(`src/responses/state.ts:419`, `:1741`, `:1951`), burst-window freshness and account
selection (`src/codex/routing.ts:363`, `:408`, `:1202`), metadata stripping and
web-search repair (`src/adapters/openai-responses.ts:246`, `:950`, `:2165`), encrypted
MESSAGE detection (`src/server/responses/encrypted-payload.ts:195`), vision sidecar
parity (`src/vision/eligibility.ts:79`), cursor pre-header EOF retry
(`src/adapters/cursor/live-models.ts:65`, `:265`).

The three hypotheses this lane was sent to disprove all held: the fold guard does not
collide ids, eviction does not outrun an in-flight reader, and the burst-window change
does not park a healthy provider. Nothing changed under `src/router.ts` or `src/routing/`.

## Lane B — auth, credentials, security boundary

PASS. Covered the Anthropic refresh-intent lifecycle, CAS cleanup, transient and
uncertain failures, disk-credential adoption and cross-process locking
(`src/oauth/index.ts:602`, `:642`, `:794`; `src/oauth/store.ts:161`, `:183`, `:236`,
`:279`), owner-only credential writes (`src/config/atomic-write.ts:118`, `:160`), the
WHAM-401 refresh/replay path with generation fencing and bounded recovery
(`src/codex/auth-api.ts:984`, `:1021`, `:1063`; `src/codex/account-store.ts:611`,
`:659`, `:854`; `src/codex/quota-401-recovery.ts:57`, `:97`).

`bun run privacy:scan` exited 0: `Privacy scan passed`.

## Lane C — CLI, service, update, lifecycle

PASS, and it settled the gate question. `ocx start` port probing is deliberate and cold
installs still get defaults (`src/cli/index.ts:215`); health retries three times
(`src/cli/dispatch.ts:573`). History-only restoration now exits 79
(`src/cli/index.ts:1043`), with Bun and Node update lanes sharing one fail-closed
decision (`src/update/stop-decision.mjs:26`, `bin/ocx.mjs:375`) and the durable launcher
mirroring the child exit code (`bin/ocx.mjs:711`). Normal systemd/launchd stop is
unaffected. Version 2.39.0 is derived from `package.json` everywhere rather than
duplicated into constants.

**Gate determination: both promotion SHAs need their own successful Service lifecycle
run.** The green `dev` run does not substitute for a promotion-SHA run.

## Lane D — GUI and docs

PASS. All 111 changed files accounted for. Conflict overwrite is consent-gated — the
locked switch cannot trigger it; a danger button opens a consequence dialog and the PUT
with `overwriteConflict: true` only follows confirmation
(`gui/src/pages/integrations/FileIntegrationPage.tsx:231`, `:284`). All 68 referenced
SVG paths exist in source and in built output, including all 29 new provider marks, with
no active-content SVG payload. `bun run build:gui` exit 0, `bun run lint:gui` exit 0,
docs build produced 401 pages.

## Lane E — release mechanics, and the stale preview tag

PASS on blockers, and it corrected an assumption in `000_plan.md`.

**The v2.38.0 preview CI failure was not the macOS launcher flake.** Run `33386559501`
failed `macos` and `test 1/4` for one deterministic reason:

> package.json version 2.38.0-preview.20260831 is BEHIND the highest release tag v2.38.0

That is `tests/release-version-line.test.ts:112`, and the same-core rule it rests on is
asserted non-vacuously at `:128`: `compareReleaseTags("v2.34.0-preview.1", "v2.34.0")`
is negative. SemVer orders a prerelease below its own stable. Cutting
`2.38.0-preview.*` **after** `v2.38.0` had already shipped was a version-selection
mistake, and the test caught it exactly as designed. Verified independently by reading
the test source; the lane's account is correct.

This matters for us: it is not a flake to rerun past. Our
`2.39.0-preview.20260901` is a prerelease of a *future* core version relative to
`v2.38.0`, which the same helper orders as ahead. The trap is avoided by construction.

Lane E also flagged a topology detail worth recording: a plain merge of `dev` into
`preview` baselines its service-gate diff from `v2.36.0-preview.20260830`, because
neither parent contains `v2.38.0`. The main merge baselines from `v2.38.0`. Both diffs
include the service paths, so both need the run either way.

## Standing residual

PR #3073 documents an intermittent macOS `tests/shutdown-launcher.test.ts` failure that
does not reproduce on Linux. It did not appear in run `33386559501` and is not implicated
in this release, but it can still surface on a promotion run. If it does, it is a
known test-harness issue, not a product regression — rerun once and escalate only if the
same assertion fails twice.
