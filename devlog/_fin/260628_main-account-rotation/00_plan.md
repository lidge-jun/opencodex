# 00 — Main Codex account as first-class rotation member (Option A)

Date: 2026-06-28
Class: **C4** (auth/credential + routing surface) → full PABCD + THOROUGH verification.

## Part 1 — Plain explanation

Today the "main" Codex account (the one the Codex CLI itself is logged into, stored in
`~/.codex/auth.json`) is **excluded** from opencodex's automatic account rotation. The
rotation engine only ever picks from pool accounts; the main account is a passthrough
fallback that the proxy never load-balances, quota-tracks, fails over, or cools down.

This change makes the main account a **first-class rotation member**, treated like any
pool account for: quota-based auto-switch, failure failover, cooldown, quota tracking,
and upstream-token injection — **without** importing its credentials into opencodex's
managed store. The main account keeps `~/.codex/auth.json` as its read-only credential
source (Option A). The Codex CLI login stays separate; if the main token is expired the
account is treated as "needs re-login via Codex CLI" (excluded from rotation, surfaced as
a reauth error) rather than refreshed by opencodex.

Identity: the main account participates under the stable id `__main__` (already used by
the reset-credit + accounts-list APIs).

### Accepted behaviors / non-goals
- **No sticky thread-affinity for main.** `bindThreadAffinity` requires a managed
  credential record, which main lacks; main re-resolves per request via active/auto-switch.
  Functionally correct, just not session-pinned. Out of scope to add.
- **No opencodex-side refresh of the main token.** Expiry → reauth notice (Option A).
- Main is **not** imported into the managed store; `checkAccountIdCollision` stays as-is
  (still blocks importing the main login as a pool account).

## Part 2 — Diff-level plan

### NEW — `src/codex-main-account.ts`
Centralizes the main-account id + read-only credential/usability/plan helpers. Avoids
import cycles (imports only `codex-auth-collision`, `oauth/chatgpt`; nothing imports back).

```ts
import { readCodexTokens } from "./codex-auth-collision";
import { decodeJwtPayload } from "./oauth/chatgpt";

export const MAIN_CODEX_ACCOUNT_ID = "__main__";

let mainAccountPlan: string | null = null;
export function setMainAccountPlan(plan: string | null): void { mainAccountPlan = plan; }
export function getMainAccountPlan(): string | undefined { return mainAccountPlan ?? undefined; }

export function getMainAccountToken(): { accessToken: string; chatgptAccountId: string } | null {
  const t = readCodexTokens();
  if (!t?.access_token) return null;
  return { accessToken: t.access_token, chatgptAccountId: t.account_id };
}

/** Main token is usable when present and (if a JWT exp is decodable) not expired. */
export function isMainAccountTokenLive(now = Date.now()): boolean {
  const t = readCodexTokens();
  if (!t?.access_token) return false;
  const payload = decodeJwtPayload(t.access_token);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  return exp === undefined || exp > now;
}
```

### MODIFY — `src/codex-account-usability.ts`
Main is usable when its token is live (instead of requiring a managed credential).

```ts
// + import
import { MAIN_CODEX_ACCOUNT_ID, isMainAccountTokenLive } from "./codex-main-account";

export function isCodexAccountUsable(config: OcxConfig, accountId: string): boolean {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    return isMainAccountTokenLive() && !isAccountNeedsReauth(accountId);
  }
  const exists = (config.codexAccounts ?? []).some(account => !account.isMain && account.id === accountId);
  if (!exists) return false;
  if (isAccountNeedsReauth(accountId)) return false;
  return !!getCodexAccountCredential(accountId);
}
```

### MODIFY — `src/codex-routing.ts`
Make main a selectable candidate, give it a plan, and let it count as "configured".

```ts
// + import
import { MAIN_CODEX_ACCOUNT_ID, getMainAccountPlan } from "./codex-main-account";

// hasConfiguredPoolAccount (L45)
function hasConfiguredPoolAccount(config: OcxConfig, accountId: string): boolean {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return isCodexAccountUsable(config, accountId);
  return (config.codexAccounts ?? []).some(account => !account.isMain && account.id === accountId);
}

// getEligiblePoolAccounts (L205) — prepend main when eligible
function getEligiblePoolAccounts(config, excludeId?, now = Date.now()): string[] {
  const ids = (config.codexAccounts ?? [])
    .filter(account => !account.isMain && account.id !== excludeId && !isAccountNeedsReauth(account.id))
    .filter(account => !isCodexAccountInCooldown(account.id, now))
    .filter(account => isCodexAccountUsable(config, account.id))
    .map(account => account.id);
  if (
    excludeId !== MAIN_CODEX_ACCOUNT_ID
    && !isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)
    && !isCodexAccountInCooldown(MAIN_CODEX_ACCOUNT_ID, now)
    && isCodexAccountUsable(config, MAIN_CODEX_ACCOUNT_ID)
  ) {
    ids.unshift(MAIN_CODEX_ACCOUNT_ID);
  }
  return ids;
}

// getPoolAccountPlan (L213)
function getPoolAccountPlan(config, accountId): string | undefined {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return getMainAccountPlan();
  return (config.codexAccounts ?? []).find(account => !account.isMain && account.id === accountId)?.plan;
}
```
Note: cooldown (`upstreamHealth` / `getCodexAccountCooldownUntil`) and needs-reauth are
keyed by id string → `__main__` works with no further change. `recordCodexUpstreamOutcome`
already keys by accountId.

