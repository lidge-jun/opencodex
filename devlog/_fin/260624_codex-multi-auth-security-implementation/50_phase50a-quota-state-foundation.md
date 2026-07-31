# 50 - Phase 50A Plan: Quota Unknown-State And Percent Validation

Date: 2026-06-24

Status: implemented and locally verified.

## Objective

Implement the quota-state foundation from Patch 5 in `devlog/280_codex-multi-auth-security-patch-plan/00_patch_plan.md`:

- stop treating unknown quota as zero usage;
- stop converting missing WHAM quota windows into `0%`;
- reject/clamp malformed quota percentages from WHAM responses and upstream headers;
- keep the Codex Auth UI stable when one quota window is unknown;
- leave the larger HTTP/SSE/WS outcome taxonomy for the next Patch 5 slice.

This phase is intentionally narrow. It changes quota storage/scoring semantics, not the full account health classifier.

## Security Basis

Unknown usage is not free usage. If a pool account has no reliable quota observation, routing must not prefer it over an account with known low usage. Malformed headers must also not poison routing with `NaN`, `Infinity`, negative values, or values over 100.

Standards checked:

- RFC 9110 HTTP Semantics: status classes distinguish client and server error classes, which will matter in the next outcome-taxonomy slice. This phase only prepares quota correctness.

## Acceptance Criteria

- `computeCodexUsageScore(null)` returns a conservative unknown score, not `0`.
- Empty/unknown quota objects also score conservatively.
- Auto-switch can move away from an active account with unknown quota when another eligible account has known lower usage.
- Unknown quota does not beat known low usage during lowest-usage selection/failover.
- `parseUsageQuota()`:
  - returns `null` when no valid quota window is present;
  - does not fabricate `weeklyPercent: 0` or `fiveHourPercent: 0` from missing windows;
  - clamps valid finite percentages into `0..100`;
  - drops `NaN`, `Infinity`, non-number, and otherwise invalid percentages.
- `updateAccountQuota()` normalizes inputs and ignores invalid-only updates instead of storing poisoned quota.
- Server passthrough quota capture no longer calls `parseFloat()` directly on quota headers; raw header values go through the quota normalizer.
- GUI quota rows render only known windows, so optional `fiveHourPercent` / `weeklyPercent` values do not produce `NaN%` or broken bars.
- Existing 5h, weekly, and 30d display behavior remains when those values are known.

## File Plan

### MODIFY `src/codex-quota.ts`

Change quota types:

```ts
export type StoredAccountQuota = {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  monthlyResetAt?: number;
  updatedAt: number;
};
```

Add helpers:

```ts
export const CODEX_UNKNOWN_USAGE_SCORE = 100;

export function normalizeUsagePercent(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(100, numeric));
}

function normalizeResetAt(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric;
}

function hasKnownQuotaValue(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return [quota.weeklyPercent, quota.fiveHourPercent, quota.monthlyPercent]
    .some(value => typeof value === "number" && Number.isFinite(value));
}
```

Change `updateAccountQuota()` signature to accept `unknown` input values:

```ts
export function updateAccountQuota(
  accountId: string,
  weekly: unknown,
  fiveHour: unknown,
  weeklyResetAt?: unknown,
  fiveHourResetAt?: unknown,
  monthly?: unknown,
  monthlyResetAt?: unknown,
): void
```

Rules:

- normalize weekly/five-hour/monthly percentages;
- if no valid new percentage exists, return without changing the map;
- preserve existing known percentage/reset values for windows omitted in the new observation;
- update `updatedAt` only when at least one valid percentage exists.

Change `parseUsageQuota()`:

- use `normalizeUsagePercent()` and `normalizeResetAt()`;
- build an object only with valid windows;
- return `null` when no valid percentage exists.

### MODIFY `src/codex-routing.ts`

Import `CODEX_UNKNOWN_USAGE_SCORE`:

```ts
import { CODEX_UNKNOWN_USAGE_SCORE, getAccountQuota } from "./codex-quota";
```

Change `computeCodexUsageScore()` input type to optional quota fields:

```ts
export function computeCodexUsageScore(quota: {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  monthlyPercent?: number;
} | null): number
```

Rules:

- `null` or no finite values => `CODEX_UNKNOWN_USAGE_SCORE`;
- otherwise max of known finite windows.

Change `applyQuotaAutoSwitch()`:

- remove the early `if (!quota) return active`;
- compute active usage with `computeCodexUsageScore(quota)`;
- threshold comparison remains unchanged, so unknown (`100`) can trigger a switch to a known lower-usage account when auto-switch is enabled.

### MODIFY `src/server.ts`

In the passthrough quota capture block:

- stop using `parseFloat(weeklyRaw ?? "0")` and friends;
- pass raw header strings or `undefined` directly to `updateAccountQuota()`.

Before:

```ts
updateAccountQuota(
  authCtx.accountId,
  parseFloat(weeklyRaw ?? "0"),
  parseFloat(fiveHourRaw ?? "0"),
  weeklyResetRaw ? parseFloat(weeklyResetRaw) : undefined,
  ...
);
```

After:

```ts
updateAccountQuota(
  authCtx.accountId,
  weeklyRaw,
  fiveHourRaw,
  weeklyResetRaw,
  fiveHourResetRaw,
  monthlyRaw,
  monthlyResetRaw,
);
```

