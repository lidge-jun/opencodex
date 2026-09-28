# Release 2.69.0 outcome

Published 2026-09-28 (KST). npm `latest=2.69.0`, `preview=2.69.0-preview.20260928`.

| Step | Evidence |
|---|---|
| Release tree | Candidate `870f39e75e` (release train 4; final Cross-platform CI run 36348371944 passed) plus #6140, which removed agent scratch files (`.agents/`, root `design-debt.md`, train 4 lane `_handoff.md`) and added a repo-hygiene guard. dev at `b3d445d8ec`. |
| dev pre-move | #6136 moved dev to 2.70.0 (`081b670892`) before any publish. |
| Superseded promotion | #6137 (preview) and #6138 (main) were merged from `870f39e75e` and then replaced before publication, when the owner asked for the scratch-file cleanup. Their push CI runs were cancelled; nothing was published from them. |
| Preview | #6141 merged as `24f55dcb3f` (tree = dev + four version sources at `2.69.0-preview.20260928`). Push CI 36355208544 and Service lifecycle 36355270913 (dispatched, since the merge touched no service path relative to the previous preview head) passed. Release run 36356404530 succeeded. GitHub release `v2.69.0-preview.20260928`: prerelease, 25 assets. |
| Stable | #6142 merged as `3cc34e1181` (tree = dev + four version sources at `2.69.0`). Push CI 36355212673 and Service lifecycle 36355272973 (dispatched) passed. Release run 36357595961 succeeded. GitHub release `v2.69.0`: not prerelease, 25 assets; `latest.json` reports 2.69.0 with five signed platforms. |
| npm | `2.69.0-preview.20260928` published 23:11Z; `2.69.0` published 23:27Z and visible on the registry at 23:33Z. |

## Notes

- The preview push CI skipped path-gated jobs (Windows shards, macOS control and others) because the merge differed from the previous preview head only in cleanup files. The full matrix ran and passed on `870f39e75e` (run 36348371944) and on the main promotion push (run 36355212673).
- An independent plan audit (gpt-6-sol) found that the release gate needs push-event CI and Service lifecycle on each promotion SHA; that was folded into [000_plan.md](000_plan.md) before publishing.

