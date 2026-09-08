# Six-item bug stack — completed delivery

All five new product PRs merged into `dev` on 2026-09-08. The sixth source item, #3965, had independently landed and required no duplicate PR. [071](071_delivery.md) records verification and retained failure history; [072](072_final_proof.md) records actual landing proof.

| Source | Delivery | Disposition |
| --- | --- | --- |
| #3838 Go placement/stateless residual | #3986 | Landed; source closed; lossy mixed-ciphertext filtering declined |
| #3907 xAI string child result | #3991 | Landed; issue completed |
| #3944 V2 proxy guidance | #3992 | Landed; source closed |
| #3951 server-owned delegation preset | #3993 | Landed; source closed |
| #3965 canonical operation alias | Existing merge402be7c1f | Verified landed NOOP for another PR |
| #3973 cooldown recovery, consolidated #3995 | #4002 | Landed; issue completed and source PR closed |

This was one ordinary manual chain. Children were retargeted to dev before their parents merged because repository settings automatically delete merged branches. Original authorship and Co-authored-by trailers were preserved. #3997/#3996 remain outside this delivery.

The earlier decade documents are historical plans and audit amendments. Their future-tense steps describe what was required at that point; this outcome and the final ledger are authoritative for completion. The work used repeated PABCD cycles and independent Astra high source/security reviews.

Local product tests, installs, typechecks and builds: **NOT RUN**, by owner instruction. Commits disabled hooks per invocation and pushes used --no-verify. Hosted CI, synthetic dashboard observation and isolated remote documentation builds supplied verification. No release, deployment, main/preview promotion, live account operation or reset credit was used. All 30 pre-existing user files were preserved.
