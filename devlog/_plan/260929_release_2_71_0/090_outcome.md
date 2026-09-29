# 090 Outcome: 2.71.0 released

Published 2026-09-29 (KST). GitHub releases `v2.71.0` and `v2.71.0-preview.20260929` exist with 25
assets each; npm accepted both publications with signed provenance.

Six reviewed PRs landed on dev with author credit, the Windows timeout that had turned the dev tip
red was fixed, and the whole set was released as 2.71.0 and 2.71.0-preview.20260929.

| Step | Evidence |
|---|---|
| Integration | #6224 merged to dev as d161c0e83e (merge commit). Land commits: df951bc2ee #6206 (Ingwannu), 6d7af977a4 #6201 (luvs01), 21ccf35dbe #6209 (Jio Kim), e3fcf3e43c #6094 (Brad Hallett), 2b0ac07170 #5905 (halysondev), febc16d2a4 #6198 (luvs01); follow-ups 9155880950, 7b875559dd, 917db156de, 441aeb179e. Details in 032. |
| Local regression | 022: all gates exit 0; full-suite failures proven pre-existing at dev 37ad7e771b. |
| Final CI | #6224 head dcfbb2f708: Cross-platform CI pull_request 36525839698, workflow_dispatch lane=all 36526719414 (windows 1-9), Service lifecycle 36525839767, all success; 0 failed check-runs. |
| dev pre-move | Dev version bump run 36529404555 opened #6226; its PR checks were approval-gated (bot-authored, as #6213), so the version tests and typecheck ran locally on its head 316750815c (209 pass) before `--admin --squash`; dev 69ce312097 reads 2.72.0. |
| Preview | #6227 merged as fd346e2489 (tree = candidate + four version sources at 2.71.0-preview.20260929). Push Cross-platform CI 36529530341 and Service lifecycle 36529530333 success. Release run 36531705017 success; npm `preview=2.71.0-preview.20260929`, gitHead fd346e2489, provenance attestation present. |
| Stable | #6228 merged as 8a005dd98f (tree equal to the candidate). Push Cross-platform CI 36529537253 and Service lifecycle 36529537201 success. Release run 36533478070 success; npm publish acknowledged (`+ @bitkyc08/opencodex@2.71.0`, sigstore log 2995422874); GitHub release `v2.71.0` not prerelease, 25 assets; latest.json reports 2.71.0 with 5 signed platforms. |
| Source PRs | #6206 #6201 #6209 #6094 #5905 #6198 closed with landing comments; issue #6208 closed. |

## Notes

- The pull_request event skips the Windows matrix (ci.yml:835-839); a workflow_dispatch run on the
  integration head covered windows 1-9 before merge.
- The promotion PRs' own pull_request CI runs (36529486815, 36529483354) were cancelled to free
  runners after both promotions merged; the push runs on the same trees gate the release.
- The registry smoke step warned on both releases because npm took a few minutes to serve the new
  versions; no republish was attempted.
- The installed proxy, service and desktop app on this machine were not updated.

## What did not improve / open follow-ups

- Local full `bun run test` on a loaded macOS host is not a clean signal: a claude-integration
  server test can hang and cascade into `SpendLedgerOwnerError` for the rest of its worker, and
  `tests/service/shutdown-launcher.test.ts` fails and leaves orphan proxies. Both reproduce at dev
  37ad7e771b; they deserve their own issue.
- Optional hardening noted by reviewers and not built here: a response-size cap and redirect policy
  for the Cursor manifest fetch (#5905), strict single-[3] TBS parsing in picker-ca (#6201), extra
  subprocess tests for #6209, localized copies of the cli.md priority note.

