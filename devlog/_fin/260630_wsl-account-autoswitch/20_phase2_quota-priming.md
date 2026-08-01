# 20 - Phase 2: Quota priming

Purpose: populate pool-account quota without requiring the user to open the
dashboard, so the rotation engine has real scores to compare instead of leaving
every account at the `100` unknown sentinel. This removes the precondition that
triggers the Phase 10 deadlock.

## Root cause recap (with file:line)

Quota is written from exactly two places today, neither of which runs on its own:

- Live upstream headers on the hot path: src/server.ts:497-512 reads
  `x-codex-*-used-percent` / `*-reset-at` and calls `updateAccountQuota`
  (src/server.ts:506). This only fires for an account that is already serving
  traffic, so an idle pool account never gets scored.
- WHAM usage fetches, but only from the dashboard endpoints:
  `fetchMainAccountInfo` (src/codex-auth-api.ts:186) and `fetchPoolAccountQuota`
  (src/codex-auth-api.ts:232), both reached only via
  `GET /api/codex-auth/accounts` (src/codex-auth-api.ts:271-292) and the
  reset-credit refresh (src/codex-auth-api.ts:453-456). A user who never opens
  the GUI never calls these.
- There is no startup or background priming. So on a fresh process every pool
  account scores `CODEX_UNKNOWN_USAGE_SCORE` (src/codex-quota.ts:27) via
  `getAccountQuota` returning null (src/codex-quota.ts:101) and
  `computeCodexUsageScore` (src/codex-routing.ts:80). On WSL, where the WHAM
  fetch may also be blocked, the dashboard does not even repair this.

## Proposed change (concrete, minimal)

Add a reusable priming helper in `src/codex-auth-api.ts` (it already owns
`fetchMainAccountInfo`, `fetchPoolAccountQuota`, `mapWithConcurrency`, and the
`POOL_QUOTA_REFRESH_CONCURRENCY` limit, src/codex-auth-api.ts:150,169-184), then
call it from startup and lazily before routing when the active is unknown.

1. New exported helper, single-flight + timeout-bounded:

```ts
let primeInFlight: Promise<void> | null = null;

export async function primeCodexPoolQuotas(config: OcxConfig, reason: string): Promise<void> {
  // Single-flight: concurrent callers (startup + first route) share one pass
  // instead of stampeding N WHAM fetches per caller.
  if (primeInFlight) return primeInFlight;
  primeInFlight = (async () => {
    const runtimeConfig = getRuntimeConfig(config);
    const pool = (runtimeConfig.codexAccounts ?? []).filter(a => !a.isMain);
    const stale = pool.filter(a => {
      const q = getAccountQuota(a.id);
      return !q || Date.now() - q.updatedAt >= POOL_CACHE_TTL;
    });
    try {
      await Promise.allSettled([
        getAccountQuota(MAIN_CODEX_ACCOUNT_ID) ? Promise.resolve() : fetchMainAccountInfo(false),
        mapWithConcurrency(stale, POOL_QUOTA_REFRESH_CONCURRENCY, async a => {
          if (!getCodexAccountCredential(a.id)) return;
          await fetchPoolAccountQuota(a.id, false, a.plan);
        }),
      ]);
    } catch {
      // Priming is best-effort; a blocked WSL network must not crash startup.
    }
    if (process.env.OPENCODEX_DEBUG_QUOTA === "1") {
      console.warn(`[codex-quota] prime done (reason=${reason}, pool=${pool.length}, refreshed=${stale.length})`);
    }
  })().finally(() => { primeInFlight = null; });
  return primeInFlight;
}
```

Notes:

- The per-fetch 8s timeout already exists inside `fetchMainAccountInfo`
  (src/codex-auth-api.ts:195) and `fetchPoolAccountQuota`
  (src/codex-auth-api.ts:241) via `AbortSignal.timeout(8000)`, so the helper
  inherits a bound without adding its own timer.
- The 5-minute `POOL_CACHE_TTL` (src/codex-auth-api.ts:149) is reused so priming
  skips accounts whose quota is already fresh; `forceRefresh=false` means a warm
  cache short-circuits inside `fetchPoolAccountQuota` (src/codex-auth-api.ts:234).
- `Promise.allSettled` keeps one blocked account from sinking the rest.

2. Startup call (fire-and-forget, never blocks the listener). In `startServer`
   (src/server.ts:1986), after the provider reconcile block and before/after the
   listen banner (src/server.ts:2304-2310), add:

