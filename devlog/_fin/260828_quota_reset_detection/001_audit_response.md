# A-phase audit response

Two dispatched grok-4.6 auditors did not return: the first errored with
`Selected model is at capacity`, the second went silent through three bounded wait cycles
and was retired under DISPATCH-RETIRE-01. The audit below was performed directly against
the tree at `c752929d7`. Stating that plainly because a claimed-but-absent reviewer is the
one failure mode the A gate exists to catch.

## Citation audit — PASS

All 33 cited `path:line` claims were read back and match. Sample:
`src/codex/quota.ts:274` is `const existing = accountQuota.get(accountId);`;
`src/providers/quota.ts:2290` is the `previous` binding; `:2343` is the `cache = {...}`
commit; `src/config.ts:3161` is `SALVAGEABLE_CONFIG_SECTIONS`.

## Verifier reality — PASS

`bun install` then `bun x tsc --noEmit` exits 0 with no output;
`bun test tests/codex-quota-parser-parity.test.ts` reports 8 pass / 0 fail.
`bunfig.toml` pins `[test] root = "tests"` and preloads `./tests/preload.ts`, which is why
a bare `bun test` in a fresh worktree reports one spurious error until `bun install` runs.
That belongs in the plan and is now recorded there.

## Field chain — PASS

`rg -n "agentTaskRecovery" src/ gui/src` outside `src/config.ts` returns nothing, and
`tokenGuardian` has only its type declaration plus one comment. There is no config DTO,
no sanitize path, and no docs generator enumerating sections, so `config.ts` +
`types/config.ts` really is the whole chain for an optional section. No missed consumer.

## Reachability — PASS with one correction

- A percent DROP does land: `snapshotHasWeekly` (`src/codex/quota.ts:246`) tests
  `weeklyPercent !== undefined`, so a lower value takes the `:294` branch and is written.
  The merge only carries values FORWARD when the incoming snapshot omits a window.
- The poller keeps its own commit authority. `invalidationEpoch += 1` happens at `:2285`,
  then `const epoch = invalidationEpoch;` at `:2286` captures the bumped value, so the
  `epoch === invalidationEpoch` check at `:2338` passes for the forced probe itself. My
  concern that a forced refresh would lose its own commit was wrong.
- `previous` is non-empty on a poller refresh as long as the cache key is unchanged; the
  `:2309` comment only resets it when the provider SET changes, which is a config edit.

## Blockers folded into the plan

### 1. HIGH — the boundary claim was unverifiable

`tests/core-lab-boundary.test.ts:63` tests `next.includes("/src/lab/")`. The guard is
hardcoded to Lab and says nothing about `src/quota/`, so wp5's "verify by hand" was the
only thing standing behind the claim — exactly the situation AGENTS.md describes as "this
paragraph was the only thing holding the guarantee".

Fix, folded into `040`: wp5 adds a real guard asserting no static runtime edge reaches
`src/quota/reset-` from the four protected entrypoints, reusing the same walker.

### 2. MEDIUM — `src/server/management-api.ts` is itself protected

It is the fourth entry in `PROTECTED` (`tests/core-lab-boundary.test.ts:25`), added because
eagerly importing handlers put ~70 modules on every dashboard request. The wp4 route must
therefore be lazy for a second, independently sufficient reason. Recorded in `030`.

Worth noting the walker deliberately does NOT propagate through `import()`
(`tests/core-lab-boundary.test.ts:76`: "a deferred edge, not a load-time one"), which is
what makes the wp3 lazy-import approach the sanctioned remedy rather than a loophole.

### 3. MEDIUM — check-and-set was not atomic

`hasSeenQuotaReset` followed by `markQuotaResetSeen` is two steps. Two observers racing
the same key — a poller tick and a live pooled response — can both read false and both
notify, defeating criterion c-4 under exactly the load that makes detection interesting.

Fix, folded into `010`: replace both with one synchronous claim.

### 4. MEDIUM — 30-day pruning could evict a live key

A monthly window's key can legitimately be older than 30 days while still current, so
pruning by age alone can drop it and permit a duplicate notification.

Fix, folded into `010`: never prune a key whose `resetAt` is still in the future, and
raise the age floor to 90 days.

## Residuals accepted, not fixed

- `sweepExpiredProviderAccountQuotaRows` (`src/providers/quota.ts:1485`) has no caller and
  no registration. Wiring it would add a fourth silent row-removal path with the same
  misread-as-reset hazard. Out of scope; noted for a separate unit.
- The two divergent `normalizeResetAt` implementations stay divergent. Unifying them
  touches every provider parser and belongs in its own unit; the detector normalizes at its
  own boundary instead, which is already in the plan.
- `LOCAL_MANAGEMENT_READ_PATHS` (`src/lib/local-management-capability.ts:10`) is an
  allowlist for bound local reads used by `doctor`/`health`. The new route does not need
  to join it; not adding it is a deliberate choice, not an oversight.

VERDICT: GO-WITH-FIXES (blockers=4) — all four folded above.
