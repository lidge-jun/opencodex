# 260714 Item ID Passthrough Hardening

## Root Cause Chain

Four distinct item-ID bugs surfaced today when subagents running through the
opencodex proxy (gpt-5.6-sol via ocx port 10100) hit upstream 400/404 errors
on the Responses API. All share the same mechanism: opencodex generates or
preserves item IDs that violate OpenAI's per-type prefix validation, then
replays them in `input[]` on subsequent turns via `previous_response_id`
local-state expansion.

### Bug 1 — agent_message UUID leak (693e8a46)

`sanitizeEncryptedContentInPlace()` converts incoming `agent_message` items to
`{type: "message", role: "user"}` but did not delete the harness-assigned
UUIDv7 `id` (e.g. `019f5e7f-...`). OpenAI rejects non-`msg_` IDs on message
items.

Fix: delete `message.id` during conversion + defense-in-depth
`stripInvalidMessageIds` in the passthrough adapter.

### Bug 2 — custom_tool_call / tool_search_call prefix mismatch (d456ea62)

`bridge.ts` minted `fc_` prefix IDs for ALL tool call types. OpenAI validates
per-type: `custom_tool_call` requires `ctc_`, `tool_search_call` requires
`tsc_`, only `function_call` uses `fc_`.

Fix: type-aware prefix selection in both streaming and non-streaming bridge
paths. Extended the passthrough sanitizer from message-only to a type-aware
`stripInvalidItemIds` covering 5 verified types.

### Bug 3 — web_search_call provider-native ID (da236d0d)

`web_search_call` items used the provider-native event ID (`call_*`, `toolu_*`)
directly. OpenAI expects `ws_` prefix.

Fix: mint `ws_${uuid()}` for web_search_call items, track `eventId` separately
from `itemId` for begin/end matching. Added `web_search_call: "ws_"` to the
sanitizer.

### Bug 4 — store=false reasoning ID 404 (869d7ead)

When `store=false`, OpenAI does not persist response items. Any item ID
forwarded in `input[]` is interpreted as a reference to a stored item that
does not exist → 404. opencodex's local continuation cache (`force` bypass)
stores items despite `store=false`, then replays them with IDs intact.

Fix: `stripItemIdsWhenUnstored` strips ALL item IDs when `store === false`,
matching codex-rs behavior (`core/src/client.rs:918-925`).

## Authoritative Prefix Map

Source of truth: codex-rs `core/src/session/mod.rs:2801-2818`.

| Item type               | Prefix  | opencodex generates? |
|--------------------------|---------|----------------------|
| Message                  | `msg_`  | Yes (bridge.ts)      |
| Reasoning                | `rs_`   | Yes (bridge.ts)      |
| FunctionCall             | `fc_`   | Yes (bridge.ts)      |
| CustomToolCall           | `ctc_`  | Yes (bridge.ts)      |
| ToolSearchCall           | `tsc_`  | Yes (bridge.ts)      |
| WebSearchCall            | `ws_`   | Yes (bridge.ts)      |
| Compaction               | `cmp_`  | Yes (bridge.ts)      |
| FunctionCallOutput       | `fco_`  | No                   |
| CustomToolCallOutput     | `ctco_` | No                   |
| ToolSearchOutput         | `tso_`  | No                   |
| LocalShellCall           | `lsh_`  | No                   |
| ImageGenerationCall      | `ig_`   | No                   |
| AgentMessage             | `amsg_` | No                   |
| AdditionalTools          | `at_`   | No                   |

## Defense-in-Depth Architecture

The passthrough adapter pipeline (right-to-left execution):

```
scrubOcxCompactionItems
  → sanitizeReasoningInputContent
    → stripUnsupportedHostedTools
      → stripInvalidItemIds (type-aware prefix validation)
        → stripItemIdsWhenUnstored (store=false blanket strip)
          → JSON.stringify → upstream
```

- `stripInvalidItemIds`: validates 6 types (msg_, rs_, fc_, ctc_, tsc_, ws_);
  strips IDs that don't match their type's expected prefix. Unknown types pass
  through unchanged (conservative).
- `stripItemIdsWhenUnstored`: when `store === false`, strips ALL item IDs
  regardless of type. `call_id` pairing is unaffected.

## Known Limitations (out of scope for this pass)

1. **`/v1/responses/compact` bypasses the sanitizer pipeline** — the compact
   endpoint forwards raw bodies directly. A future hardening pass should apply
   the same ID sanitization there.
2. **Provenance-mixed replay** — locally minted IDs with correct prefixes
   (e.g. `fc_<uuid>` from bridge) are indistinguishable from server-issued IDs
   when `store` changes between turns. The current `store=false` blanket strip
   mitigates the common case but doesn't cover `store:true` turns replaying
   `force`-cached `store:false` history.
3. **Multi-user cache isolation** — the replay cache is keyed by response ID
   only, not by client/account. Relevant for shared deployments (#95).
4. **Shallow reference mutation** — state.ts stores items by reference; the
   encrypted-content sanitizer mutates items in place, affecting cached copies.

## Hardening Audit (sol-high, 4 parallel agents)

- **Bridge ID surface**: PASS — all 20 generation points match codex-rs map.
- **Sanitizer pipeline**: No HIGH — ordering correct, no bypass on main path.
- **State replay**: 1 HIGH (multi-user, #95 scope), 2 MEDIUM (provenance, miss).
- **docs-site translations**: 2 HIGH content omissions, broken links, terminology
  drift — documented in 010_docs_translation_audit.md.
