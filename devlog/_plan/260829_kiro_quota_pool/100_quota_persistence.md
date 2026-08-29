# 100 — Work-phase 4: quota persistence across restart

Doc `080` listed three axes where kiro-lb was ahead. Doc `090` closed pre-request
selection. This closes the second: kiro-lb persists quota rows in SQLite and seeds
routing from them at startup (`kiro/store.py:206-289`), while our caches were
process-local — a restart forgot every measurement.

## Why it matters more now than it did before

Before pre-dispatch selection, forgetting quota only meant an empty dashboard until the
next probe. Now it means the pool opens its first turn after every restart with no idea
which account has room — precisely the blindness `090` exists to remove. Persistence is
what makes that feature survive a restart rather than warm up from scratch.

## Design

`src/providers/account-quota-disk.ts`, modelled directly on the Codex pool's own
snapshot (`src/codex/quota.ts`) rather than inventing a second shape:

- A single JSON file under `OPENCODEX_HOME`, written atomically, debounced 250ms.
- Keyed exactly like the in-memory cache, so hydration is a direct fill.
- Six-hour maximum age on load. A stale bar is still useful for ORDERING — a wrong
  guess costs one 429 that rotation already handles — but a day-old reading of a
  monthly window should not outrank a fresh probe.
- Percentages and reset timestamps only. No token, no email, no label; the account id
  is the store's own opaque id, which already keys the in-memory cache.
- Corrupt, missing, or future-version files load as empty. A cache must never be able
  to break startup.

Hydration is lazy and once-only, on the first cached read. `clearAccountQuotaCache()`
resets the hydration flag and cancels any pending write, so a cleared cache cannot be
re-seeded from the file it was just cleared of.

## Accept criteria

| # | Scenario | Observable proof |
| --- | --- | --- |
| 1 | Write then read in a fresh process | the percentage survives |
| 2 | Snapshot older than six hours | discarded, not loaded |
| 3 | Corrupt JSON | loads empty, does not throw |
| 4 | `version: 2` file | ignored |
| 5 | No file | not an error |
| 6 | Written file inspected | contains percentages; contains no token, email, ARN or secret |
| 7 | Five writes in a burst | one file write, last value wins |
| 8 | Cancelled write | no file created |

## Verification

```text
bun x tsc --noEmit    -> exit 0
bun run privacy:scan  -> Privacy scan passed
bun test (8 files)    -> 208 pass / 0 fail / 634 expect() calls
```

## What remains kiro-lb's

One axis from doc `080`: the operations dashboard — request-rate charts, per-model token
panels, Prometheus export. That is a product surface, not pool machinery, and it is
outside this unit's objective.
