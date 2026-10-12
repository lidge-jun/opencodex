# Original transport acceptance verification follow-up

Current status: COMPLETE. The focused follow-up merged as3f9fe3fa29 after exact-head hosted proof, and both issues were reclosed. Earlier checkpoints below are retained as history; the final receipt is in Verified delivery.

Final acceptance audit at devb9d430bb5b found three explicitly requested scenarios without direct execution evidence. The implementations from #5125 and #5127 remain integrated; no new production defect was asserted. Issues #5109 and #5110 were reopened until the missing regression evidence is delivered and verified.

| Original issue | Required witness | Intended test location |
| --- | --- | --- |
| #5109 | A supported real SOCKS HEAD request settles with a null body without waiting for the upstream peer to end its response. Existing headers and cleanup remain correct. | `tests/lib/transport-null-body.test.ts` or the existing uncapped SOCKS fixture suite |
| #5110 | Informational responses precede a final response without being treated as final, and upload handling remains correct. | `tests/lib/socks5-upload-lifecycle.test.ts` |
| #5110 | A response timeout fires while a body read is stalled and the request settles with its intended timeout outcome, releasing reader/socket resources. | `tests/lib/socks5-upload-lifecycle.test.ts` |

The runtime owner delivers a separate focused branch/PR from current dev. Preserve the published preview-server head and serialize checkout writers before switching branches. No production change is planned unless the focused execution exposes a concrete defect. Reuse current fixtures and preserve existing assertions, deadlines, size caps and test inventories. A controlled timer may activate the real timeout branch after the stalled-read condition is observed; a predicate-only check is not equivalent evidence.

Verification remains static source/test review plus exact-head hosted execution. No local test, typecheck, build, installation or runtime execution is authorized. Re-close each issue only after the follow-up lands on dev and its original scenarios are observed executing successfully. The previous per-PR receipts remain historical evidence for their covered scope and are not discarded or relabeled.

Historical publication checkpoint: [PR #5225](https://github.com/lidge-jun/opencodex/pull/5225) was published atf43cc0f6e95f85cb24ec7a891f26200fca4d8428. Its initial hosted checks were green, and source review accepted HEAD and timeout activation/cleanup. Informational-response coverage still needed a causal upload-continuation witness at that checkpoint.

The initial informational fixture queued the whole request body before the peer sent interim responses. It therefore proved header parsing and eventual upload, but not continuation after interim processing. The correction holds the trailing chunk/EOF until client-side receipt of both complete100/103heads and a native event-loop checkpoint, then observes the rest of the upload and final response. No production hook or arbitrary delay is needed. Closure remains pending the corrected head, hosted execution and actual dev landing.

Corrected head497b7df9e9376cab448297d6c5d2ef02704d09df is published on #5225, with source unchanged and a single informational-fixture interdiff. It gates the trailing body on the peer sending interim responses and adds pre-teardown closure; independent review found that client-side receipt/processing was not yet observed. Independent re-review and exact-head run35475511843 remain pending.

Revision899c57ca2a adds the actual client-side receipt/native-checkpoint witness and closes the original behavior-coverage rows statically. Review then identified a fixture failure-safety gap in unbounded receipt waiting and global observer cleanup. One bounded test-only correction patch was prepared in ignored scratch, inspected by main and handed to the owner. No source behavior or timeout constant changes are needed. The899 hosted macOS1 job also reports four separate runtime-probe/settings/combo failures; these are recorded without asserting an environmental root cause or rerunning a superseded head.

## Verified delivery

Final head9e3ee90f930d6f7ebaf94f3a2dd2425a6f7ce332 passed independent causal-order and failure-cleanup review. Exact-head run35477114410 attempt1 succeeded with all applicable jobs/aggregate. Actual macOS logs105988178081 and105988178063 show HEAD, informational100/103 continuation and stalled-read timeout passing. Both checked outa81daf8d491f830899264a55a4f99eddbd8bc80b, whose tree088e56b6379cd5dbf6b28fd5db8f682bd362a468 equals the reviewed head and actual dev merge.

PR5225 merged as3f9fe3fa2993126c95a0c64627f4a5d609e0a1a7 at2026-09-20T00:03:16Z. Dev ancestry was verified, then #5109 and #5110 were reclosed at00:04:02Z and00:04:04Z and their states reread. Native membership was absent, the public finding was resolved and maintainer integration was recorded. No production behavior, timeout or existing assertion was weakened; no local execution was performed. This closes the follow-up, not the still-open #5118 or final campaign gate.
