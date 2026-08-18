# 050 — #1791: keep every quota window, not two named ones

## Verified defect

Upstream sends three fixed slots, each a `WhamUsageWindow` with `used_percent`, `reset_at`, `limit_window_seconds` (`src/codex/quota.ts:38`).

Storage is not window-generic:

```ts
type StoredAccountQuota = {
  weeklyPercent?: number; monthlyPercent?: number;
  weeklyResetAt?: number; monthlyResetAt?: number;
  resetCredits?: number; monthlyIsPrimaryWindow?: boolean; updatedAt: number;
}
```

(`src/codex/quota.ts:7`, persisted as `{ version: 1, quotas }` at `:24`, `:357`, `:377`.)

`parseUsageQuota()` folds a non-monthly primary into `weekly` and treats secondary only as a fallback (`:439`, `:468`). A K12 account with a 5-hour primary and a 7-day secondary therefore reports the 5-hour window AS the weekly one, and the real weekly window disappears.

## Fix

Store windows as an array, but keep the PROVENANCE the current shape encodes. A duration-only array silently discards `monthlyIsPrimaryWindow`, and that flag is load-bearing: it distinguishes the governing window from a supplementary one, so dropping it risks both false cooldown recovery and treating a supplementary tertiary window as account exhaustion.

```ts
type StoredQuotaWindow = {
  /** Upstream slot the window arrived in — the provenance the old flag encoded. */
  slot: "primary" | "secondary" | "tertiary";
  /**
   * The real discriminator: 5h, 7d, 30d. OPTIONAL, because older WHAM responses omit
   * `limit_window_seconds` entirely (`src/codex/quota.ts:55`, and the note at `:463`).
   * When absent, the slot is the only provenance we have and band lookup must fall back
   * to it rather than inventing a duration.
   */
  limitWindowSeconds?: number;
  usedPercent: number;
  resetAt?: number;
  /** True for the window that governs admission, preserving monthlyIsPrimaryWindow's meaning. */
  governing: boolean;
};
type StoredAccountQuota = {
  windows: StoredQuotaWindow[];
  resetCredits?: number;
  updatedAt: number;
};
```

Persist as `version: 2`. Hydration must accept BOTH: a `version: 1` document is upgraded in memory by mapping `weekly*` and `monthly*` onto synthetic windows (7d / 30d), so an existing install does not lose its quota state on upgrade. Writing always emits v2.

Exhaustion becomes "any governing window at limit", not "the weekly one", which is the behavior `#1791` asks for.

### This is a field-chain migration, not a type edit

`StoredAccountQuota` fields are read well beyond `quota.ts`. Before writing code, enumerate and update every consumer — at minimum `src/codex/quota.ts`, `src/codex/auth-api.ts`, `src/codex/routing.ts`, the CLI DTOs, the main-account cache, and capacity projection. Each site that reads `weeklyPercent`/`monthlyPercent`/`weeklyResetAt`/`monthlyResetAt`/`monthlyIsPrimaryWindow` today must move to the accessor below or be listed here with a reason it does not.

Consumers keep working through small accessors that select by duration band (falling back to slot when the duration is absent) and by `governing`, rather than by stored name.

Exhaustion is "a GOVERNING window at limit", not "any window at limit" — the latter would let a supplementary tertiary window take an account out of rotation, which is a new bug wearing the fix's clothes.

**Multiple windows can govern simultaneously.** #1791's own case is exactly that: a 5-hour and a weekly window are both upstream-enforced, and hitting either genuinely blocks the account. So `governing` is a per-window boolean rather than a single winner, the accessor is plural, and exhaustion is `windows.some(w => w.governing && atLimit(w))`:

```ts
function governingWindows(q: StoredAccountQuota): StoredQuotaWindow[];
function windowByBand(q: StoredAccountQuota, band: "short" | "weekly" | "monthly"): StoredQuotaWindow | undefined;
```

Cooldown recovery then uses the EARLIEST reset among governing windows that are at limit — the account becomes usable again when the first blocking window rolls over, not when the last one does.

## Tests

- K12 payload: 5-hour primary + 7-day secondary produces two windows with independent reset times, and the weekly one is genuinely the 7-day.
- v1 document on disk hydrates without loss (including `monthlyIsPrimaryWindow` becoming `governing`) and re-persists as v2; a v2 document round-trips unchanged.
- Any governing window at 100% marks the account exhausted; a supplementary window at 100% does NOT.
- With two governing windows at limit, recovery uses the earliest reset among them.
- A v1 document and a live payload that both omit `limit_window_seconds` still classify by slot without inventing a duration.
- Dashboard, CLI and routing consumers return the same values they used to for an ordinary two-window account. The existing quota, recovery, API and CLI tests must pass unchanged where behavior is unchanged.
