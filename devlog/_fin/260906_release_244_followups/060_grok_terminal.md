# Grok Build sparse terminal snapshot compatibility

Depends on composed relay stack; C3. Carry #3388 645180ceaf123c954ab5306969cf82da83566648, old base 3c920af5f7b18ecd98f87a589d21d299f5cbe172. Co-authored-by: Maple <hzlhu@qq.com> (zleo-ai). Preserve current dev f121348a9 sparse JSON function-repair fixture when resolving EOF conflict.

## Exact diff map

- MODIFY src/server/responses-snapshot-repair.ts: add createGrokResponsesSparseTerminalBlockRewrite and narrow item validators; if file exceeds existing size significantly, extract separate src/server/grok-responses-snapshot-repair.ts for Grok-only tracker while retaining existing exports. Record extraction in P before B.
- MODIFY src/server/responses/core.ts existing rewrite list: enable only logCtx.surface === grok and insert Grok terminal tracker immediately before createResponsesSnapshotBlockRewrite. Preserve current order custom-tool restore -> tool-search restore -> Copilot -> Grok -> provider snapshot -> field backfill -> function repair -> undeclared-tool guard.
- MODIFY tests/responses/responses-snapshot-repair.test.ts and responses-snapshot-repair-server.test.ts; preserve existing sparse JSON function completion inference tests.
- MODIFY structure/04_transports-and-sidecars.md and public adapters reference with client-specific boundary.

Before: Grok Build renders deltas but sees empty completed.response.output and may retry. After: only marked Grok requests reconstruct empty/missing completed output from raw unique contiguous bounded semantically validated done items. Ordinary clients and default provider responsesSnapshotRepair flag unchanged. Require nonempty call_id on reconstructed function/custom calls; incomplete/failed/contradictory/gapped/duplicate/oversized shapes remain unchanged or fail closed according to current contract. No output fabrication from deltas alone.

## Activation / verifier

Remote unit and server fixtures: Grok positive text/function/custom output, missing vs explicit-empty terminal, ordinary-client byte preservation, explicit provider snapshot + Grok coexistence, invalid item shapes/indexes/ids, duplicate/gap/bound checks, failed/incomplete terminal cannot become completed, raw done order retained. CI typecheck/privacy/runtime gates on final head; contributor reported old baseline failures are not accepted without current evidence. This is Grok Build terminal compatibility, not Cursor/Grok semantic no-progress issue #3506.


## Current composition and module decision

Base: verified combo #3754 at 1697a7748. Source #3388 remains 645180cea.
The existing snapshot module is 621 lines; the source adds 327 lines for a
separate client policy. Keep the provider policy stable and put the Grok tracker
in new src/server/grok-responses-snapshot-repair.ts. Extract only the existing
isPlainObject, jsonBlock and RetainedOutputItem into a leaf
src/server/responses-snapshot-codec.ts so both trackers share their wire codec.
Core and Grok tests import the new tracker directly; existing public snapshot
exports stay unchanged and no convenience re-export or circular edge is added.
The tracker imports the existing relay retention limits, SSE block type/parser
and budget type. The codec imports nothing. This local functional dependency
replaces duplication; the stream order is an explicit temporal dependency.

Keeping everything in the old file would mix two different opt-in contracts and
push it near 950 lines. A broad provider-tracker refactor is also rejected. The
old module remains above the default size limit but shrinks without behavioral
changes; the new tracker stays below 400 lines. Its stateful closure remains one
cohesive retention owner. The source/test carry exceeds 500 lines because its
regression matrix must land with the behavior, not as an untested upper layer.

Keep the source Grok describe as one top-level block before the existing provider
snapshot describe; do not split the latter. Preserve the current server file's
f121348a9 sparse JSON/function-repair EOF fixture. Add missing/empty/whitespace
call_id negatives for function/custom calls, a valid custom call alongside a
visible message, and a same-provider absent-marker/marker=1 server control.

x-opencodex-grok: 1 is a client-selected compatibility opt-in, not authenticated
client identity. Do not add authentication or infer privileges from it. Public
adapters documentation must describe that boundary. No live Grok or Kiro probe
is required for this synthetic protocol repair.

## Asynchronous verification

The user directed CI to run after implementation asynchronously. Close this
implementation cycle after source audit, attributed PR and exact-head CI queue
verification, then proceed to the next unit. c-grok-terminal remains open until
hosted runtime CI succeeds; release convergence owns that unchanged criterion.
Do not merge or publish an unverified head. No local suites/typecheck/build.
