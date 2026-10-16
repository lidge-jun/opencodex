# L1 owner bundle — record

Lane L1 of the 2.84.0 release train. The coordinator thread owns merge, release and PR decisions.

## Bundle (on dev a63267c134, after #7008)

One squashed commit per owner PR, patch-identical to the reviewed squashes: #6986 (Closes #6984), #6994 (#6982), #6993 (#6988), #6995 (#6989, #6991), #6997 (#6969), #6996 (#6972), #6959 (#6957), #6961 (#6675).

## #6999 split out (coordinator decision)

#6999 (request-history rebuild off the serving loop, #6990) failed hosted windows 6/9 in every run (event-loop lag 545, 508, 707, 667 and 1769 ms; the 667 ms run was the step-attribution round) across three repair rounds:

1. Index-backed health queries and native index paths.
2. A MEMORY journal for private builds and time-bounded ingest sub-transactions. On the Windows desktop the journal change alone took the rebuild from 5170 ms to 2400 ms, and both together measured 2190–2268 ms.
3. An asynchronous rename and warm-up during publication.

Step instrumentation then placed the remaining stalls in synchronous SQLite work on the serving thread: the open of the new generation (552 ms) and the first tail commit on the WAL connection (1204 ms), both with low process CPU. Bounding those needs SQLite off the serving thread, a change to how history is served that does not fit this release. No assertion was relaxed. The coordinator removed #6999 from 2.84.0.

All #6999 work, including the three repair rounds, their tests and their devlog, is preserved on `codex/6990-history-rebuild-followup` at `e831e863326089585b194b6939f4b7569fb12f14`. Plans and evidence are in that branch's `devlog/_plan/261013_rt284_l1_owner_bundle/` (000–070). The PR #6999 disposition belongs to the coordinator.
