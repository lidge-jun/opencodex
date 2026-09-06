# Grok Build sparse terminal snapshot compatibility

Depends on composed relay stack; C3. Carry #3388 645180ceaf123c954ab5306969cf82da83566648, old base 3c920af5f7b18ecd98f87a589d21d299f5cbe172. Co-authored-by: Maple <hzlhu@qq.com> (zleo-ai). Preserve current dev f121348a9 sparse JSON function-repair fixture when resolving EOF conflict.

## Exact diff map
- MODIFY src/server/responses-snapshot-repair.ts: add createGrokResponsesSparseTerminalBlockRewrite and narrow item validators; if file exceeds existing size significantly, extract separate src/server/grok-responses-snapshot-repair.ts for Grok-only tracker while retaining existing exports. Record extraction in P before B.
- MODIFY src/server/responses/core.ts existing rewrite list: enable only logCtx.surface === grok and insert Grok terminal tracker immediately before createResponsesSnapshotBlockRewrite. Preserve current order custom-tool restore -> Copilot -> Grok -> provider snapshot -> field backfill -> function repair -> undeclared-tool guard.
- MODIFY tests/responses/responses-snapshot-repair.test.ts and responses-snapshot-repair-server.test.ts; preserve existing sparse JSON function completion inference tests.
- MODIFY structure/04_transports-and-sidecars.md and public adapters reference with client-specific boundary.

Before: Grok Build renders deltas but sees empty completed.response.output and may retry. After: only marked Grok requests reconstruct empty/missing completed output from raw unique contiguous bounded semantically validated done items. Ordinary clients and default provider responsesSnapshotRepair flag unchanged. Require nonempty call_id on reconstructed function/custom calls; incomplete/failed/contradictory/gapped/duplicate/oversized shapes remain unchanged or fail closed according to current contract. No output fabrication from deltas alone.

## Activation / verifier
Remote unit and server fixtures: Grok positive text/function/custom output, missing vs explicit-empty terminal, ordinary-client byte preservation, explicit provider snapshot + Grok coexistence, invalid item shapes/indexes/ids, duplicate/gap/bound checks, failed/incomplete terminal cannot become completed, raw done order retained. CI typecheck/privacy/runtime gates on final head; contributor reported old baseline failures are not accepted without current evidence. This is Grok Build terminal compatibility, not Cursor/Grok semantic no-progress issue #3506.

