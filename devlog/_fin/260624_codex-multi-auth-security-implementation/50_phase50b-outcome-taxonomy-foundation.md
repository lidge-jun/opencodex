# 50B - Phase 50B Plan: Codex Upstream Outcome Taxonomy Foundation

Date: 2026-06-24

Status: implemented, focused-verified.

## Objective

Continue Patch 5 from `/Users/jun/Developer/new/700_projects/opencodex/devlog/280_codex-multi-auth-security-patch-plan/00_patch_plan.md` by replacing the current "every non-2xx is an account failure" behavior with a small explicit outcome taxonomy.

This phase is intentionally narrow:

- caller/model 4xx responses do not penalize the selected Codex account;
- credential failures immediately quarantine the selected Codex account;
- 5xx and provider-connect failures count toward transient failover;
- passthrough connect failures are recorded before returning the local 502, with a server-level integration test;
- 429 and terminal SSE/WebSocket application failures remain documented follow-up slices.

## External Basis

RFC 9110 separates HTTP status classes by semantics: 4xx is client error, 5xx is server error, 401 is authentication-specific, and Retry-After can accompany temporary unavailability or rate limiting. That means account health must not treat ordinary caller/model 400/404/422 responses as equivalent to provider outage or credential failure.

References checked:

- RFC 9110 HTTP Semantics: https://datatracker.ietf.org/doc/html/rfc9110

## Acceptance Criteria

- `recordCodexUpstreamOutcome(config, accountId, 400 | 404 | 422)` does not increment upstream health and does not trigger account failover.
- `recordCodexUpstreamOutcome(config, accountId, 401)` marks the account as needing reauth and immediately makes future new threads pick another usable pool account when one exists.
- `recordCodexUpstreamOutcome(config, accountId, 403)` is treated as credential-specific for now and also quarantines the account.
- `recordCodexUpstreamOutcome(config, accountId, 500 | 502 | 503 | 504)` increments transient health and still honors `upstreamFailoverThreshold`.
- `recordCodexUpstreamOutcome(config, accountId, "connect_error")` or equivalent explicit connect outcome increments transient health.
- Passthrough upstream fetch failures in `src/server.ts` record a connect failure for the selected pool account before returning the local `502`.
- The server catch behavior is verified through `startServer(0)` and a loopback `POST /v1/responses` request against an unreachable passthrough base URL.
- Existing 2xx reset behavior remains unchanged.
- The public request log still uses safe provider labels only; no local account IDs or emails are introduced.

## File Plan

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/codex-routing.ts`

Add a small exported taxonomy:

```ts
export type CodexUpstreamOutcome =
  | number
  | "connect_error"
  | "timeout";

export type CodexUpstreamOutcomeClass =
  | "success"
  | "credential"
  | "quota"
  | "transient"
  | "caller"
  | "unknown";

export function classifyCodexUpstreamOutcome(outcome: CodexUpstreamOutcome): CodexUpstreamOutcomeClass
```

Classification rules:

- status `200..299` => `success`;
- `401` and `403` => `credential`;
- `429` => `quota` but no cooldown behavior yet in this phase;
- `400..499` => `caller`;
- `500..599`, `"connect_error"`, and `"timeout"` => `transient`;
- everything else => `unknown`.

Change `recordCodexUpstreamOutcome()` to:

- reset health on `success`;
- ignore `caller` outcomes entirely;
- mark reauth and clear thread affinity on `credential`;
- increment upstream health for `transient`, `quota`, and `unknown`;
- for credential outcomes, do not rely on `applyFailureFailover()` because it is threshold-based; instead make the account unusable by reauth marking and clear its affinities, so the next `resolveCodexAccountForThread()` call selects another usable pool account;
- for transient/quota/unknown outcomes, apply normal threshold-based failover after increment if the selected account is active.

The `upstreamHealth.lastFailureStatus` field can remain numeric for statuses and use `0` for connect/timeout sentinels to avoid widening unrelated API shapes in this slice.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/server.ts`

In passthrough `fetchWithHeaderTimeout()` catch:

- before returning `formatErrorResponse(502, ...)`, call `recordCodexUpstreamOutcome()` when `authCtx.kind === "pool"`;
- use `"timeout"` when the thrown error name is `TimeoutError`;
- use `"connect_error"` otherwise.

