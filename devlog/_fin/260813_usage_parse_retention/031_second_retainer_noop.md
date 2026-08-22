# 031 — Second retainer verdict (WP3 NOOP)

Live snapshot 2026-08-14, PID 96695 (pre-fix process still running on :10100):

- RSS 7.65 GiB, heapUsed 1.10 GiB, jscHeap 1.10 GiB / 7.46M objects
- appOwned retainedBytes 41.6 MiB / 256 MiB budget
- responses_continuation: 88 rows, 38.5 MiB (caps: 1000 rows, 64 MiB at src/responses/state.ts:17-23)
- request_log: 2000 rows / 2.87 MiB (MAX_LOG_SIZE 2000 at src/server/request-log.ts:168)
- model_cache: 8 rows / 41 KiB
- usage_summary: 2 rows / 132 KiB
- catalog gather admission: 8 flights (src/codex/catalog/provider-fetch.ts:224)
- routing-history.sqlite: not open in the live PID (lsof: only native-main owner sqlite)
- translator_buffers highWater 10.1 MiB, current 1.3 MiB, active 0
- PR 1608 still OPEN; WS bound not on this running binary

Verdict: indexer / catalog / responses-state / request-log cannot explain 7+ GiB.
They stay rejected as the 9 GiB driver. WP3 does not patch ws-upstream.ts.
WS remains owned by PR 1608. 001 live-gate (RSS rise with usage fullReads flat)
was not met as a separate driver: the still-running process is the pre-fix
binary whose usage-parse stampede already accounts for the objectCount/RSS.
