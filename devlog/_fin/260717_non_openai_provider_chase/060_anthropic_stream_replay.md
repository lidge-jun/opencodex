# WP6 — Anthropic indexed stream and tool replay

## Goal and dependency

Replace the single mutable stream-block state with per-index ownership, and harden malformed tool-argument handling only where an OCX fixture proves reachable loss.

## Diff map

| Action | Path | Before | After |
|---|---|---|---|
| MODIFY | `src/adapters/anthropic.ts` | `currentBlockType/currentToolCallId` ignore event `index` | map block state by validated non-negative index; start/delta/stop operate on matching state and clean it deterministically |
| MODIFY | `src/bridge.ts` | consumes adapter tool deltas assuming ordered events | no semantic change unless indexed fixture exposes a bridge ordering bug; then preserve tool call ids and terminality |
| MODIFY | `src/responses/parser.ts` | replay accepts tool arguments already materialized by bridge | add sanitation only if malformed captured arguments survive adapter parsing and break a later request |
| NEW | `tests/anthropic-stream-index.test.ts` | no interleaved block fixture | interleave text, thinking/signature, two tool-use blocks, duplicate/unknown stop, and post-terminal frames |
| MODIFY | `tests/anthropic-thinking-signature.test.ts` | sequential signature block proof | assert signature is attached only to the matching indexed thinking block |
| MODIFY | `tests/anthropic-reasoning.test.ts` | standard replay | drive malformed tool JSON through a full parse→bridge→replay round trip and specify degrade/fail behavior |

## Contract details

- Unknown index deltas are dropped with a bounded diagnostic, not attributed to the last block.
- Duplicate starts for a live index are an upstream protocol violation; close or replace only that index according to the audited fixture policy.
- Tool arguments remain byte-preserving while valid. Sanitation must not silently invent missing fields or turn malformed JSON into a different call.
- Disabled-thinking omission is already correct and remains untouched. The web-search sidecar's explicit disabled contract is separate.
- Anthropic organization identity is not bundled into this phase; it requires a real multi-org collision fixture.

## Activation scenarios

- Interleaved index 0 text and index 1 tool JSON emit separate, correctly ordered adapter events.
- A signature delta on index 2 cannot attach to thinking on index 0.
- Unknown/negative/non-integer indexes do not crash or corrupt another tool call.
- Malformed partial JSON follows the selected explicit outcome and a subsequent valid tool call still works.

## Verification

```bash
bun test tests/anthropic-stream-index.test.ts tests/anthropic-thinking-signature.test.ts tests/anthropic-reasoning.test.ts tests/anthropic-hardening.test.ts
bun run typecheck
```

## Terminal outcomes

- `DONE`: indexed fixtures reproduce the old loss, pass after the change, and replay stays valid.
- `NOOP`: event shape cannot interleave on the owned endpoint and no reachable loss is reproduced; retain regression evidence.
- `BLOCKED`: upstream fixture semantics remain ambiguous after official/event-source review.
- `UNSAFE`: a sanitizer would silently alter executable tool arguments without an observable error contract.