The normalizer in `src/codex-quota.ts` owns validation and clamping.

### MODIFY `src/codex-auth-api.ts`

Change cache return types from `{ weeklyPercent: number; fiveHourPercent: number }` to `Omit<StoredAccountQuota, "updatedAt">`.

No route shape change beyond optional percent fields:

- GET `/api/codex-auth/accounts` still returns `quota: null` when unknown.
- When only one window is known, return only that window and `updatedAt`.
- Existing calls to `updateAccountQuota()` remain valid because its inputs accept `unknown`.

### MODIFY `gui/src/pages/CodexAuth.tsx`

Change `AccountQuota`:

```ts
weeklyPercent?: number;
fiveHourPercent?: number;
```

Change `QuotaBars()`:

- render `5h` row only when `typeof quota.fiveHourPercent === "number"`;
- render `Week` row only when `typeof quota.weeklyPercent === "number"`;
- render `30d` row only when `typeof quota.monthlyPercent === "number"`;
- if no known windows exist, return `null`.

`QuotaRow` remains strict `percent: number`.

### MODIFY `tests/codex-routing.test.ts`

Add tests:

- `computeCodexUsageScore(null)` equals `CODEX_UNKNOWN_USAGE_SCORE`;
- `computeCodexUsageScore({})` equals `CODEX_UNKNOWN_USAGE_SCORE`;
- known windows still use the max known percentage;
- active unknown quota auto-switches to another eligible account with known low usage;
- unknown quota does not beat known low quota in failover/lowest-usage selection;
- `parseUsageQuota({ rate_limit: {} })` returns `null`;
- missing weekly/five-hour windows are not fabricated as `0`;
- invalid percentages are dropped and out-of-range finite values are clamped.

### MODIFY `tests/codex-auth-api.test.ts`

Add or adjust tests:

- `updateAccountQuota()` clamps finite values into `0..100`;
- invalid-only updates do not create quota records;
- invalid later updates do not overwrite existing valid quota;
- existing account-list quota tests still assert known weekly/five-hour values where fixture provides them.

### OPTIONAL MODIFY `tests/gui-source.test.ts`

Only if a GUI source test exists. It does not exist today.

## Verification Plan

Focused:

```bash
bun test tests/codex-routing.test.ts tests/codex-auth-api.test.ts
```

Full:

```bash
bun run typecheck
bun test tests
cd gui && bun run build
git diff --check
```

Independent verification:

- dispatch a read-only Backend verifier to confirm unknown quota no longer ranks as zero, malformed quota values cannot poison routing, and GUI optional quota rows remain build-safe.

## Implementation Evidence

Changed files:

- `src/codex-quota.ts`
  - Made 5h/weekly/monthly quota windows optional.
  - Added `CODEX_UNKNOWN_USAGE_SCORE`.
  - Added quota percent/reset normalization.
  - `updateAccountQuota()` now ignores invalid-only updates, clamps finite percentages, preserves existing known values for omitted windows, and only attaches reset times for valid percent windows.
  - `parseUsageQuota()` no longer fabricates missing 5h/weekly windows as `0`.
- `src/codex-routing.ts`
  - `computeCodexUsageScore(null)` and empty quota now return conservative unknown score.
  - Auto-switch can evaluate active accounts with no quota record, allowing a known lower-usage account to be selected.
- `src/server.ts`
  - Passthrough quota header capture now passes raw header strings into `updateAccountQuota()` instead of `parseFloat(... ?? "0")`.
- `src/codex-auth-api.ts`
  - Main account quota cache type widened to `Omit<StoredAccountQuota, "updatedAt"> | null`.
- `gui/src/pages/CodexAuth.tsx`
  - Quota percent fields are optional.
  - Quota rows render only for known windows; no known rows returns `null`, preventing `NaN%` rendering.
- `tests/codex-routing.test.ts`
  - Added unknown score, unknown active switch, known-low selection, missing-window, invalid-window, and clamping coverage.
- `tests/codex-auth-api.test.ts`
  - Added `updateAccountQuota()` clamp/invalid-only/preserve-valid coverage.

## Verification Evidence

Local commands run on 2026-06-24:

```text
bun test tests/codex-routing.test.ts tests/codex-auth-api.test.ts
56 pass, 0 fail

bun run typecheck
exit 0

bun test tests
298 pass, 0 fail

cd gui && bun run build
exit 0

git diff --check
exit 0
```

Independent read-only verifier:

```text
Backend verifier verdict: DONE

Confirmed:
- Optional quota windows and safe normalization are implemented.
- Invalid-only updates do not create or overwrite quota records.
- Null/empty quota scores conservatively instead of zero.
- Raw x-codex quota headers no longer use parseFloat/default-zero parsing in server.ts.
- GUI renders only known quota windows and cannot render NaN percent rows for unknown windows.
- Focused tests, typecheck, full tests, GUI build, and git diff --check passed.
- No full HTTP/SSE/WS outcome taxonomy was claimed or implemented in this slice.
```

## Out Of Scope

- full status taxonomy for 400/401/403/429/5xx/network failures;
- immediate 401 quarantine behavior beyond current `markAccountNeedsReauth()`;
- Retry-After/cooldown storage for 429;
- post-stream SSE/WS `response.failed` / `response.incomplete` health recording;
- quota stale/error freshness markers and bounded pre-routing live refresh;
- thread-affinity TTL/LRU.
