# ADR-0069 — decision recorded under "Chat-to-Responses message phase inference"

- Contract owner: [transports/responses.md](../transports/responses.md#chat-to-responses-message-phase-inference)

## Decision record

- 목적과 의도: Prevent Codex App from rendering one bridged Chat Completions answer as both live commentary and a second persisted final answer.
- 기존 구현 및 제약 조건: openai-chat emits text deltas without phase, the bridge streamed them immediately, and whether text is pre-tool commentary or the terminal answer is unknowable until a later boundary arrives.
- 검토한 주요 대안: Mark every delta final_answer; mark every delta commentary; buffer the entire answer before emitting; infer phase only when the message is finalized.
- 선택한 방식: Keep the live added item provisional and infer commentary or final_answer at the authoritative close boundary, preserving explicit phases and item identity in done/completed output.
- 다른 대안 대신 이 방식을 선택한 이유: Eager defaults misclassify either tool preambles or final answers, while full buffering removes live streaming; close-time inference provides correct persisted semantics without adding latency.
- 장점, 단점 및 영향: Codex App receives a definitive phase for persisted bridged messages and avoids the duplicate-final rendering path; the provisional output_item.added event intentionally has no phase because its classification is not yet knowable.
