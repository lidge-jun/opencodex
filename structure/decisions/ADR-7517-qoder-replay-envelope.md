# ADR-7517 — decision recorded under "Coding-agent tool ownership"

- Contract owner: [qoder.md](../clients/qoder.md)

## Decision record

- 목적과 의도: Prevent Qoder assistant output from exposing OpenCodex's own history-replay tool envelopes as a successful answer.
- 기존 구현 및 제약 조건: The Qoder-specific vendor guard recognizes XML-like CLI scaffolding, while the shared coding-agent replay emits bracketed call/result envelopes. The existing line/fence-aware envelope filter already owns that second grammar for other transports.
- 검토한 주요 대안: Duplicate marker strings in the vendor scanner, modify every coding-agent parser, silently truncate the answer, or compose the existing envelope filter at Qoder's output boundary.
- 선택한 방식: Run vendor-cleaned assistant text through the shared envelope filter, settle it before terminal events and before every other non-heartbeat event, and use Qoder's existing non-retryable 502 refusal on matched or unverified envelope output. Keep native tool events and the existing reasoning guard separate. Each settled boundary starts a fresh filter, so the next text block is scanned from a line start.
- 다른 대안 대신 이 방식을 선택한 이유: Reuse preserves split-marker, whole-line, quoted-example and bounded-hold semantics without widening unrelated adapters or maintaining a second marker grammar. A failed answer is explicit rather than an empty successful completion or a hidden billed retry.
- 장점, 단점 및 영향: Ordinary text and proven closed examples survive. An overflowing unverified fenced hold is refused before publication, so a very large unclosed example may fail conservatively. Upstream errors still take precedence when a marker is recognized only at terminal flush. This does not alter CLI resolution, image capability, tool execution or historical request logs.
