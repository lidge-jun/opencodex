# 030 — open-issue disposition (post-2.49)

Source: recon lane C, verified against gh on 2026-09-09 (57 open issues,
origin/dev 57077ca32, v2.49.0 = 2f3f73629). No STALE-FIXED, no DUPLICATE.

## CLEAR-FIX (8)

| issue | title | linked PR |
|---|---|---|
| #4122 | Spark 5h header window stored as account-level short quota on Pro | — |
| #4121 | opencode-free Zen rejects without x-opencode-session | — (#3954 related, not closing) |
| #4120 | revoked-but-time-valid pool credential stays "ok" | — |
| #4112 | non-streaming 413 never hits context-overflow mapping | #4119 (follow-up, not closing) |
| #4110 | client-compaction status treats operator-owned URL as non-proxy | #4114 draft (Closes) |
| #4089 | mid-thread native→routed switch; agentTaskRecovery gated on threadSpawn | — |
| #4083 | Codex WS 30s response-prelude cuts multi-image slow starts | #4084 draft (Closes) |
| #3926 | Google AI Studio discovery rejects models[] envelope | #4068 draft (Closes) |

No closing PR yet: #4122, #4121, #4120, #4089, #4112.

## POLICY (8) — interview decisions

| issue | question |
|---|---|
| #4076 | remove the ChatGPT quota overlay that blocks picking other models? |
| #4073 | private follow-up path for pending security reports (process/docs) |
| #3978 | allow client compaction without disabling V2 routing (Design B) |
| #3859 | make email masking optional (privacy gate change) |
| #3846 | persist pool accounts as quota-limited instead of warmup-gating (draft #3848 exists) |
| #3761 | hosted-search bridge for raw Responses passthrough (contract choice) |
| #3506 | add a no-progress cutoff after #2600 (product decision) |
| #2495 | opt-in plaintext V2 rewrite for native→routed subagents (tracking) |

## LIVE-PROBE (9) — deferred unless measurable via computer-use

#3782 (Claude Desktop model switch), #3781 (TUN/Fake-IP), #3775 (gateway/Desktop),
#3765 (cache plateau attribution), #3719 (Anthropic replay + cache),
#3661 (V2 subagent encrypted task), #3522 (Windows spill), #3433 (Hermes cache),
plus #4083's field half already covered by draft #4084.

## IMPROVEMENT (32)

#4079 (quota-reset-first scheduling; draft #4080), #4075 (Gemini setup UX),
#4057 (account identity in logs), #4055 (persistent WebUI auth on remote binds),
#4038 (decode tok/s; draft #4040), #4024 (OpenRouter key rotation),
#3898 (headless hub reauth), #3777 (Anthropic plan exposure), #3774 (DnD picker order),
#3729 (remote catalog pull), #3705 (Guardrails; draft #4022), #3666 (free-model filter),
#3630 (catalog auto-refresh), #3573 (configurable body limit), #3494 (VS Code agents),
#3459 (request transform hook; draft #3463), #3417 (native main login profiles),
#3379 (dashboard gaps epic), #3377 (per-model capabilities), #3376 (quota history;
draft #4080), #3375 (OAuth pool lifecycle), #3191 (MSP adapter), #2894 (SOCKS5;
drafts #3901/#2921), #2834 (relay diagnostics), #2811 (update manager),
#2730 (alpha search auth), #2511 (image byte budget; #4119 open), #2358 (RFC),
#2279 (synthetic max; draft #2280), #1711 (zero-credit grey-out),
#1416 (Orca manifest), #1213 (Claude Desktop catalog mode), #95 (hosted multi-user).

