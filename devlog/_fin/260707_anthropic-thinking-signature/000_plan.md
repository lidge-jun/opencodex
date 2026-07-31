# Work-phase 2: Anthropic thinking-signature round-trip (260707)

## Problem (docs-verified, platform.claude.com Extended thinking)
1. Anthropic requires the last assistant turn in a tool-use cycle to carry its
   `thinking`/`redacted_thinking` blocks WITH the original `signature` when extended
   thinking is enabled. Modified/missing blocks -> 400
   ("Expected `thinking` or `redacted_thinking`, but found `tool_use`").
2. Streaming delivers the signature as a `signature_delta` inside `content_block_delta`
   just before `content_block_stop`.

## opencodex current state
- src/adapters/anthropic.ts parseStream handles text_delta/thinking_delta/input_json_delta
  ONLY — `signature_delta` never captured; `redacted_thinking` blocks never surfaced.
- bridge.ts emits reasoning items with no encrypted_content -> Codex replays reasoning
  without any signature.
- parser.ts reasoning branch sets signature: JSON.stringify(reasoning) (fake), which
  isLikelyRealAnthropicThinkingSignature correctly rejects -> ALL thinking blocks dropped
  on replay -> assistant tool_use turns replay signature-less while thinking is enabled.

## Design (ocxr1 envelope through Codex's encrypted_content slot)
codex-rs Reasoning { encrypted_content: Option<String> } round-trips whatever we emit.
- anthropic.ts parseStream: capture `signature_delta` -> new AdapterEvent
  { type: "thinking_signature", signature }; capture content_block_start
  `redacted_thinking` (block.data) -> AdapterEvent { type: "redacted_thinking", data }.
- types.ts: add both event variants.
- bridge.ts (SSE + buildResponseJSON): hold the latest signature/redacted payloads for
  the OPEN reasoning item; on close, attach `encrypted_content: "ocxr1:" + base64(JSON
  {sig?, red?[]})` to the reasoning output item. hideThinkingSummary must NOT discard
  the signature: when summary is hidden but a signature exists, still emit the reasoning
  item (empty summary) so the envelope survives (no visible text leak).
- schema.ts reasoningItemSchema: + encrypted_content: z.string().optional().
- parser.ts reasoning branch: decode ocxr1 envelope -> thinking part carries REAL
  signature (and redacted blocks list); non-ocxr1 encrypted_content (native OpenAI) is
  ignored as today.
- types.ts OcxThinkingContent: + redacted?: string[] (raw redacted_thinking data).
- anthropic.ts buildRequest assistant branch: replay redacted blocks as
  { type:"redacted_thinking", data } and thinking with real signature (existing gate
  isLikelyRealAnthropicThinkingSignature stays as final validity check).
- Non-goals: google thoughtSignature path (already handled separately);
  openai passthrough (sanitizeReasoningInputContent already strips routed reasoning
  content for native — must ALSO not leak ocxr1 envelopes to native backend: extend
  that scrub to drop ocxr1 encrypted_content).

## Risks
- Codex may omit encrypted_content replay when reasoning.include is absent -> degrade
  to today's behavior (blocks dropped), no regression.
- Envelope must never reach Anthropic wire as-is (signature validation) — parser decodes
  it before adapters see it; passthrough scrub covers native forwarding.

## Verification
bun test ./tests/ && bun x tsc --noEmit; new tests: anthropic signature capture (stream
fixture), bridge envelope emission, parser decode, anthropic replay w/ redacted blocks,
passthrough scrub of ocxr1.

## Closed (260707)

Shipped in commit 4a59dbc: parseStream signature_delta/redacted_thinking capture
(block-scoped), bridge ocxr1 envelope (SSE+JSON, hideThinkingSummary envelope-only
item with txt), schema encrypted_content, parser decode, anthropic replay
(redacted before thinking), passthrough ocxr1 scrub. All three gpt-5.5 audit
fixes incorporated. Verification: bun test 1567 pass / 0 fail, tsc exit 0.
