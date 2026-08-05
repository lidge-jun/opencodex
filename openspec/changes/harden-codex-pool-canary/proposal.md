## Why

The Codex account pool has component-level rotation and failure tests, but no one isolated canary proves that a real Responses turn can move from a synthetic quota-rejected account to an alternate account while preserving service availability and bounded account-affinity state. The live audit also showed that RSS alone is not enough to diagnose retained application state.

## What Changes

- Add a deterministic, local-only Codex pool canary covering a pre-stream quota rejection followed by one alternate-account success.
- Add test-only routing-state observation needed to assert the documented thread-affinity bound without exposing account identifiers through a runtime API.
- Exercise the canary under many synthetic thread ids and assert that the pool state remains bounded and the HTTP surface stays healthy.

## Capabilities

### New Capabilities

- `codex-pool-canary-safety`: Deterministic isolated verification of Codex pool failover, continuity, and bounded affinity state.

### Modified Capabilities

- None.

## Impact

- `src/codex/routing.ts` test-only state observation and `src/server/index.ts` test-only startup-prime suppression, if required by the canary.
- A focused Bun regression test under `tests/`.
- No provider configuration, credential-store format, management API, dashboard behavior, or production service changes.
