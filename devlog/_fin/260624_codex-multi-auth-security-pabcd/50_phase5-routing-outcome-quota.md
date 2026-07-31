# 50 - Phase 5: Routing Outcome And Quota State

Status: implementation-ready plan.

## Objective

Routing should switch accounts for the right reasons only. Caller errors must not mark accounts unhealthy, and unknown quota must not look like free quota.

## Planned Changes

### MODIFY `src/codex-routing.ts`

Replace generic non-2xx streak with typed outcomes:

```ts
type CodexUpstreamOutcome =
  | { kind: "success" }
  | { kind: "caller_error"; status: number }
  | { kind: "credential_error"; status: 401 | 403 }
  | { kind: "quota_or_rate_limit"; status: 429; retryAfter?: number }
  | { kind: "transient_upstream"; status?: number; error?: string }
  | { kind: "terminal_stream_failure"; reason: "failed" | "incomplete" | "malformed" };
```

Rules:

- credential errors immediately quarantine account;
- 429 sets cooldown/quota state;
- caller 4xx does not penalize account;
- connect/timeouts/5xx count as transient health;
- stale streaks expire.

### Export Transition

Tests and `src/server.ts` currently import routing helpers directly. Preserve an explicit transition:

- export `CodexUpstreamOutcome` from `src/codex-routing.ts` or a new lower-level `src/codex-routing-outcome.ts`;
- either keep compatibility wrappers such as `recordCodexUpstreamOutcome(config, accountId, status)` and route them into the taxonomy, or update every direct import in tests and `src/server.ts`;
- keep `computeCodexUsageScore()` testable, but change unknown/stale semantics intentionally with updated expectations.

### MODIFY `src/server.ts`

Record:

- connect/timeout failures before returning local 502;
- status-classified outcomes after headers;
- terminal SSE/WS outcome after stream completion where feasible.

### MODIFY `src/codex-quota.ts`

Model quota state:

```ts
type AccountQuotaState =
  | { kind: "fresh"; quota: StoredAccountQuota; observedAt: number }
  | { kind: "stale"; quota: StoredAccountQuota; observedAt: number }
  | { kind: "unknown" }
  | { kind: "error"; lastKnown?: StoredAccountQuota; error: string };
```

Unknown must not rank as zero. It should rank neutral/worst or trigger bounded refresh before quota-driven auto-switch.

Validate:

- finite numeric percentages;
- range 0-100 with clamp or reject;
- missing primary/secondary windows as unknown, not zero.

### Tests

Add/update:

- `tests/codex-routing.test.ts`
- `tests/codex-auth-api.test.ts`
- `tests/ws-endpoint.test.ts`
- new or updated SSE-focused response stream tests for terminal failures.

Required cases:

- 400 does not fail over account;
- 404 or 422 caller/model errors do not penalize the account;
- 401 quarantines immediately;
- 403 credential-specific auth failure quarantines immediately;
- 429 records cooldown;
- 5xx, fetch rejection, connect error, and timeout count as transient where account-specific;
- 2xx + `response.failed` records terminal failure;
- 2xx + `response.incomplete` records terminal failure;
- malformed or unterminated stream records terminal failure;
- fresh quota ranks by observed usage;
- stale quota does not rank as fresh;
- unknown quota is not selected as lowest usage;
- error quota uses a conservative score or bounded probing policy;
- NaN, Infinity, and out-of-range quota headers rejected or clamped deterministically.

## Verification

```bash
bun test tests/codex-routing.test.ts tests/codex-auth-api.test.ts tests/ws-endpoint.test.ts
bun run typecheck
```
