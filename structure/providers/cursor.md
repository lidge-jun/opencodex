# Cursor Provider

## Cursor Native Exec

Cursor's experimental live transport can receive server-driven local read/write/delete/ls/grep,
shell, and fetch exec frames. These frames are denied by default because they bypass Codex's normal
approval and sandbox path. `nativeLocalExec: "on"` is the explicit config-owner opt-in for trusted
local experiments; `off` and the backwards-compatible `codex-sandbox` spelling both fail closed.
MCP, screen recording, and computer-use stay on their separate explicit executor/MCP config paths.

> Decision record: [ADR-0047](../decisions/ADR-0047-cursor-native-exec.md)

Cursor's generic tool-use prompt filter must preserve every Responses-owned execution-path tool
that survives the transport budget: unified Desktop `exec` as well as the legacy
`exec_command`/`shell_command` aliases. The legacy aliases receive Cursor-specific shell guidance;
unified `exec` keeps its own schema and is surfaced back to Codex as a client tool. It must never
fall through to the separate native-local-exec dispatcher.

> Decision record: [ADR-0048](../decisions/ADR-0048-cursor-native-exec.md)

## Cursor parameterized models

Cursor Router's parameterized `default` model is represented in Codex by four catalog rows:
`cursor/auto` preserves Cursor's team/account default, while `cursor/auto-cost`,
`cursor/auto-balance`, and `cursor/auto-intelligence` make each optimization level explicit.
All four route to the `default` Cursor wire model. Explicit variants additionally populate
`AgentRunRequest.requested_model.parameters` with the `optimization` parameter; this is the same
parameterized-model channel used by current Cursor clients. Router rows are static capabilities and
must survive a live `GetUsableModels` response that omits `default`.

`cursor/grok-4.5-fast` and `cursor/grok-4.6-fast` are stable Codex-facing rows, but current Cursor
clients do not request them as flat model slugs. OpenCodex sends the matching Grok base id through
`requested_model` with separate `effort` and `fast=true` parameters, leaving legacy `model_details`
unset for that parameterized external selection. Grok 4.5 stops at `high`; Grok 4.6 additionally
advertises and sends `xhigh`. Live discovery recognizes Cursor's flattened
`cursor-grok-{version}-{effort}-fast` variants, plus the older
`grok-{version}-fast-{effort}` ordering, as availability evidence only.

## Cursor active-context usage

Cursor's `conversationCheckpointUpdate.tokenDetails.usedTokens` is treated as the authoritative
absolute active-context size for a Cursor conversation. Some client-tool suspension turns must end
before Cursor emits a new checkpoint; those turns carry forward the last observed total for the same
Cursor conversation instead of reporting only the tiny current-turn output delta. The carry-forward
cache is process-local, numeric-only, bounded, and keyed by Cursor conversation id. Compaction
boundaries clear the carry so pre-compaction totals are not reused after Codex replaces history.
Historical compaction markers restored by `previous_response_id` expansion are acknowledged as a
replayed prefix and do not clear a fresh post-compaction checkpoint again on every later turn.
Compaction summarizer turns may still report their own checkpoint for that response, but their
pre-compaction checkpoint is not persisted for later carry-forward.

> Decision record: [ADR-0053](../decisions/ADR-0053-cursor-active-context-usage.md)

## Cursor conversation checkpoint reuse

After a successful no-tool turn, the Cursor adapter keeps the returned ConversationStateStructure in
a process-local store and reuses that snapshot on the next validated linear continuation instead of
rebuilding rootPromptMessagesJson and conversationTurns. Tool-result turns reuse the last completed
checkpoint plus only the uncovered suffix. A request without checkpointRef may use the prefix index
only when a remembered Cursor conversation or stable client thread owns the resolved conversation id.
The stable owner may be the Codex parent-thread header or the existing bounded process-local HMAC of
the complete Desktop session-id/thread-id pair. The request must also have a covered message prefix
and system/developer digest that match exactly one snapshot for that same
conversation. Headerless requests without a stable owner full-replay. Isolated helper/shadow turns
never join the parent or sibling conversation. An explicit missing checkpointRef full-replays. Compaction, account or model mismatch, missing refs, decode failures, and
invalid_argument recovery keep the existing full-replay path. previous_response_id may select a
branch's opaque checkpointRef; it is never a Cursor conversation ownership key. Cursor Connect still
does not expose authoritative cache_read_tokens.

> Decision record: [ADR-0054](../decisions/ADR-0054-cursor-conversation-checkpoint-reuse.md)

## Cursor executable tool schema ownership

`src/adapters/cursor/tool-schemas.ts` owns advertised and argument-normalization
schemas; `tool-definitions.ts` remains the public facade and protobuf encoder.
Advertisement and normalization intentionally differ for shell bridges: Cursor may
emit `cmd`, while the declared Responses contract decides whether it becomes
`command`. Both paths preserve execution-control fields. Freeform tools use one
required string `input` in a closed object, retaining that tool's string-valued
input description from the parser (including patch-envelope guidance). Other input
constraints cannot widen the canonical shape. Bare shell bridge names are rejected
on the freeform path.
Namespaced tools do not acquire bare-shell behavior. Regression coverage lives in
`tests/providers/cursor/cursor-tool-definitions.test.ts`.
