# 061 — roadmap audit round 1 synthesis (reviewer: Singer, VERDICT FAIL)

Per-blocker adjudication before re-audit. Amendments land in 060/070/080/090/100/110.

| # | Blocker | Decision | Action |
|---|---|---|---|
| 1 | 1 MiB cap not strict (decoded-string + whole-chunk charge drifts from 051 raw-byte incremental scanner) | ACCEPT | 080.1 rewritten to the 051 design: accumulate raw byte slices, incremental cross-chunk delimiter scan, decode only complete ≤cap candidates. New tests: >cap single chunk; large consumed prefix + small partial remainder. |
| 2 | 8 MiB charge drifted to string length | ACCEPT | 080.2 charges the bounded SSE payload SOURCE BYTES (byteLength of the complete frame slice that produced the item), per 051. |
| 3 | Item-cap overflow can persist truncated continuation via state.ts replay | ACCEPT | 080.2/080.3: any eviction/rejection TAINTS reconstruction — a tainted inspector never synthesizes `output` from the partial map; `onCompletedResponse` fires only with the response's own authoritative output (or not at all when output is empty+tainted). Regression: no partial replay stored. |
| 4 | Legit >1 MiB events (large function args, terminal snapshots) make degradation lossy | PARTIAL ACCEPT | Overflow semantics made safe (taint + no corrupt persistence + counters give real-traffic high-water evidence post-deploy). Frame cap raised 1 MiB → 4 MiB to cover realistic large tool-call events while still bounding runaway frames; synthetic-incomplete misclassification on an oversized TERMINAL frame is accepted, counted (`frameCapOverflows`), and documented as inspection-only degradation — client bytes and client-visible terminal are unaffected. |
| 5 | Disconnect ownership covers only consumeForInspection | ACCEPT | 080.5 now routes BOTH consumers through one shared bounded pump (consumeForResponseLogMetadata included); both receive clientGoneSignal + drain bounds + dispose. |
| 6 | Patched remote smoke must precede closeout | ACCEPT | wp2 (070) gains a post-patch remote smoke calibration on macmini-cf (cheap, minutes; smoke self-stamps valid:false by design — the gate is "calibration passes and no warm-invalid trip", not measurement). No measured-fix claim anywhere in this unit. Full RSS measurement stays a documented follow-up. |
| 7 | Darwin opt-in missing abort-stress gate | PARTIAL ACCEPT | 052's own migration order places the stress run AFTER the gate change (step 2 → step 3), so "dropped dependency" overstates; but the substance is accepted: wp5 (100) adds a bounded local Darwin abort-stress test (we ARE on darwin arm64 Bun 1.3.14) — repeated client aborts against the eager path under a local fake upstream, seconds-scale, run before the opt-in commit is pushed. Crash/hang = phase BLOCKED, opt-in gate not landed. |
| 8a | 090 test list missing 052's orderings | ACCEPT | 090 tests extended: reset-before-any-bytes, concurrent cancel/reset, exactly-one-terminal/one-DONE, reader-cancel/upstream-abort teardown, byte parity vs relaySseWithFailedTail tail. |
| 8b | 100 integration test not portable (linux must stay tee; eagerRelay field win32-only) | ACCEPT | 100: pure-function tests are the portable gate; the end-to-end fixture is darwin-only (skip elsewhere), asserts via the native-passthrough marker not the win32-only field; `/api/system/memory` `eagerRelay` field additionally becomes platform-inclusive when eager is selected (small system-routes change, covered by test). |
| 8c | 090 depends on 080 (dispose hook touches eager finally) | ACCEPT | 060 phase map ordering fixed: 080 → 090 dependency recorded. |

Re-audit: same reviewer, synthesis + amended-doc diff summary supplied.

## Round 2 (VERDICT FAIL, 6 blockers) — adjudication

| # | Blocker | Decision | Action |
|---|---|---|---|
| R2-1 | Cap must apply per-CANDIDATE not per-chunk; delimiter parity with `/\r?\n\r?\n/` (mixed forms) | ACCEPT | 080.1: overflow trips only when the CURRENT candidate crosses 4 MiB pre-delimiter — a >4 MiB chunk of many small frames parses fine. Byte scanner accepts all four delimiter forms (`\n\n`, `\r\n\r\n`, `\r\n\n`, `\n\r\n`) with parity tests + >cap multi-frame-chunk test. |
| R2-2 | Client-cancel point already aborts upstream → late terminal can't reach the drain | ACCEPT | 080.5: abort OWNERSHIP transfers to the bounded pump. Client relay cancel() notifies (clientGoneSignal) but no longer aborts upstream directly on the tee path; the pump aborts/cancels after terminal, 15 s, or 32 MiB. Win32 native path unchanged. |
| R2-3 | 090 teardown claim contradicts code; byte-parity vs new 512-char cap contradiction | ACCEPT | 090: teardown explicitly extended — producer-failure path also aborts upstream + cancels reader (test 9 satisfiable). Parity redefined: ONE shared capped serializer (`buildFailedTailPayload`, 512-char cap) used by BOTH relaySseWithFailedTail and the eager tail; parity holds by construction, long-message truncation tested on both paths. |
| R2-4 | Abort-stress can false-green without a real HTTP sink | ACCEPT | 100: stress topology mandated as real `Bun.serve` + real network-client socket aborts (before-first-byte / mid-frame / during-backpressure), external process watchdog observing crash/hang, recorded random seed. Isolated stream-only bun test explicitly insufficient. |
| R2-5 | native-passthrough marker can't distinguish eager from tee | ACCEPT | 100: add a path-specific test seam — `markEagerRelaySseResponse` WeakSet (test-only export `isEagerRelaySseResponse`) set only on the eager branch; e2e asserts that marker. |
| R2-6 | 110 unconditionally requires wp5 while allowing wp5-BLOCKED | ACCEPT | 110: commit list and docs-sync items conditional on wp5 landing; BLOCKED outcome ships without the gate change and without the darwin docs sentence. |

Round-2 rebuttals accepted in full — no push-backs. Re-audit round 3 with the same reviewer.
