# 002 — live issue manifest

Snapshot command: `gh issue list --repo lidge-jun/opencodex --state open --limit 200`
plus per-issue `gh issue view` comment tail.

Open issue count: 23. Issue #546 is not listed because it is already closed:
`closedAt=2026-07-27T10:17:08Z`.

| # | labels | last update | bucket | rationale |
| --- | --- | --- | --- | --- |
| 547 | bug | 2026-07-27T10:38:50Z | comment/request-changes | new Windows Claude Desktop custom-model visibility report; needs exact generated config/profile path, `ocx claude desktop` output, and Desktop dev-mode/API-key shape |
| 545 | bug, needs-info | 2026-07-27T10:22:15Z | takeover-fix/investigate | logging sub-bug fixed in `7fcaa9119`; remaining 64-token classifier behavior needs redacted request/frames or code isolation |
| 543 | bug, provider-compatibility, needs-info | 2026-07-27T08:34:24Z | comment/request-changes | reporter supplied native control; we can answer with existing `ocx debug claude` capture switch |
| 540 | enhancement, provider-compatibility, roadmap | 2026-07-27T08:09:26Z | later/enhancement | valid provider request but gated on official Automattic/OpenCodex auth contract |
| 521 | needs-info | 2026-07-27T01:15:52Z | comment/request-changes | reporter/update pending for web-search 499 reproduction details |
| 509 | needs-info | 2026-07-27T10:17:48Z | takeover-fix/investigate | JS heap memory warning gap is concrete enough for investigation but not merge/close |
| 476 | enhancement | 2026-07-27T05:08:51Z | needs-human/security | PR #526 signal half is safe to repair, but #527 restart/process-termination half crosses the process boundary |
| 462 | upstream-tracking, needs-info | 2026-07-26T21:40:30Z | upstream-tracking | session restore/model removal crash attributed upstream; keep tracking/needs-info |
| 425 | enhancement | 2026-07-26T02:31:52Z | later/enhancement | PR #512 foundation exists but account namespace policy needs decision |
| 418 | bug | 2026-07-26T21:44:52Z | takeover-fix/investigate | V2 custom-parent to custom-child delegation remains open with no linked PR |
| 417 | bug, upstream-tracking | 2026-07-24T18:31:11Z | upstream-tracking | Korean realtime transcript corruption tracked upstream; not an ocx relay fix yet |
| 415 | enhancement | 2026-07-24T11:29:04Z | later/enhancement | Gemini/search-capable provider sidecar follow-up from #398 |
| 414 | enhancement | 2026-07-24T11:28:50Z | later/enhancement | Exa/other search provider sidecar follow-up from #398 |
| 401 | enhancement, upstream-tracking | 2026-07-26T02:28:28Z | upstream-tracking | voice model route depends on realtime/Codex voice transport constraints |
| 386 | enhancement | 2026-07-24T12:27:26Z | later/enhancement | macOS menu bar companion remains release/packaging roadmap |
| 294 | enhancement, roadmap | 2026-07-27T00:41:58Z | later/enhancement | Claude account pool requires account-policy design; related PR #493 is draft/conflicting |
| 241 | bug, upstream-tracking | 2026-07-23T18:54:39Z | upstream-tracking | Desktop model picker limitation remains upstream-facing |
| 201 | enhancement, roadmap | 2026-07-22T11:40:05Z | later/enhancement | TRAE provider needs official auth/transport contract |
| 178 | enhancement, roadmap | 2026-07-22T11:40:06Z | later/enhancement | Factory is agent backend, not plain model API; needs product decision |
| 177 | enhancement, roadmap | 2026-07-22T11:40:08Z | later/enhancement | Warp/Oz agent API is not plain model API; needs product decision |
| 95 | enhancement, roadmap | 2026-07-22T11:40:11Z | later/enhancement | multi-user proxy/LiteLLM changes deployment model |
| 92 | bug, upstream-tracking | 2026-07-26T21:44:26Z | upstream-tracking | V2 encrypted_content/NEW_TASK body loss is upstream-facing and still open |
| 42 | enhancement, roadmap | 2026-07-27T02:40:56Z | later/enhancement | storage page roadmap has landed pieces but remaining restore/auto-policy phases |

## Immediate issue read

- `takeover-fix/investigate`: #545, #509, #418.
- `needs-human/security`: #476 for the process restart half.
- `comment/request-changes`: #547, #543, #521.
- `upstream-tracking`: #462, #417, #401, #241, #92.
- `later/enhancement`: #540, #425, #415, #414, #386, #294, #201, #178, #177, #95, #42.
- `close`: none from the current open list.
