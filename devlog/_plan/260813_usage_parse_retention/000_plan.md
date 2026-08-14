---
title: Usage-parse retention — live RSS blow-up
date: 2026-08-13
class: C4
---

# 000 — Objective

Local `ocx start --port 10100` climbed to RSS 9.5 GiB in about three minutes
(Bun 1.3.14 bundled, JSC objectCount ~6.7M, JS/JSC heap 1.0–1.8 GiB, CPU ~90%).
App-owned retained stores reported only ~32–47 MB. The user contract is: once
`/api/usage` has loaded, it must stop; another dashboard tab must not force a
full re-parse or re-retain of `usage.jsonl`.

This unit stops that blow-up, independently reviews the changed paths, then
lands the fix on `origin/dev`, preview, main, and the matching npm release.
The user authorized push, preview/main promotion, and deploy in the requesting
turn.

## Live snapshot (2026-08-13 KST)

| Probe | Value |
|---|---|
| First process | PID 83382, uptime ~202s, RSS 9.57 GiB, heapUsed 1.07 GiB, jscHeap 1.07 GiB / 6.77M objects |
| App-owned | retainedBytes 32.9 MB (responses_continuation 29.9 MB, request_log 2.8 MB) |
| usage.jsonl | 243,587,988 bytes / 453,345 lines |
| routing-history.sqlite | 453,324,800 bytes (derived index, not the live retainer) |
| Watchdog | warnThreshold 4 GiB, observed rss 8.3–9.5 GiB |
| Later process | PID 99534 replaced 83382 without this session killing it; uptime 407s, RSS 6.71 GiB, heapUsed 169 MB, objectCount 441k |

The later process still sits well above the 4 GiB warn line with only 169 MB of
JS heap. That is allocator high-water / native residual, not a registered store.

## Loop spec

- Archetype: HOTL incident fix + release train.
- Trigger: dashboard memory card at 6.4 / 4.0 GiB and local RSS 9.5 GiB.
- Goal: growing `usage.jsonl` no longer causes a 64 MiB reparse after first load.
- Non-goals: deleting `usage.jsonl`; raising the 4 GiB watchdog; killing the live proxy as the fix.
- Verifier: focused bun tests, typecheck, append-and-assert, Opus + Sol verdicts, git/gh SHAs.
- Wall-clock: 6 hours.
- Memory artifact: this directory.

## HOTL resource bounds

Write scope: `src/usage/log.ts`, `logs-usage-routes.ts`, `usage-summary-cache.ts`, `api-key-usage.ts`, GUI `/api/usage` callers, `ws-upstream.ts` only if WP3 confirms, matching tests, docs-site only if user-facing behavior changes, this unit.
Out of scope: untracked `.dirfd-probe-*.ok`, credential files, deleting home-dir ledgers.

## Hypotheses

H1 confirmed: append invalidates exact revision cache and reparses 64 MiB (`src/usage/log.ts:502-598`, `logs-usage-routes.ts:216-226`). `tests/api-usage.test.ts:300-322` currently requires `fullReads` 1 to 2 after one append. `tailReads` exists and is never incremented.

H2 confirmed as allocation volume, rejected as durable JS retainer. Nothing stores `snapshot.entries` after `jsonResponse`.

H3 rejected for history/catalog/request-log/responses-state. Secondary open item: unbounded Codex WS queue in `src/server/responses/ws-upstream.ts:138-162`. PR #1608 already bounds it and is not on `dev`.

## Work-phase map

1. WP0 docs-only lock (000 + 001 research + 010-050).
2. WP1 `010` append-tolerant snapshot + caches.
3. WP2 `020` GUI stampede.
4. WP3 `030` WS bound if still needed.
5. WP4 `040` Opus + Sol review.
6. WP5 `050` push / preview / main / release.
