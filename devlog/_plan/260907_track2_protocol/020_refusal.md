# Preserve refusal across Chat projections

Depends on 010 for JSON-to-SSE field delivery. Class C3 public wire contract.

## File delta

- MODIFY src/chat/outbound.ts: responsesJsonToChatCompletion accumulates content parts with type refusal and their refusal string into message.refusal, alongside existing content/reasoning/tool fields.
- MODIFY same file live translator: map response.refusal.delta to delta.refusal. Track each output/content part separately with the existing translator budget. Final response.refusal.done, content_part.done, output_item.done and completed/incomplete snapshots may add only an unseen matching suffix. Repeated final representations must not duplicate text. Conflicting snapshots cannot be represented as append-only deltas and must terminate as a typed translation failure, not false success. Map storage and release follow existing turn-budget lifecycle.
- MODIFY collectChatCompletion: collect delta.refusal with retained_collectors budget and serialize message.refusal. Never coerce refusal into ordinary assistant answer text.
- NEW tests/responses/chat-refusal.test.ts (register both test-layout inventories): cover direct JSON, split live deltas plus all snapshot representations, done-only, terminal-only, multiple parts, mixed text/refusal, stream collection, contradictory snapshot failure, cancellation/overflow, and JSON-to-SSE handler path inherited from 010.
- MODIFY proxy-formats.md and structure/04_transports-and-sidecars.md: document refusal field and parity across delivery shapes without claiming a new policy decision.

## Independent oracle and acceptance

OpenAI Responses docs define refusal.delta.delta and refusal.done.refusal, indexed by output_index/content_index; official Chat SDK defines delta.refusal and message.refusal. Local official Codex corpus is read only for consumer behavior; it is not automatically the sole Chat API schema authority.

Trigger known refusal events/parts, expect exactly one concatenated refusal, unchanged normal content/tool semantics, one terminal+DONE on valid completion, typed failure without success DONE on invalid final snapshot or overflow. Tests use inert fixture messages rather than provoking live model refusals. No local suites run; remote final CI owns executable proof.
