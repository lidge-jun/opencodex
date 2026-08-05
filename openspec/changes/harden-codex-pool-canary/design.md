## Context

The existing persistent proxy on port 10123 has real shared account credentials and active requests. It is not a safe surface for deliberately provoking quota failures or changing account selection. Existing unit tests cover individual pool decisions but do not bind the Responses retry path, alternate credential selection, thread affinity, and state bounds in one disposable scenario.

## Decision

Adopt the existing Bun test runtime and Responses handler rather than starting a second long-lived proxy or using a real provider. The canary will create only synthetic account records in a test-owned temporary `OPENCODEX_HOME`, mock the outbound fetch boundary, and make a first pre-stream 429 response followed by a successful non-streaming Responses JSON response from an alternate synthetic account. A test-only start seam suppresses the otherwise fire-and-forget startup quota prime; synthetic fresh quota snapshots keep the request-path lazy prime dormant; and test cleanup awaits the server lifecycle drain before restoring the environment or removing temporary homes.

The canary will assert:

1. exactly one alternate-account retry occurs after the quota failure;
2. a health request remains successful before and after the turn;
3. the failing account is excluded from the continued thread route while the alternate account is retained;
4. routing state reaches but does not exceed the documented affinity-entry bound, keeps a recent affinity sticky, and rebinds an evicted oldest thread after a selection change; and
5. no bearer or credential reaches assertions, test output, or a public runtime endpoint.

If the existing module lacks a safe way to observe the affinity count, add an explicitly test-only export in `src/codex/routing.ts`. Do not add an unbounded diagnostic endpoint or persist canary state.

## Failure and rollback proof

The first upstream response is a local synthetic 429. The required recovery proof is the alternate-account successful non-streaming Responses JSON response with the original service still health-checkable. All test state is created beneath the test fixture root and removed by test cleanup; no recovery action is needed for 10123 because it is not involved.

## Non-goals

- No use, copying, refresh, login, pause, or selection of the real Codex account pool.
- No real provider traffic, quota consumption, service installation, restart, or port-10123 operation.
- No change to production pool strategy or memory-watchdog thresholds.
