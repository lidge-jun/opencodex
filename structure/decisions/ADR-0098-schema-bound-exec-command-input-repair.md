# ADR-0098 — decision recorded under "Schema-bound flat shell repair"

- Contract owner: [transports/responses.md](../transports/responses.md#schema-bound-flat-shell-repair)

## Decision record

- 목적과 의도: Let an unambiguous routed `exec_command` wrapper reach the Codex shell bridge without weakening tool identity or argument validation.
- 기존 구현 및 제약 조건: Freeform code-mode tools already unwrap `input`, but a genuinely declared flat function must keep its name and Codex validates it against required `cmd`.
- 검토한 주요 대안: Rename the call to code-mode `exec`; rewrite every function's `input`; add a schema-bound repair at authoritative function-call completion.
- 선택한 방식: Repair only the exact bare declaration and exact one-member string payload when the current-turn schema requires string `cmd`.
- 다른 대안 대신 이 방식을 선택한 이유: Tool names and arbitrary `input` fields are caller-owned; the original schema is the only authority that makes the representation change deterministic.
- 장점, 단점 및 영향: Buffered, streamed-completion, and replay paths converge on valid `cmd` arguments; previews and ambiguous or namespaced shapes stay untouched.
