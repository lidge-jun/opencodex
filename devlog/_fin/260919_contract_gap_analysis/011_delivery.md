# Delivered: sixteen issues and two existing-issue implementation comments

The approved source analysis is now tracked in sixteen new issues: five defects, eight feature proposals and three documentation corrections. Each published body includes the implementation path and acceptance cases. Two existing issues received bounded implementation comments instead of duplicate issues. No runtime code was changed and no implementation is claimed.

## Verified issue delivery

| Candidate | Issue | Type | Verified state |
| --- | --- | --- | --- |
| T1 | [#5109: [Bug]: Return null bodies for 204 and 205 in raw outbound transports](https://github.com/lidge-jun/opencodex/issues/5109) | bug | OPEN |
| T2 | [#5110: [Bug]: Settle SOCKS5 streaming uploads on cancellation and early final responses](https://github.com/lidge-jun/opencodex/issues/5110) | bug | OPEN |
| T3 | [#5111: [Bug]: Decode content-coded responses on the pinned direct provider transport](https://github.com/lidge-jun/opencodex/issues/5111) | bug | OPEN |
| G1 | [#5112: [Feature]: Report endpoint-scoped tool-schema loss before applying stricter policy](https://github.com/lidge-jun/opencodex/issues/5112) | enhancement | OPEN |
| S1 | [#5113: [Bug]: Keep routed custom-tool preview consistent with fence-normalized completion](https://github.com/lidge-jun/opencodex/issues/5113) | bug | OPEN |
| P1 | [#5114: [Feature]: Resolve static model policy once for catalog and routing consumers](https://github.com/lidge-jun/opencodex/issues/5114) | enhancement | OPEN |
| P2 | [#5115: [Feature]: Derive model selector decode hints from all classified registry identity maps](https://github.com/lidge-jun/opencodex/issues/5115) | enhancement | OPEN |
| V1 | [#5116: [Feature]: Separate contract authority from source review fan-out in the structure manifest](https://github.com/lidge-jun/opencodex/issues/5116) | enhancement | OPEN |
| O1 | [#5117: [Feature]: Export existing request telemetry through an opt-in metadata-only scrape endpoint](https://github.com/lidge-jun/opencodex/issues/5117) | enhancement | OPEN |
| O2 | [#5118: [Feature]: Preview integration mutations using the server ownership plan](https://github.com/lidge-jun/opencodex/issues/5118) | enhancement | OPEN |
| D1 | [#5119: [Docs]: Align SOCKS5 HTTP/SSE routing documentation with configured outbound fetch](https://github.com/lidge-jun/opencodex/issues/5119) | documentation | OPEN |
| D2 | [#5120: [Docs]: Correct apiKeys documentation to preserve management/data-plane separation](https://github.com/lidge-jun/opencodex/issues/5120) | documentation | OPEN |
| D3 | [#5121: [Docs]: Bind core/Lab isolation and synchronous activation in the invariant index](https://github.com/lidge-jun/opencodex/issues/5121) | documentation | OPEN |
| R1 | [#5122: [Feature]: Complete cross-layer send accounting for pre-output rate-limit replay](https://github.com/lidge-jun/opencodex/issues/5122) | enhancement | OPEN |
| R2 | [#5123: [Feature]: Make explicit sibling instances honor the spend-ledger topology contract](https://github.com/lidge-jun/opencodex/issues/5123) | enhancement | OPEN |
| R3 | [#5124: [Bug]: Request full replay when a task-scoped continuation cannot be used](https://github.com/lidge-jun/opencodex/issues/5124) | bug | OPEN |

## Existing authority extended

- [Implementation comment on #2358](https://github.com/lidge-jun/opencodex/issues/2358#issuecomment-5740122588)
- [Implementation comment on #5049](https://github.com/lidge-jun/opencodex/issues/5049#issuecomment-5740122723)

## Fresh verification

- All sixteen issues were reread using `gh issue view --json number,title,body,state,labels,url`. Titles and full bodies match the approved drafts; each issue is open with its matching template label. Result: `REMOTE_ISSUE_VERIFICATION_PASS`.
- Both comments were reread through their exact issue-comment API IDs. Their bodies match the approved drafts.
- The pure documentation checker validates all sixteen issue forms, the two comments, publication text constraints and ninety source permalinks. Result: `DOCUMENT_CONTRACT_CHECK_PASS`.
- `git diff --cached --check` passed after the final document cleanup.
- Source analysis remains pinned to `7864869c31c41cca9830d93540238f17df8faafb`. The one intervening `dev` commit was checked as recorded in 001 and invalidates none of these candidates.
- Publication used the repository template chooser and the matching form. Generated field ordering and code fences were normalized to the exact approved body through the issue API. One post-submit browser read and one search-index delay were reconciled by reading the actual existing issue; neither was resubmitted.
- Runtime suites, typecheck, builds, installs, live provider experiments and service changes were not run. Future implementation owns its focused regression and exact-head CI proof.

## Implementation ordering and boundaries

Transport/body lifecycle fixes and the routed input-stream consistency fix can be independent focused changes. Schema diagnostics precede opt-in stricter policy. Static-policy consolidation starts with parity fixtures; decode-hint completeness remains separate from catalog availability. Shared-journal ownership must cover every writer before any enforcement claim. Document corrections and invariant binding reuse existing runtime guards. Standard metrics export and integration preview are optional operator features; neither expands the proxy into a tool executor or tenant platform.

The task ends at verified analysis and issue delivery. No PR, push, merge, release, deployment or source patch was performed. The local devlog is retained as the complete decision and delivery record. Implementation issues remain open for future work.
