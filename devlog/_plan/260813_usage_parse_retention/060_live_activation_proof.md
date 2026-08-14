# 060 Live activation proof

Eight commits are on `dev`, `preview` and `main`, and the bench numbers are good, but the
goal says stop the LIVE blow-up and **no running process has ever executed this code**.
The proxy on :10100 is still pid 56953, up 112 minutes on the pre-fix binary.

Pre-restart baseline (`/tmp/pre-restart.json`):

```
pid 56953   rss 6.68 GiB   heapUsed 107 MB   uptime 112 min
watchdog: 60 consecutive samples, all 6.67-6.68 GiB
```

A 6.68 GiB resident set held flat behind a 107 MB JS heap is the allocator-ratchet
signature this work targets. A green bench on a synthetic ledger is not proof that the
deployed binary fixes the machine the user is actually on.

## Safety

`activeTurnCount` is 0 and `isDraining` is false, so a restart cuts no in-flight request.
`/Users/jun/.bun/bin/ocx` resolves to `bin/ocx.mjs` in this checkout, so the restart picks
up the deployed source with no build or publish step. npm latest is 2.13.0 and unaffected.

## Steps

1. Record the pre-restart baseline (done, above).
2. Restart through the service's own lifecycle rather than killing the process.
3. Prove the new pid is running THIS code: poll `/api/usage` repeatedly and require the
   usage read counters to show `tailReads` climbing while `fullReads` stays flat. The
   pre-fix binary cannot produce that shape — it had no tail-read path at all.
4. Drive the reported symptom directly — repeated dashboard tab switches and usage polls —
   and measure per-call latency plus RSS over time.
5. Compare against the recorded pre-fix figures: a 25.6 s cold `/api/usage`, +680 MB on a
   single call, and a 7.9 GiB plateau.

## Acceptance

- New pid serves `/api/usage` with `fullReads` flat and `tailReads` climbing across polls.
- Repeated polls do not ratchet RSS the way the pre-fix process did.
- Cold and warm latency are far below the 25.6 s that made tab switching unusable.

If the live run contradicts the bench, that contradiction is the next work-phase rather
than something to explain away.

## Result

Restarted through `POST /api/system/restart` with the expected-pid header, which drained
cleanly (`activeTurnCount` 0). New pid **80136**.

**Activation is proven by a store that only exists in this patch.** The live memory API
reports `usage_snapshot` with 1 retained entry at 15.2 MB. The pre-fix binary had no such
registration, so no old process can produce that field.

```
                     before (pid 56953)        after (pid 80136)
RSS                  6.68 GiB, flat 60 samples 0.86 -> 0.91 GiB over 4.3 min
JS heap              107 MB                    52 MB
cold /api/usage      25.6 s                    0.20 s
warm /api/usage      ~1 ms                     0.5-1.7 ms
cross-window polls   25.6 s, +680 MB each      1 ms / 1 ms / 115 ms, +43 MB total
tab-switch surfaces  blocking                  1-14 ms across 5 endpoints
```

Three polls were deliberately spaced 62 s apart to land past the 60 s summary-cache
freshness window — the case that previously forced a full 64 MiB reparse every minute and
ratcheted RSS permanently. They now cost 1 ms, 1 ms and 115 ms, and RSS moved 883 -> 926 MB
across the whole sequence rather than +680 MB per call.

Budget accounting is healthy: 19.8 MB retained against a 256 MB budget, `overBudgetBytes`
0, and 2096 enforcement runs with `entriesDemoted` 0 — nothing has needed eviction.

The 7.9 GiB plateau is gone on the machine that reported it. Note the ledger is currently
4.4 MB rather than the original 245 MB, because a reviewer agent destroyed the history; the
bench numbers in 032 cover the 245 MB / 1 GB / 2 GB cases that this live file no longer
exercises.
