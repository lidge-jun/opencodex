# 160 — terminal record

Audited against the goal objective's exact lists, not a running tally.

## (A) The fifteen `lidge-jun` issues — all closed

| Issue | Outcome |
|---|---|
| #2569 | Cursor catalog + effort ladder refresh |
| #2568 | OAuth 429 failover: HTTP-status, sidecar (#2607) and adapter-event (#2608) paths; activation default escalated |
| #2566 #2565 | account/quota CLI surfaces |
| #2558 #2557 | service-tier classification, Windows restart probe |
| #2491 | slug-equivalence unification |
| #2472 | zero-output completion producer gap |
| #2465 | shipped model presets (#2603, #2604, #2606) |
| #2464 | new models arrive disabled (#2609) |
| #2463 | provider and model aliases (#2610) |
| #1478 | config rebase provenance (#2613) |
| #1049 | pre-substrate home adoption (#2612) |
| #1048 | disposable-host service acceptance (#2618) |
| #820 | session-lane bounds (#2611) |

## (B) The sixteen bug PRs — fifteen terminal

Merged: #2563 #2555 #2550 #2532 #2528 #2515 #2474.
Closed with recorded evidence, superseded by a verified rebase or replacement:
#2567 #2542 #2513 #2512 #2510 #2503 #2490 #2488.

**#2497 is the one open item, and it is a decision rather than a task.** It is the credential
boundary `AGENTS.md` places under explicit security review. Three blockers were verified by hand
(`120_wp5_2497_security_review.md`): non-atomic `auth.json` publication with no startup recovery;
a same-account fallback that adopts a *different* pool refresh grant into native-main; and an
"exactly one" 401 replay that expands to up to nine physical sends through the transient-retry
ladder. The second is an ownership question — tightening it to grant-only changes what happens
to an operator who re-logged in through the pool and expects main to follow. Picking a side
silently inside someone else's 2,600-line credential PR is not a thing to do quietly.

## Beyond the objective

The stated criterion was met partway through, so the loop continued into the `bug`-labelled
community backlog: sixteen open, three left (`150_community_bug_sweep.md`). Nine more bug PRs
that arrived mid-run were also carried to terminal.

## Terminal state

`dev` at `b5563d438`: 15037 pass / 16 skip / 0 fail, typecheck and `privacy:scan` green.

Four items remain, each blocked on input this loop cannot produce:

- **#2497** — ownership decision on cross-grant credential adoption.
- **#2221** — a designed, crash-safe `auth.json` publication protocol. Refresh rotates the grant,
  `atomicWriteFile` has no external-writer CAS, and the Codex CLI writes the same file, so the
  safe-looking half cannot ship alone without risking the login.
- **#1527** — a matched live probe only the reporter can run, now that checkpoint continuation
  removed the biggest confound from their comparison.
- **#1419** — a full `.ips` with frames past Bun's crash handler.

Plus **wp7d**, deliberately unimplemented: presence-driven OAuth failover spends a second
subscription's quota, so the default was escalated on #2568 with the one-line change named.

## What the loop is worth remembering for

Falsification caught a patch (#2488) whose test passed with the fix reverted — decoration, not a
fix — and it is what proved the parent-thread lane, the atomic adoption publication and both
uninstall hunks were load-bearing. Six community issues turned out to be already fixed by earlier
work in this same run; each was verified by ancestry check plus a covering test before closing,
because closing on a report is how a backlog fills with issues nobody actually resolved.
