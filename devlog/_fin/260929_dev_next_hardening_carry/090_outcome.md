# 090 Outcome: dev after 2.70.0

All six work-phases closed on 2026-09-29. `dev` moved from `a118fcc64c` to `2e35b2573d`.

| wp | Unit | Landed |
|---|---|---|
| wp1 | roadmap, gpt-6-sol audit NEAR-PASS (folded) | this unit |
| wp2 | Claude request-contract hardening | #6217 `08a85175f3` |
| wp3 | forged `ss` owner tuples (luvs01) | #6194 `d0157e0f59` |
| wp4 | drift-heal ownership veto (luvs01) | #6195 `101fa61137` |
| wp5 | bounded GLM checkpoint scan (luvs01); CodeRabbit doc thread answered and resolved | #6193 `ab5807267e` |
| wp6 | Usage blank scroll, carried with `Co-authored-by: Jian Gong`; #6089 closed with a pointer | #6218 `2e35b2573d` |

Verification on `2e35b2573d` in a `/private/tmp` checkout with isolated homes: typecheck; 337 pass /
1 skip / 0 fail across the contract, reasoning, tool-choice, web-search, usage-cost, port-reclaim,
catalog auto-refresh, GLM summary, metadata sync, file-size ratchet and test-layout files; GUI Usage
tests 44 pass; structure and privacy checks pass. #6194, #6195 and #6193 were first merged together
onto `08a85175f3` (typecheck, 102 pass / 1 skip); #6218 passed its full exact-head CI before merge.
#6217 and the three luvs01 PRs were admin-merged without new exact-head CI at the owner's request;
their approved heads had green CI.

Held for an owner decision: #6214 removes the preemptive Kiro rows (Sonnet 5.5, Opus 5.5, GPT-6
Sol/Luna); Kiro now publishes Opus 5.5 and the preemptive policy was the owner's choice. Also held:
#6209 (needs a real Windows run), #6119 (open maintainer objection).
