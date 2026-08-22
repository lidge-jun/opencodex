# 009 — WP roadmap lock (release readiness)

Locked after the audited 000 plan (Faraday PASS), mechanical 001 inventory
(109 commits), and the 002 risk matrix (all lanes assigned, sum 109,
security-review section pass with 2 P2 notes).

## Cycle order

1. WP2 -> 300_opus_fast_catalog.md (senpi unit): catalog repair, tests,
   live smoke on macmini.
2. WP3 -> 310_maxmode_bigctx.md: 2-run big-context A/B (billing approved);
   conditional maxMode propagation or NOOP.
3. WP4 -> execute 002 matrix: read-only lanes L1-L6 verify their ranked
   rows (run the named commands, falsify or confirm); main agent fixes
   P0/P1 with regression tests; full suite + typecheck + privacy + (if gui)
   lint. L3 lane re-reads release.ts + workflows at head for file:line
   security confirmation.
4. WP5 -> 090_go_verdict.md: final CI green + GO/NO-GO with evidence.

## Standing constraints

Write scope per 000 (WP4 lanes read-only, main-agent fixes only);
promotion excluded; probe hygiene per senpi-unit doc 200.

