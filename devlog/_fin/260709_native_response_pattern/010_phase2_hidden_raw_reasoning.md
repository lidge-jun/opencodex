# WP2 — raw reasoning honors hideThinkingSummary (diff-level)

## Scope
- MODIFY src/bridge.ts: streaming `reasoning_raw_delta` case + non-streaming `flushRawReasoning`.
- NEW tests/bridge-raw-reasoning-hidden.test.ts (+ replay assertion).
- OUT: visible-mode raw shape (unchanged), anthropic path, adapters, catalog, gui.

## Diffs
1. bridge.ts streaming: add `let hiddenRawReasoningText = "";` beside hiddenThinkingText.
   `case "reasoning_raw_delta"`: first line guard
   `if (options?.hideThinkingSummary) { hiddenRawReasoningText += event.text; break; }`.
   Flush: emit an envelope-only reasoning item
   (`{type:"reasoning", id, summary: [], encrypted_content: encodeReasoningEnvelope({ txt })}`,
   output_item.added + output_item.done back-to-back, no text deltas) — carrier for
   preserveReasoningContentModels replay; the app renders nothing (empty reasoning = no
   barrier, diagnosis fact 1). Flush sites: mirror closeCurrentRawReasoning barriers
   (message/tool/summary-reasoning opens) plus terminal completion, whichever B finds are
   the real call sites; multiple envelope-only items per turn are acceptable.
2. bridge.ts non-streaming `flushRawReasoning`: when `options?.hideThinkingSummary === true`,
   push the envelope-only item instead of the visible `content[reasoning_text]` item.
3. Envelope: reuse ReasoningEnvelope.txt (exists; parser.ts:301 already decodes
   encrypted_content -> thinking for replay). Verify decode path maps txt -> OcxThinkingContent
   and openai-chat replay serializes it via preserveReasoningContentModels reasoning_content.

## Accept criteria / activation scenarios
- Hidden streamed: events contain NO response.reasoning_text.delta and NO reasoning item with
  content[]; exactly the envelope-only reasoning item(s) plus untouched function_call sequence;
  decodeReasoningEnvelope(item.encrypted_content).txt round-trips the raw text.
- Visible streamed (flag false): byte-identical current behavior (regression test).
- Hidden + visible non-streaming twins via buildResponseJSON.
- Replay: parseRequest on history containing the envelope-only item yields assistant thinking
  content; openai-chat buildRequest with a preserveReasoningContentModels provider emits
  reasoning_content for that message.
- Live glm-5.2 probe (WP3): with summary none, stream shows no reasoning_text.delta.
