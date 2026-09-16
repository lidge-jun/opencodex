# Cursor Provider

The configuration-only [plaintext V2 contract](../subagents.md#plaintext-v2-agent-messages)
is scoped to canonical ChatGPT Responses forwarding; other source-area behavior described here is unchanged.

Codex-native retirement does not retire a Cursor-owned model name. Cursor transport and
namespace handling retain their provider contract; the bounded native scope lives in
[the shared catalog](../catalog.md#shared-catalog).

Cursor's direct adapter does not enter the OpenAI Chat serializer's
[OpenCode Go instruction ordering](chat-compat.md#opencode-go-chronological-instructions).

Shared parsing and streaming follow the [request-copy](../transports/byte-accounting.md#request-copy-accounting) and [stream-buffer accounting](../transports/byte-accounting.md#stream-buffer-accounting) contracts.

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

In external Cursor turns using code mode or shell aliases, the bounded leading-commentary guard in `src/adapters/cursor/envelope-echo.ts` counts `Shell`, `네이티브 셸`, and `네이티브 쉘` as one `shell` identity, including spacing variants and names split across text deltas. Korean aliases require a Unicode-aware left token boundary so wording embedded in a larger word or identifier is not counted; punctuation and following Korean grammatical suffixes remain supported. Rejection still requires a failure claim plus either an explicit redirect or at least two distinct native-tool identities; repeated aliases alone do not count as multiple tools.

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

## Cursor root replay budgets

`src/adapters/cursor/protobuf-request.ts` bounds the replayed root set at 192 blobs and 512 KiB, and
caps the serialized arguments named inside one replayed tool-result envelope at 2 KiB. That per-call
cap is what keeps a 600 KiB argument from consuming the aggregate budget and evicting the output it
describes, and it still decides admission. Because it is charged while the envelope is being built,
a small replay would otherwise clip a completed call's arguments with nearly the whole envelope
unused. After every pruning and truncation decision is final, a second pass re-widens clipped
invocation lines out of the leftover aggregate bytes only: newest tool result first, skipping a root
whose own output was already elided, and never dropping, shrinking or reordering a retained root.
The elision skip is load bearing, reached through initiator recovery rather than through truncation
alone: a truncated root undershoots its own budget by far less than a restoration costs, but after
the equal-share pass elides a trailing run, recovery drops an elided sibling to fit the user turn and
the freed bytes become spare. It requires the share to land in a narrow window where the clipped
invocation line survives but `output:` does not; outside that window the clipped-line lookup declines
the root first.
Root-echo eligibility is `cursorNeedsExternalToolContinuation`, which includes native
`composer-2.5`, not only external wire models, so the restoration reaches every replay that carries
an invocation line. Coverage lives in
`tests/providers/cursor/cursor-tool-result-invocation.test.ts`.

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

Canonical Spark Lite metadata follows the final serialized model and surviving nonempty Lite tool catalog; see [Responses transport](../transports/responses.md).

Shared raw-reasoning events retain content-channel presentation; provider-authored thinking keeps its existing summary path. See [bridge contract](chat-compat.md).

Combo child requests normalize effort and thinking controls against the selected target while retaining reasoning summaries; strict unknown targets preserve caller controls. The [Responses transport owner](../transports/responses.md) documents this boundary, and native Chat removes effort only for an explicit empty declaration or no-reasoning model.

## Overflow remint boundary

`src/adapters/cursor.ts` surfaces the first bare context overflow before attempting conversation remint on later eligible requests. `cursorClientThreadOwner` recognizes both client thread aliases; `src/adapters/cursor/thread-continuity.ts` limits recovery to three remints per retained identity-scoped owner, with a one-hour idle TTL and 2,048-entry bound. Conversation-only requests have no stable owner and do not automatically remint. Quota/rate errors, tool-result resumes, partial output, local side effects, isolated helper/shadow requests and compaction remain fail-closed. Isolated requests neither consume the parent allowance nor invalidate its checkpoint. Eligible overflow checks refresh existing retention timestamps and LRU position even after the cap is exhausted, without allocating absent scopes. Retention expiry, eviction or process restart resets the in-memory allowance; this is not a persistent lifetime cap or semantic-progress policy.

Translated Chat request construction uses the [inline-image budget](../transports/streaming-health.md#translated-chat-inline-image-budget); the shared normalizer counts retained bytes even when a wire-specific drop callback keeps the image attached.

Translated audio/file admission follows the [final-adapter input contract](../adapters/registry.md#untranslated-input-media); native raw passthrough remains separate.
Canonical Responses identity sanitation and narrowly scoped pre-output combo recovery follow [request-local target compatibility](../runtime.md#request-local-target-compatibility); other adapter contracts remain unchanged.

Upstream API-key usage follows the [physical-attempt account attribution contract](../gui-and-management-api.md#upstream-key-account-attribution), independently of subscription quota observations.
