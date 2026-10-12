# 090 Outcome (wp3): release 2.70.0

Published 2026-09-29 (KST). npm `latest=2.70.0`, `preview=2.70.0-preview.20260929`.

| Step | Evidence |
|---|---|
| Change | #6210 (Claude Sonnet 5.5 catalog, pricing and request contract) admin-merged to dev as `c34c4d20db` at the owner's request, before its PR CI finished. |
| dev pre-move | Dev version bump run 36475209662 opened #6213; merged as `034e787164` (four version sources 2.70.0 -> 2.71.0). |
| Preview | #6211 merged as `aa3a8dda16` (tree = candidate + four version sources at `2.70.0-preview.20260929`). Push Cross-platform CI 36475459900 and Service lifecycle 36475459622 passed. Release run 36480301229 succeeded; GitHub release `v2.70.0-preview.20260929` is a prerelease with 25 assets. |
| Stable | #6212 merged as `53834ff47b` (tree equal to the candidate). Push Cross-platform CI 36475469901 and Service lifecycle 36475469997 passed. Release run 36480501878 succeeded; GitHub release `v2.70.0` is not a prerelease, 25 assets; `latest.json` reports 2.70.0 with five signed platforms. |
| npm | publish jobs succeeded 21:04Z (preview) and 21:13Z (stable); both dist-tags confirmed on the registry. |

## Notes

- The PR CI for #6210 (run 36474873578) and a redundant dispatch on the candidate (36474965294) were
  cancelled to free runners once the promotion push runs were queued; the main promotion tree equals
  the candidate, so its push CI covers the same tree.
- The installed proxy, service and desktop app on this machine were not updated.
