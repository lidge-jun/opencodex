# 070 — Outcome

## What shipped

`GATED_MODEL_CLIENT_VERSION_FLOOR` became a lower bound on tier 2 of
`resolveCodexEntitlementClientVersion` instead of only a tier-3 fallback. A host whose
persisted Codex CLI is real but older than the measured floor now asks upstream at the floor
and keeps gpt-5.6-sol/terra/luna. A runtime at or above the floor is preserved exactly, and an
inbound `client_version` still wins outright.

Two commits:

1. the fix, three regressions, and this plan unit;
2. review findings — documentation of the prerelease ordering gap, a note that the tier-1
   absence guard is now reachable only from tier 1, and a fixture that tracks the floor
   instead of a hardcoded minor. No behaviour change.

## Verification

```text
bun test tests/codex-model-entitlements.test.ts   49 pass  0 fail   (exit 0)
bun test claude-models-discovery + codex-catalog
     + codex-catalog-sync-hardening              303 pass  0 fail   (exit 0)
bun run typecheck                                 exit 0
bun run privacy:scan                              Privacy scan passed
```

The three regressions were driven RED against the unfixed source first, each failing with
`Expected: "0.144.0"  Received: "0.141.0"`, and GREEN after.

On the real host, before and after:

```text
persisted            = 0.141.0
floor                = 0.144.0
resolve(no inbound)  = 0.141.0  ->  0.144.0
resolve(inbound 0.141.0) = 0.141.0  (verbatim, by design)
```

## Full-suite failures: investigated, not regressions

Four tests failed in the full run. Each was re-run in isolation and against clean `dev`
(`c116dc532`):

- `routing profile management editor API > PUT update migrates config references...` and
  `POST /api/client-integrations/restore > distinguishes an unknown operation...` fail
  identically on clean `dev`. Both are 5s/8s timeouts on this slow Windows host.
- Two `server local API auth` cases failed under full-suite load but the file passes 103/0
  when run alone on this branch, and the clean-`dev` baseline for it was 0 fail. Load-related
  flake, and notably not the same two cases across runs.

## Reviewer

An independent opus-5 review returned PASS: the clamp is a genuine `max` that cannot lower,
tier 1 is untouched, no other `selectedVersion` consumer changes, all three tests are genuine
regressions, and no grant can be manufactured because the clamp only changes the query string.
All four of its findings were applied.

## Known limits, recorded deliberately

- `/v1/models?client_version=0.141.0` still omits the rows. A self-declared stale client is
  answered for the version it declared (#2548); the remedy there is upgrading the CLI.
- `max` and `ultra` stay clamped off on a 0.141.0 host. That is a local runtime capability
  limit, not an entitlement one, and re-advertising them would produce failing requests.
- The measured `0.144.0` constant is now load-bearing alone on the background path.
