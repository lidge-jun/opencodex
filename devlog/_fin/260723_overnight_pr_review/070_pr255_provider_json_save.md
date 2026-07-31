# 070 — PR #255: Fix provider JSON editor save flow

- **Author:** rrmlima
- **Branch:** agent/fix-provider-json-save → dev (draft)
- **CI:** enforce-target pass (3x)
- **Sol Review:** Chandrasekhar — VERDICT: FAIL (3 high blockers)
- **Decision:** REBUILD_ON_DEV (take the idea, implement properly)
- **Risk:** High

## Sol Review Summary

### High — Non-atomic save (H1)
Per-provider POST loop exposes intermediate routing states. Network interruption
or concurrent editors can leave partial config committed. Need: single server-side
batch endpoint with candidate validation + one-shot persist.

### High — Incomplete field preservation (H2)
Only 5 fields preserved (apiKey, apiKeyPool, headers, googleMode, modelMaxInputTokens).
Missing: selectedModels, modelInputModalities, reasoningEffortMap, mcpServers,
desktopExecutor, nativeLocalExec, and many more. Nested secrets in mcpServers[*].env
would be silently erased.

### High — TypeScript compilation failure (H3)
OcxProviderConfig cast to Record<string,unknown> causes TS2352. Needs typed helper
function instead of unsafe cast.

### Medium issues
- Default-provider deletion ordering only conditionally safe
- `[key: string]: unknown` index signature suppresses type checking
- Error handling conflates JSON parse errors with network failures

## Rebuild Plan (future work-phase)

Take the core idea: don't let the GUI JSON editor erase server-only fields.
Implement properly with:
1. Typed public DTO / private field merge policy (server-owned)
2. Batch config update endpoint
3. Type-safe field preservation
4. Tests for credential retention, deletion rollback, concurrency

## Status: DEFERRED

The provider JSON editor save flow needs a fundamental architectural change:
an atomic batch config endpoint with typed public/private DTO merge policy.
This is too complex for the current overnight review session.

The PR shows as MERGED on GitHub but the code was reverted from dev. A Sol
review comment has been posted on the PR explaining the 3 high-severity
findings. The rebuild will be tracked as a separate devlog unit when undertaken.