### MODIFY — `src/codex-auth-context.ts`
New injected variant for main; inject headers + apply provider override + usability + cooldown.

```ts
// + import
import { MAIN_CODEX_ACCOUNT_ID, getMainAccountToken } from "./codex-main-account";

export type CodexAuthContext =
  | { kind: "main"; accountId: null }                                  // passthrough fallback (legacy single-account)
  | { kind: "pool"; accountId: string; generation: number; accessToken: string; chatgptAccountId: string }
  | { kind: "main-pool"; accountId: string; accessToken: string; chatgptAccountId: string }; // main, rotation-injected

// resolveCodexAuthContext — after computing accountId, before getValidCodexToken:
if (accountId === MAIN_CODEX_ACCOUNT_ID) {
  const token = getMainAccountToken();
  if (!token) return { kind: "main", accountId: null }; // token gone → passthrough
  return { kind: "main-pool", accountId, accessToken: token.accessToken, chatgptAccountId: token.chatgptAccountId };
}

// headersForCodexAuthContext
if (ctx.kind === "pool" || ctx.kind === "main-pool") {
  selected.set("authorization", `Bearer ${ctx.accessToken}`);
  selected.set("chatgpt-account-id", ctx.chatgptAccountId);
}

// applyCodexAuthContextToProvider
if ((ctx.kind !== "pool" && ctx.kind !== "main-pool") || provider.authMode !== "forward") return provider;

// isCodexAuthContextUsable
if (ctx.kind === "main") return true;
if (ctx.kind === "main-pool") return isCodexAccountUsable(config, ctx.accountId);
return isCodexAccountUsable(config, ctx.accountId) && isCodexAccountGenerationLive(ctx.accountId, ctx.generation);

// assertCodexAuthContextNotCooled — also guard main-pool
if (ctx?.kind !== "pool" && ctx?.kind !== "main-pool") return;
const cooldownUntil = getCodexAccountCooldownUntil(ctx.accountId);
if (cooldownUntil) throw new CodexAccountCooldownError(ctx.accountId, cooldownUntil);
```

### MODIFY — `src/server.ts`
Record upstream outcomes for main-pool too (currently pool-only). Generalize the three sites.

```ts
// sidecarOutcomeRecorder
return (authCtx.kind === "pool" || authCtx.kind === "main-pool")
  ? outcome => recordCodexUpstreamOutcome(config, authCtx.accountId, outcome)
  : undefined;

// usesCodexForwardPoolAuth — widen guard to include main-pool
function usesCodexForwardPoolAuth(
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
): authCtx is Extract<CodexAuthContext, { kind: "pool" | "main-pool" }> {
  return (authCtx.kind === "pool" || authCtx.kind === "main-pool")
    && provider.authMode === "forward" && provider.adapter === "openai-responses";
}
```
The two `recordCodexUpstreamOutcome(config, authCtx.accountId, ...)` call sites already
sit behind `usesCodexForwardPoolAuth(...)` / the recorder, so they cover main-pool once the
guard widens. `authCtx.accountId` is a string for both pool and main-pool.

### MODIFY — `src/codex-auth-api.ts`
1. Persist main quota + plan so rotation can read them (currently only an in-memory DTO cache).
   In `fetchMainAccountInfo`, after computing `result`:
```ts
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "./codex-main-account";
// ...
setMainAccountPlan(result.plan);
if (result.quota) {
  updateAccountQuota(
    MAIN_CODEX_ACCOUNT_ID,
    result.quota.weeklyPercent, result.quota.fiveHourPercent,
    result.quota.weeklyResetAt, result.quota.fiveHourResetAt,
    result.quota.monthlyPercent, result.quota.monthlyResetAt,
    result.quota.resetCredits,
  );
}
```
   (`updateAccountQuota` is already imported in this file.)