Keep the response body and status unchanged.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-routing.test.ts`

Import `clearAccountNeedsReauth` from `/Users/jun/Developer/new/700_projects/opencodex/src/codex-auth-api.ts` and clear reauth state for test pool ids in `beforeEach()` and `afterEach()` because credential-outcome tests intentionally mark accounts as reauth-needed.

Update the old test named `three consecutive non-200 responses fail over future new threads` to `three consecutive transient failures fail over future new threads`.

Add tests:

- caller/model 4xx responses are ignored for health/failover;
- 401 quarantines an account immediately and marks reauth;
- 403 quarantines the account under the current conservative credential policy;
- connect failures contribute to failover;
- classifier returns the expected labels for representative status codes and connect sentinels.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/server-auth.test.ts`

Add a server integration test:

- create a temporary `OPENCODEX_HOME`;
- save a config with default provider `chatgpt` using the `openai-responses` passthrough adapter and an unreachable loopback port;
- save pool credentials and set `activeCodexAccountId` to that pool account;
- start the proxy with `startServer(0)`;
- `POST /v1/responses` to `server.url` with loopback origin and a small valid Responses body;
- assert the response is `502`;
- assert `getCodexUpstreamHealth(poolId)` shows one recorded connect/timeout failure;
- stop the server and restore environment state.

This avoids exporting `handleResponses()` only for tests.

### OPTIONAL MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-auth-context.test.ts`

No planned change unless focused routing tests expose reauth-state cleanup needs.

## Verification Plan

Focused:

```bash
bun test tests/codex-routing.test.ts tests/server-auth.test.ts
```

Full:

```bash
bun run typecheck
bun test tests
cd gui && bun run build
git diff --check
git status --short
```

Independent verification:

- dispatch a read-only Backend/Security verifier to confirm caller 4xx no longer burns account health, credential failures fail closed/quarantine, and connect failures now count toward failover without exposing account identifiers.

## Implementation Evidence

Changed files:

- `/Users/jun/Developer/new/700_projects/opencodex/src/codex-routing.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/server.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-routing.test.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/server-auth.test.ts`

Implemented:

- Added `CodexUpstreamOutcome`, `CodexUpstreamOutcomeClass`, and `classifyCodexUpstreamOutcome()`.
- `recordCodexUpstreamOutcome()` now ignores caller/model 4xx outcomes, quarantines 401/403 credential outcomes with reauth marking plus thread-affinity purge, and records connect/timeout sentinels as transient failures.
- Passthrough connect/timeout failures in `src/server.ts` now record selected pool account health before returning local `502`.
- Routing tests now clear reauth runtime state and cover classifier labels, caller 4xx no-penalty behavior, 401/403 quarantine, and connect-failure failover.
- Server integration test now proves the passthrough connect catch records pool account health through `startServer(0)` and `POST /v1/responses`.

Focused verification:

```text
bun test tests/codex-routing.test.ts tests/server-auth.test.ts
27 pass
0 fail
70 expect() calls
```

## Out Of Scope For This Slice

- 429 cooldown window using `Retry-After` or quota reset metadata.
- Time-bounded failure streak expiry using `lastFailureAt`.
- Recording terminal SSE or WebSocket `response.failed` / `response.incomplete` after stream completion.
- Selected-pool sidecar outcome recording for web-search and vision sidecars; this needs a separate hook across `/Users/jun/Developer/new/700_projects/opencodex/src/web-search/executor.ts` and `/Users/jun/Developer/new/700_projects/opencodex/src/vision/describe.ts` and will be handled as a follow-up Patch 5 slice.
- WebSocket auth-context consistency beyond already-merged fail-closed handling.

## Plan Audit Fixes

- Added reauth-state cleanup to the routing test plan because 401/403 tests mutate module-level runtime state.
- Added a `startServer(0)` integration test plan for the passthrough connect-failure catch so server wiring is verified, not only the routing helper.
- Clarified that credential quarantine must not rely on threshold-based `applyFailureFailover()`.
- Explicitly scoped sidecar account-outcome recording out of Phase 50B and into a follow-up Patch 5 slice.