```ts
import("./codex-auth-api")
  .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, "startup"))
  .catch(() => {});
```

   Using the same dynamic `import("./codex-auth-api")` pattern already used at
   src/server.ts:505 and src/server.ts:1968 keeps the existing module-load shape
   and avoids a new static import cycle (codex-auth-api re-exports quota; routing
   does not import the server).

3. Lazy pre-route prime when the active is unknown. In
   `resolveCodexAuthContext` (src/codex-auth-context.ts:73), before resolution,
   or right after a `selected` active that has no stored quota, kick the same
   helper fire-and-forget:

```ts
if (accountId && !getAccountQuota(accountId)) {
  import("./codex-auth-api")
    .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, "pre-route"))
    .catch(() => {});
}
```

   This does not block the current request (the first request still routes on
   stale/unknown data), but it ensures the next routing decision has real
   scores. Combined with the single-flight guard, repeated requests collapse to
   one prime pass.

## Open decision D2 (recommendation)

D2 (MOC): prime at startup for all pool accounts (cost: N WHAM calls on boot) or
lazily on first route when the active is unknown.

Recommendation: do both, gated by the single-flight guard, which makes the
"cost" question moot. Startup priming gives the common case (dashboard never
opened, but traffic flows) correct scores from the first routing decision; the
lazy pre-route prime is the safety net for accounts added after boot or when the
startup pass was blocked (WSL network not yet up). Because `primeInFlight`
coalesces concurrent callers and `POOL_CACHE_TTL` suppresses redundant refreshes,
the worst case is still one WHAM call per account per 5 minutes, not per request.

If jun wants to minimize boot-time network entirely (e.g. air-gapped installs),
make the startup call conditional on an env flag (default on) and keep the lazy
path unconditional. The startup pass would then no-op until the first route.

## Test plan (bun test, tests/codex-auth-api.test.ts or a new prime test)

Stub `fetch` (the existing tests already exercise `fetchPoolAccountQuota` shapes)
and assert against `getAccountQuota` / `listAccountQuotas`.

1. prime populates stale/unknown accounts: two pool accounts with credentials,
   no stored quota, `fetch` stubbed to return a WHAM payload. After
   `primeCodexPoolQuotas(config, "test")`, both have non-null `getAccountQuota`
   with the parsed percentages.
2. single-flight coalesces: count `fetch` calls while invoking
   `primeCodexPoolQuotas` twice without awaiting the first. Total upstream calls
   equal one pass (N), not 2N.
3. fresh cache is skipped: pre-seed `updateAccountQuota` with a recent
   `updatedAt`; prime makes zero `fetch` calls for that account (TTL guard).
4. credential-less accounts are skipped: a pool account with no stored
   credential triggers no `fetch` and stays unknown (matches the
   `getCodexAccountCredential` guard).
5. one blocked account does not sink the rest: stub one fetch to reject/timeout
   and another to resolve; the resolving account still gets quota
   (`Promise.allSettled` behavior).
6. integration with Phase 10: after priming yields real scores, a previously
   all-unknown set picks the truly-lowest account via the existing strict path
   (cross-checks that priming actually defuses the deadlock).

## Risks / non-goals

- Non-goal: no new background timer/interval in this phase. Priming is
  startup + lazy-on-unknown only; periodic refresh (if wanted) is a later phase.
- Non-goal: WSL network reachability diagnostics live in Phase 30; here we only
  make the failure non-fatal and best-effort.
- Risk: a blocked WHAM endpoint (WSL NAT/proxy, MOC root cause #2) means priming
  silently does nothing and accounts stay unknown. That is acceptable for this
  phase: Phase 10 still rotates among unknowns, and Phase 30 surfaces the
  reachability problem. The `OPENCODEX_DEBUG_QUOTA` warn is the breadcrumb.
- Risk: startup network at boot. Bounded by the existing 8s per-call timeout and
  fire-and-forget dispatch, so the listener is never delayed.
- Risk: import shape. Use the dynamic `import("./codex-auth-api")` already
  present at src/server.ts:505,1968 to avoid introducing a static cycle.

## Verification gate

- `bun x tsc --noEmit` -> exit 0.
- `bun test tests/codex-auth-api.test.ts` (plus any new prime test) -> pass.
- `bun run privacy:scan` -> clean (debug warn logs counts and a reason string,
  never emails or tokens; account-level WHAM responses stay inside the existing
  masked DTO path).
