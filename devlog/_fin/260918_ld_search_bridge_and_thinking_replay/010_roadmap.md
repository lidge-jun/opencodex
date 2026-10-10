# LD — bridged web-search replay and Anthropic thinking replay

Delivery lane R3-LD. The completion bar for this lane is not "one turn
succeeded" but "the next turn inherits exactly the same result". Local test
execution is prohibited here: every claim below is backed by source reading and
by hosted CI at an exact head.

## Units

| Unit | Item | Kind | Write scope |
|---|---|---|---|
| U1 | #4587 bridged hosted `web_search` result is not replayed to the destination | new implementation | `src/responses/bridge-search-replay-cache.ts` (new), `src/web-search/passthrough-bridge.ts`, `src/adapters/openai-responses/passthrough.ts`, `src/adapters/openai-responses/tool-output-recovery.ts`, `structure/` owner doc, one new test file plus its two layout entries |
| U2 | #4429 key-auth Responses gateway echoes hosted `web_search` as a client `function_call` | re-judge at HEAD, closure recommendation | none — assessment only |
| U3 | #3719 Anthropic thinking/`redacted_thinking` replay through proxy-auth translation | verify at HEAD, closure recommendation | none — assessment only |
| U4 | #3952, #4783, #4900 | review only, scoped | none |

U1 is the only unit that writes code. U2 and U3 are re-judged against current
source because both issue bodies predate the commits that changed the answer;
the host owns every close decision.

## U1 — #4587

### What is actually broken

`src/web-search/passthrough-bridge.ts` intercepts the destination's
`function_call` named `web_search`, runs the search proxy-side, and shows the
caller a hosted `web_search_call` cell whose id is a proxy-minted
`ws_<uuid>`. Two paths reach that state:

- `endAfterSearch` (a leg mixing the search with a client-executed tool call)
  ends the turn on that leg, so no continuation carries the result upstream.
- The ordinary continuation path does re-POST `function_call` +
  `function_call_output` to the destination through `appendBridgeSearchTurn`,
  but only inside that turn.

In both cases the caller's own history now holds a hosted `web_search_call`
item. On the next turn it replays that item, and the destination receives an
item type it never produced, with no result text and no matching
`function_call`/`function_call_output` pair. The observable effect is a wasted
round trip: the model usually searches again.

### Where the fix has to live

Not in the bridge. By the time the bridge wraps a turn, that turn's first leg
is already on the wire, so the rewrite must happen before dispatch. The
existing pre-dispatch rewrites of outbound `input` are
`backfillWebSearchQueries` and `repairOrphanedInputItems` in
`src/adapters/openai-responses/tool-output-recovery.ts`, applied from
`src/adapters/openai-responses/passthrough.ts`. The restore joins them there.

### The memo

A process-local, bounded, expiring memo records what the bridge executed:

- Key: the destination identity (the existing salted digest of the provider
  base URL from `src/responses/reasoning-replay-cache.ts`) plus the synthesized
  cell item id. The cell id is a v4 UUID this proxy mints, so it cannot collide
  across conversations; the destination scope is what stops one provider's
  executed call from being replayed into another provider's conversation.
- Value: the destination's `call_id`, its original item id, the original
  arguments text, and the executed result text.
- Bounds: entry count, total bytes, and TTL, following the discipline already
  established by the reasoning replay cache. Result text lives in memory only
  and is never logged, serialized, or exported.

### The invariant that matters most

**A memo miss is a no-op.** If the cell id is unknown, expired, or was recorded
against a different destination, the replayed `web_search_call` item is left
exactly as it is. The lane must never re-run the search to recover a lost
result, and must never synthesize result text. Re-running would bill a second
search the caller did not ask for and would answer the model with a different
search than the one its history claims; synthesizing would put words in the
destination's own mouth. Both are the easiest wrong fix available here, and
neither is permitted.

### Regression pins

1. A replayed `web_search_call` whose id is in the memo becomes the
   destination's `function_call` followed by its `function_call_output`, in
   that order, at the item's original position.
2. A replayed `web_search_call` with no memo entry is byte-identical to the
   input item.
3. An entry recorded against one destination is not restored for another.
4. An expired entry behaves exactly like a miss.
5. Providers without `webSearchBridge.enabled` allocate nothing and their
   outbound body keeps its original object identity.

## U2 — #4429

The issue asked for two things: a non-Ollama executor so a key-auth Responses
gateway can arm the bridge, and the intercepted call executed proxy-side with
the conversation continued upstream. Both shipped. The reporter's remaining
concern — the destination never learning the result — is #4587 and is U1 here.
The hosted/client distinction the issue turns on is `isWebSearchCallItem`
versus `isClientExecutedItem` in the bridge: a namespaced `ns__web_search` is
treated as a client-owned tool and is never intercepted, which is the boundary
that keeps the undeclared-tool guard's authority intact.

Closure recommendation and the evidence for it are recorded in `020`.

## U3 — #3719

The issue body states that the inbound translator drops assistant `thinking`
and `redacted_thinking` blocks. That is no longer true at HEAD:
`src/claude/inbound.ts` encodes the Anthropic signature and the opaque
redacted payloads into bounded `ocxr1` envelopes, and
`src/adapters/anthropic.ts` replays them as `redacted_thinking` blocks
followed by a signed `thinking` block.

This lane verifies that path and keeps it separate from the different question
of carrying signature data to other providers. The gate that enforces the
separation is `isLikelyRealAnthropicThinkingSignature`: a block is replayed
only when its signature looks like a real upstream-issued one, so a proxy-minted
continuity value or another provider's opaque blob is dropped rather than
forwarded as an Anthropic signature. Manufacturing a signature is out of scope
and stays that way.

The remainder of #3719 is measurement — a controlled cache creation/read
comparison across continuation turns — which this lane cannot produce under the
no-local-execution rule.

## Operating constraints

- No local test, typecheck, install, or GUI build. Verification is source
  reading plus hosted CI at the exact final head.
- No merging, no direct pushes to `dev`, no closing issues or pull requests.
  The lane ends with an open PR and exact-head CI evidence, or with a written
  closure recommendation handed to the host.
- No flake management: no widened timeouts, added retries, platform skips, or
  masking.
