# 070 — Audit round 2: four blockers, and the state-ownership design

Round 2 returned **FAIL, blockers=4**. Two were my failure to actually edit the canonical
documents (a supersession note is not an amendment), one was a genuine off-by-one I had
not seen, and one was a type-ownership cycle. Post-`bun install` the reviewer confirmed
`bun x tsc --noEmit` exit 0, `tests/provider-quota.test.ts` 107 pass, `privacy:scan`
exit 0.

## Blocker 1 — stored order is not ring order. FOLDED into `030` directly.

The counterexample is exact: roster `[A, B, C]`, `B` fails, no quota data.
`eligibleFailoverAccounts` returns `[A, C]` in **stored** order (`:143`), so ranking
that list identity-style picks `A` — while today's traversal, which starts after the
failed account (`:184`), picks `C`. My "byte-for-byte identical when no quota data"
claim was therefore false.

`030` now builds the ring explicitly before ranking
(`[...order.slice(start + 1), ...order.slice(0, start)]`), filters eligibility against it,
and ranks that. Accept criterion 9 is now this exact three-account counterexample, which
must fail before the fix and pass after.

## Blocker 3 — the false claims were still in 002/030/050. FOLDED by editing them.

Correct and fair. `060` announced the descopes but left the originals intact, so an
implementer reading `030` would still have built `markAccountObservedUsage`, and `050`
still instructed the final comparison to claim it. The canonical docs are now edited in
place:

- `002` — "before the request", "model-aware" and "live decrement" removed from the
  advantages list; a **Scope honesty** section states plainly that kiro-lb is ahead of us
  on pre-request selection and that we do not close its staleness gap.
- `030` — the `0.25` borrowed weight is gone, replaced by the categorical ordering; the
  live-decrement section is replaced by an explicit withdrawal.
- `050` — the comparison table drops the two false rows, adds a preflight row, and gains
  two rows in the "they are ahead" column (pre-request selection, restart persistence).

Also corrected: the claim that "Kiro's plan tier is visible from the limit value itself"
was wrong — `ProviderQuota` serializes percent and reset, never the absolute limit. The
sentence is removed from `060`; plan tier is simply out of scope for this unit.

## Blocker 2 — the usage-state map had no ownership. FOLDED with a real design.

The proposed module-private map would have been a hidden global: stale `exhausted` state
surviving an account removal could hand a *replacement* account a 24-hour cooldown it never
earned, and a late probe could republish state after a config generation change. The
existing quota cache solved exactly this with three mechanisms
(`mayCommitAccountQuotaKey` at `:1438`, `reconcileProviderAccountQuotaRows` at
`:1495`, `clearAccountQuotaCache` at `:1522`) and every logout/removal path already
calls the last one.

**Design:** do not build a parallel store. `kiroAccountUsageState` becomes a
`Map<providerNulAccountId, { exhausted: boolean; nextResetAt?: number; ts: number }>`
living in `src/providers/kiro-usage.ts` and wired into the same three seams:

1. **Keyed identically** to the quota cache (`\`\${provider}\\u0000\${accountId}\``), which
   also fixes the reviewer's sub-point that `KiroUsageContext` carried no account id —
   the context gains `accountId`.
2. **Written only after the quota owner's commit guard passes.** The write happens inside
   `fetchAccountQuota`'s existing `mayCommitAccountQuotaKey(key, writerGeneration)`
   branch, so a late probe from a superseded generation cannot commit usage state either.
3. **Cleared and reconciled with the quota rows.** `clearAccountQuotaCache(provider)`
   clears the matching usage-state keys, and `reconcileProviderAccountQuotaRows` drops
   usage-state keys absent from `context.oauthAccountKeys`. Both are single added lines in
   functions that already do this for quota; no new registration in
   `src/lib/state-store-registrations.ts` is required because the owner is already
   registered there (`reconcileProviderAccountQuotaRows`).
4. **Consumed** by `030`'s cooldown seeder through one exported reader,
   `getKiroAccountExhaustion(provider, accountId)`. Generic failover imports that reader;
   it does not reach into the map.

### Freshness (added in round 3)

Storing `ts` without a staleness rule would let an old `exhausted` verdict keep an
account last-ranked, or re-seed a 24-hour cooldown, long after its quota actually reset.
`getKiroAccountExhaustion` therefore returns **unknown** — not `exhausted` — when
either holds:

- `now - entry.ts >= ACCOUNT_QUOTA_TTL_MS` (the existing per-account TTL, which is
  **10 minutes** at `src/providers/quota.ts:1425`, not 5 — the 5-minute figure is the
  provider-level cache at `:37`). That constant is currently module-private to
  `quota.ts`, and `kiro-usage.ts` cannot import it back without recreating the cycle
  `010` just removed, so the phase-1 extraction **also moves `ACCOUNT_QUOTA_TTL_MS` and
  `CACHE_TTL_MS` into `quota-wire.ts`**, imported by both. Duplicating `10 * 60_000`
  would put the same number in two files, which is exactly how the two drift apart; or
- `entry.nextResetAt !== undefined && entry.nextResetAt <= now` — the window the account
  was exhausted in has already rolled over.

Unknown means the account sorts in the middle bucket and gets a normal 60-second cooldown,
so the failure mode of stale data is "try it again", not "park it for a day". Tests drive
both expiry paths with a fake clock.

Two more accept criteria for `020`:

| # | Scenario | Observable proof |
| --- | --- | --- |
| 13 | Entry older than the 10-minute account TTL | reader returns unknown, not exhausted |
| 14 | `nextResetAt` already passed | reader returns unknown; cooldown reverts to the 60s default |

New accept criteria for `020`:

| # | Scenario | Observable proof |
| --- | --- | --- |
| 9 | Account removed, then a stale probe resolves | no usage-state row for the removed id |
| 10 | `clearAccountQuotaCache("kiro")` | usage-state rows for kiro are gone too |
| 11 | Probe resolves after a generation bump | neither quota nor usage state commits |

## Blocker 4 — type-level ownership cycle. FOLDED.

`quota.ts` would import `kiro-usage.ts` for the fetcher while `kiro-usage.ts` imports
`ProviderQuota` back from `quota.ts`. Type-only, so it would not break at runtime, but it
is still a cycle and the reviewer is right that the fix is cheap.

**Amendment to `010`:** the phase-1 extraction produces **two** modules, not one:

- `src/providers/quota-types.ts` — `ProviderQuota`, `ProviderQuotaWindow`,
  `ProviderQuotaCreditsUsd` (the real exported name, `src/providers/quota.ts:84`),
  `ProviderQuotaReport`. Pure types, imports nothing from `quota.ts`.
- `src/providers/quota-wire.ts` — `REQUEST_TIMEOUT_MS`, `normalizePercent`,
  `normalizeResetAt`, `toFiniteNumber`, `asRecord`, `readQuotaJson`. Depends only on
  `lib/bounded-body` and pure helpers.

Both `quota.ts` and `kiro-usage.ts` import from these; the edge between them becomes
one-directional. `tests/provider-quota.test.ts` (107 pass today) is the proof the move is
inert, and `tests/core-lab-boundary.test.ts` confirms no Lab reachability is introduced.

## Round 2 disposition

All four folded, none rebutted. The two documentation blockers were fair hits on my
process: I wrote a supersession note instead of amending the source, which is exactly the
failure mode that lets a stale plan get implemented.
