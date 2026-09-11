# 900 — closing reconciliation

Opened 2026-08-23 against `origin/dev` at `bf8bcfd3c`. Closed 2026-08-24 at
`c9a202e38`.

## What went in

| PR | Item | Landed |
|----|------|--------|
| #2444, #2445 | wp0 roadmap + reviewer evidence | `3023be06d`, `c2b72fa22` |
| #2439 | contract manifest (Ingwannu) | `2a2f6e68f` |
| #2437 | history manifest contract (Ingwannu) | `81474259e` |
| #2435 | fetch helper boundary (Ingwannu) | `4fb0fbe7b` |
| #2446 | wp1-wp5 records | `ed719b568` |
| #2387 | process-state ownership (Ingwannu) | `b6c7c0afe` |
| #2380 | provider validation boundary (Ingwannu) | `aa37c8bea` |
| #2449 | combo zero-output failover, terminal recorded once | `88b7cc057` |
| #2448 | scoped `wait` integer coercion | `81bf4b9a4` |
| #2450 | centralized auth-context error mapping | `9cebfc64e` |
| #2452 | Windows WP13 stabilization | `6b0f61f64` |
| #2454 | combo target quota state | `c9a202e38` |

Closed: issues #2436, #2434, #2379, #2378, #2392 (Ingwannu); #2443, #2292,
#1587, #1702, #2152 (lidge-jun); #2431. PR #2433 closed as superseded by #2449,
with its author's commits preserved in that branch's history.

Retained with a dated reason on the issue: #1478, #1049, #1048, #820.

## The finding that justified the process

Every one of the six maintainer PRs arrived with green focused tests and green
CI. Five deserved to land on that evidence. One did not.

#2433's preflight recorded a failed terminal that the native passthrough
inspectors had already recorded, so a single 502 counted twice against account
health and halved the effective failover threshold on a healthy credential. The
existing tests asserted stream behavior, not health-transition counts, so
nothing in the pipeline could have caught it. It took a reviewer reading the
recorder's call graph across 2,000 lines of `core.ts` to see it.

The correction was then built rather than handed back, because the PR was
otherwise complete and the defect sat in a seam its author had no reason to
suspect. Moving a once-guard to a wider scope is itself risky — a guard that
became per-request instead of per-attempt would silently swallow later failover
terminals, quieter and worse than the bug being fixed — so that lifetime
question was audited on its own before the fix was allowed to land.

## What the evidence does not cover

#2152's repair is verified on macOS and by CI, but macOS cannot demonstrate
Windows scheduler relief or exercise the PowerShell identity timeout. Removing a
documented CPU-starvation source from a timeout-shaped failure is a well-founded
bet, not a proof. The issue is closed with that stated plainly, and the manual
Windows leg remains the only thing that can confirm it.

## Process notes worth keeping

Protected `dev` refuses direct pushes, so every devlog record travelled as its
own PR. Twice a `git reset --hard origin/dev` after a squash-merge dropped local
devlog commits that had not yet been pushed; both times the work was recovered
verbatim from reflog. The lesson is to branch the record before syncing, not
after.

The FSM refused several shortcuts that would have produced a tidier-looking
history than the work deserved: a phase skip while wp4 was still active, an
audit attestation whose pasted output ended in FAIL, and three C→D transitions
whose test receipts no longer matched the tree. Each refusal was correct.