2. `PUT /api/codex-auth/active` — accept `__main__` as a valid active id:
```ts
if (body.accountId != null && body.accountId !== MAIN_CODEX_ACCOUNT_ID) {
  const exists = (runtimeConfig.codexAccounts ?? []).some(a => a.id === body.accountId);
  if (!exists) return jsonResponse({ error: "Account not found" }, 400);
}
```

### NEW/EXTEND — tests
Mirror existing `src/*.test.ts` Bun test style (located in B). Cases:
- `codex-account-usability`: main usable when token live; unusable when token absent / needsReauth.
- `codex-routing`: main appears in eligible pool & can be picked by `pickLowestUsageCodexAccount`
  when lowest usage; excluded on cooldown / needsReauth / missing token; respects `excludeId`.
- `codex-auth-context`: active `__main__` + tokens → `main-pool` with injected auth headers;
  tokens absent → falls back to `kind:"main"` passthrough; cooldown on `__main__` throws.
- `codex-auth-api`: `PUT /active` accepts `__main__`.

## Verification (THOROUGH — security/auth)
- `bun test` full suite (or affected `codex-*` suites) green, including new tests.
- `bunx tsc --noEmit` (or repo typecheck script) clean.
- Independent employee audit of plan (A) and build (B).

## Risk register
| Risk | Mitigation |
|------|------------|
| Main JWT not decodable / no `exp` | `isMainAccountTokenLive` treats undecodable exp as live (best-effort); upstream 401 → cooldown via outcome recorder |
| Expired main token injected | usability gate excludes; `isCodexAuthContextUsable(main-pool)` false → 401 reauth message |
| Import cycle from new module | new module imports only collision + oauth/chatgpt; verified no back-edges |
| Outcome double-record | guards unchanged in structure, only widened; single record per site preserved |
| Main quota stale at rotation time | populated on accounts-API list (5-min cache) like pool; acceptable parity with pool |

## Plan amendments (post-audit, 2026-06-28)

Backend audit (employee Backend) returned **PASS** for core items 1–6, but found missed
integration points. Folded in:

### MODIFY — `src/codex-websocket-registry.ts` (audit item 1, Medium)
`trackedAccountId` (L8) tracks only `kind === "pool"`. Widen so `main-pool` sockets register
under `__main__` (parity for `updateCodexWebSocketAuthContext` / per-account socket counts):
```ts
return (ctx?.kind === "pool" || ctx?.kind === "main-pool") ? ctx.accountId : null;
```

### MODIFY — `src/codex-routing.ts` `formatCodexProviderForLog` (audit item 3, Low)
`__main__` currently logs as the bare provider name. Add a branch:
```ts
import { MAIN_CODEX_ACCOUNT_ID } from "./codex-main-account";
export function formatCodexProviderForLog(providerName, accountId, config): string {
  if (!accountId) return providerName;
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return `${providerName}-main`;
  const account = (config.codexAccounts ?? []).find(a => !a.isMain && a.id === accountId);
  return account ? `${providerName}-${codexAccountLogLabel(account)}` : providerName;
}
```

### MODIFY — `src/server.ts` log-label account id (audit item 2, Low)
The `formatCodexProviderForLog(...)` calls pass `authCtx.kind === "pool" ? authCtx.accountId : null`
(L392, L402, ~L1934, ~L2116). Replace that inline ternary with a small helper so `main-pool`
also surfaces its id:
```ts
function codexLogAccountId(authCtx: CodexAuthContext): string | null {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool" ? authCtx.accountId : null;
}
```

### GUI contract decision (audit items 4 & 5) — `gui/src/pages/CodexAuth.tsx`
**Decision:** make the manual "use main" path a true rotation member.
- Today: clicking the main card sends `setActive(null)`; `activeId === null` = main = passthrough,
  and the engine does **no** rotation while on main (`resolveCodexAccountForThreadDetailed`
  returns `none` → passthrough).
- Change: clicking the main card sends `"__main__"` (not `null`). Backend then treats main as a
  managed, injected, rotatable member. `null`/undefined stays the safe passthrough default for
  users who never selected an account.
- Highlight/badge: treat `activeId === "__main__" || !activeId` as "main is next/current" so
  legacy `null` configs still render correctly (backward compatible).
- `setActive` toast label: `id && id !== "__main__" ? <email> : "main"`.

Concretely in CodexAuth.tsx:
- confirm-modal primary button: `onClick={() => setActive(confirm.id === "__main__" ? "__main__" : confirm.id)}`
- main card `card-active` + NEXT/CURRENT badge: gate on `(!activeId || activeId === "__main__")`
- `isMainActive` helper to replace bare `!activeId` checks for the main card.

### Tests addendum
- `codex-websocket-registry`: a `main-pool` authContext registers/unregisters under `__main__`.
- (GUI) keep change minimal; covered by existing GUI test harness + tsc. Add a unit test only
  if a routing helper is extracted.
