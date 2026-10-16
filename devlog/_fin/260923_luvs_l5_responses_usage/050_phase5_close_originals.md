# wp6: close superseded originals

For each original: re-read its head; if it moved past the pinned SHA, re-carry first. Then close
with a short credit comment naming the bundle PR (ALREADY ON DEV names the dev commit; DROP gives
the reason). Transitive source PRs owned by other contributors (#5350, #5420, #5230, #5352) are not
closed by this lane; the bundle description credits them.

## Outcome (wp6)

All eight originals were closed on 2026-09-23 after a final head re-pin, each with a credit comment
naming #5608: #5474 (index already on dev in 74490eee36; cutoff dropped), #5305 (dropped), #5434,
#5560, #5542, #5553 (four later commits left to #5307/#5600 and #5310), #5562 and #5556. None was
merged by this lane.

#5549 was closed after the roadmap was written; its sandbox cleanup and lifecycle helper now travel
in #5597. The key-failover fixture lifecycle from `6b122cd2f0` and the documentation in
`6ea3a95c21` build on that helper and are not carried by any open PR; they can be re-offered once
#5597 lands.
