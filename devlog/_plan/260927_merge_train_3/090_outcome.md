# Merge train round 3 — outcome

Re-queried after B9; B10 and B11 were added afterwards. #6076 (Remote Link join requires pairing) stays open: pairing-issued sessions exist only on hubs while join runs on a standalone, so as written join becomes unreachable; the lane commented with the fix direction. #6077 is a new draft feature. Round 3 started at 61 open issues and 80 open PRs; it ends at 40 open issues (goal met)
and about 50 open PRs (goal of 40 not met by this lane; every remaining PR is listed below with its reason).

## Landed

| Batch PR | Carried and fixed | Issues closed |
|---|---|---|
| #6059 (B1) | #6015 #6034 #6026 #6019 #6041 #6006 #6011, plus four review fixes | #6014 #6032 #5960 #6017 #6033 #6005 #4191 |
| #6061 (B2) | #6057 #6035 #6022 #6047 #6046 #6036 #6038 #6048, plus the CLI warning, the vanished-home fix and a layout compaction | — |
| #6062 (B3) | #6049 #6042 #6037 #6020 #6050, plus generation-keyed quota retries and the #5494 token-plan hold | #6018 #5494 |
| #6063 (B4) | #6043 | — |
| #6066 (B5) | #5953 (narrowed) #6027 (three blockers fixed), the #5180 Command Code retry default, the #4055 docs correction | #5465 #5569 #5180 #4055 |
| #6069 (B6) | #5925, #5977 with a signed local-read response | — |
| #6070 (B7) | #6025 #6010 #6007 (screenshot from an isolated home) | #6021 #6009 |
| #6071 (B8) | #6064 #6068 #6067 #6065 | — |
| #6073 (B9) | #6072, plus the legacy picker key removed on every intercept start; this outcome record | — |
| #6075 (B10) | #6074 (Codex Desktop 26.924 config rewrite no longer makes OpenCodex stand down; drift is healed on the refresh tick), plus honest heal reporting and a tick test | — |
| B11 | #6078 (`[1m]` marker for million-token routes in the Desktop picker) | — |

Closed without landing, with evidence: #6056 (superseded by #6020), #4728 (29k-line out-of-scope draft), issues
#3377 #5443 #1213 #3191 (implemented earlier; closed by the coordinator), #5917 (fixed in v2.63.0), #3433 (identifiers
preserved, #4365 and #5742).

Aside was used on every carried PR and resolved issue (captures in `.tmp/aside/`), and it surfaced #5917, #5494,
#5180, #3433 and #4055 from the open bug list.

## Open PRs, with reasons

| PR | Reason |
|---|---|
| #5831, #5964, #5956, #5995, #5800, #5912 | Owner decisions recorded in round 2, unchanged |
| #5879 | Needs its ownership and retry redesign first |
| #6051 | Accurate and safe, but it creates a new `.agents/` skill root that neither `AGENTS.md` nor the hygiene tests know; owner call |
| #6003 | Draft opt-in feature: null-body 500, unbounded rescans, error frames not terminal, duplicate request logs; product call |
| #5893 | Head is byte-identical to the code reverted in round 2; Bun still ignores its `*.local`/CIDR bypasses |
| #6030 | Draft: launchd PATH adoption drops non-PATH changes, two file-size ratchet breaches, WinSW PATH not filtered, conflict |
| #5927 | Security blocker on the images pool path (details in scratch) |
| #5539 | Reverses two test-locked behaviors without a reproduction; a narrowed `minimal` carve-out is possible but the author owns it |
| #4732 | Perf rework must be redone against `snapshot-select.ts` with a measurement |
| #4177 | Dev cannot loop on redirects; the remaining cross-provider chains are a feature to re-propose |
| #5947, #5782, #5497, #4222 | Feature-sized or conflicting (round 2 reasons stand) |
| #5374, #5099, #4228, #4056, #4022, #3742, #3741, #3738, #3463 | Stale, feature-sized or security-bound non-GUI drafts from round 2's triage |
| #6058, #5983, #5955, #5950, #5932, #5905, #5871, #5631, #5617, #5424, #5408, #5272, #5253, #5193, #4932, #4649, #4647, #4259, #3833, #3282, #3025, #2355 | GUI features or GUI-bound enhancements, outside this round's scope |

## Open issues, with reasons

- Waiting on an open PR listed above: #5982 (#5983), #5853 (#5893), #5679 (#5905), #5660 (#5950), #5649 (#5956),
  #3705 (#4022), #3459 (#3463), #4189 (#4259, #4647).
- Needs information or live evidence: #4143 (reporter's desktop routing), #4878, #4213, #3765, #3506 (upstream).
- Mitigated, not fixed: #5848 (warning shipped in #6070; the remote client must list all providers).
- CI infrastructure: #4956.
- Needs a design or owner decision: #4961 (the issue withholds a design), #6013, #5745, #5616, #5561, #5493, #5270,
  #4869, #4854, #4761, #4644, #4579, #4434, #4198, #4173, #3494, #3379, #3376, #3375, #2834, #2811, #2511, #2358, #1416, #95.
