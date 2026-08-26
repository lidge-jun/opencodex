# 220 — P-2 rotation probe (T02 / #1527 suspect)

## Evidence

4 consecutive ~101K-token turns on one pinned conversationId
(composer-2.5-fast) all completed (OK1..OK4, usage.totalTokens ~101,111-147).
No 0-token resource_exhausted, no conversation poisoning within the capped
attempt budget (probe cap <= 5 runs, quota hygiene doc 200).

## Verdict: NOT REPRODUCED — T02 stays deferred

The senpi #998 pathology (server pinning a rejection to a conversationId) did
not manifest at this size on this plan. #1527 remains open without a local
reproduction; rotation-with-persistence stays deferred until a live
reproduction exists. No implementation this round.
