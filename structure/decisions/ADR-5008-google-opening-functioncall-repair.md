# ADR-5008 — decision recorded under "Google opening functionCall repair"

- Contract owner: [providers/google.md](../providers/google.md#google-opening-functioncall-repair)

## Decision record

- 목적과 의도: stop a history truncated to an assistant tool call from reaching the Google wire
  as an opening `model` `functionCall` turn, which Antigravity rejects with HTTP 400
  "function call turn comes immediately after a user turn or after a function response turn".
- 기존 구현 및 제약 조건: `messagesToGeminiFormat` repaired every adjacency boundary except the
  request head: it batched a call turn's results, degraded orphans to marked text, and guarded a
  model tail with a user `"(continue)"` nudge, but had no rule for an opening call turn. A
  `functionResponse` turn is also invalid without its call turn, so dropping the head turn would
  only move the violation to the following turn.
- 검토한 주요 대안: drop the opening orphan model turn; convert its call to orphan text; prepend
  a synthetic user turn; repair the shared internal history instead of the wire boundary.
- 선택한 방식: prepend a user `"(continue)"` nudge when the first compiled turn is `model`
  carrying a `functionCall`, scoped to exactly the demonstrated `call-turn-opens-request`
  violation class.
- 다른 대안 대신 이 방식을 선택한 이유: dropping or rewriting the head turn loses the call or
  orphans its response batch, while a synthetic user turn preserves the call, its signature, and
  the paired response unchanged. The same repair already exists for assistant-head turns in
  `src/adapters/kiro/payload.ts`, and shared-history mutation would change other adapters.
- 장점, 단점 및 영향: truncated heads become provider-valid with no information lost, and every
  previously valid request is byte-shape identical. A model head carrying only text is
  deliberately out of scope — no upstream rule against it is demonstrated, and a broader guard
  would inject a turn into requests the upstream accepts.
