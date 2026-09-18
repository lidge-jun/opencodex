# ADR-0040 — decision recorded under "Responses HTTP/SSE"

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Stop routed models from abandoning `apply_patch` after the Codex host rejects an object argument or a decorated marker, and from blocking a turn in a shell sleep loop when the host offers `session_id` polling.
- 기존 구현 및 제약 조건: The shared nudge, Cursor guidance and native Responses instructions already carry the result-emission rule from `exec-tool-result-normalize.ts`, but none stated the helper's argument type, the marker rule, the import ban, or the polling protocol; `260905_apply_patch_envelope_gap` refused to rewrite JavaScript bodies (MODE B), so payload repair is off the table.
- 검토한 주요 대안: Repair the argument shape inside the proxy (rejected: same body ambiguity as MODE B and it turns a rejected write into a performed one); Cursor-only guidance (rejected: the incident was native routed Responses on xAI); annotate every adapter's tool results (rejected: Anthropic/Google/OpenAI-chat/command-code have no exec-result seam and would need a new one).
- 선택한 방식: One pre-call sentence and one marker→recovery table in the module that already owns the echo pair; inject the sentence at the three existing code-mode sites; annotate at the three existing exec-result seams with an exec-gated, idempotent helper that never changes error status.
- 다른 대안 대신 이 방식을 선택한 이유: The safe repair for a host contract the model broke is to state it before the call and name it after the failure; keeping both halves in one file is what keeps them consistent.
- 장점, 단점 및 영향: Code-mode system prompts grow by roughly 600 characters on routed turns; OpenAI destinations, flat catalogs and compaction requests are untouched. An exec result that legitimately prints one of the four phrases gains a recovery line, which is additive text and never an error flip. On Cursor, a structured tool literally named `exec` whose output quotes one of those phrases would also gain that line. The effect on the live Grok defect rate is unmeasured until a re-probe.
