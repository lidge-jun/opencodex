# 011 — wp2/wp3 evidence: dispatch rounds and reviewer verdicts

## Dispatch 1 — 33595585136 on e1acb7f7a (ACL lifecycle + fsync + fixtures, before review fixes)

| shard | before (33590540220) | after |
|---|---|---|
| windows 1/4 | ~120 fails, account-store/auth-api cascades | 8 fails: service.test ×7 (real icacls given a synthetic SID → EICACLS), issue-702 ×1 (unlinked an unpublished async spill) |
| windows 2/4 | ~100 fails | 2 fails: responses-state budget case (gate swallowed the snapshot harden → 30 s ACL deadline → 60 s ceiling), write-failure case (copy fallback keyed on process.platform) |
| windows 3/4 | ~40 fails | 1 fail: native-profile-manager first-child boot > private 5 s wait |
| windows 4/4 | cancelled | cancelled by the shard-1 gate |

Linux test 3/4 failed once on `late async spill completion` (ETIMEDOUT from the shared ACL budget);
passes 6/6 locally and on the dev push run — treated as the same gate-swallowed-snapshot-harden
mechanism, fixed by `isSpillAclTarget`.

## Dispatch 2 — 33597649234 on 079bec4e0 (all of the above fixed)

windows 1/4 SUCCESS, 2/4 SUCCESS, 3/4 SUCCESS — first Windows-green shards on any branch since
33290817128 (2026-08-30). windows 4/4 cancelled at the 25-minute job ceiling with ZERO test
failures: 199 files done at 06:27:35 (started 06:10:46), then the log ends inside
`responses-native-main-refresh.test.ts` — 8 minutes with no output. The same file passes in
~1.5 s in isolation on the Windows desktop (`desktop-c795oh4`, bun 1.3.14). Shard 4 also carries
`codex-composed-acceptance` (299 s) and `native-profile-startup` (80 s). Investigation: full
shard 4 run on the desktop, log at `C:\Temp\ocx-shard4b.log`.

## Reviewer rounds (read-only, sol/high)

- Lovelace on d0feec0ad..ae6212463: FAIL — P2 flush skipped when an earlier finalizer rejects;
  P3 time-based pending oracle. Fixed in 1c41988ad (finally + rejected-release regression, driven red).
- Hooke on origin/dev..079bec4e0 (8 commits): FAIL — P2 admission suite pinned to the sync lane
  lost Windows coverage of runPendingResponseSpill; P3 assert the propagated rejection message.
  Fixed in 384090052 (two win32 admission variants after queue settle; message asserted).
  Confirmed safe: "r+" callers, isSpillAclTarget equivalence, windowsSecretAclApplies() ==
  process.platform in production, service.test stub masks nothing, no AGENTS/privacy/Lab violation.

## fuck-powershell

56e1801 async-child-holds-dir-after-stop (87→88), 2f2107d fsync-readonly-handle-eperm +
file-url-pathname-drive-slash (88→90). Graph 313 nodes / 643 edges, validate OK.
