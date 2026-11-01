# ADR-8071 — decision recorded under "Kiro structured output"

- Contract owner: [providers/kiro.md](../providers/kiro.md#kiro-structured-output)

## Decision record

- 목적과 의도: Let Kiro-routed turns that request structured output succeed with valid JSON instead of being refused, while keeping the guarantee that a caller expecting JSON never receives prose.
- 기존 구현 및 제약 조건: `validateKiroCapabilities` threw on `_structuredOutput`, so every json_schema/json_object turn failed locally with HTTP 400 and sendCount 0. T3 Code titles each thread through a Messages `output_config.format` request and Claude Code issues its own structured-output calls, so no Kiro thread got a title. The CodeWhisperer wire has no schema-constrained response mode, but it carries tool input schemas, and the adapter already had a private terminal tool, `codex_kiro_final_answer`, with a bounded `text_fallback` retry.
- 검토한 주요 대안: Keep refusing; prompt-only emulation like `src/adapters/cursor/structured-output.ts`, relaying whatever text arrives; add a structured-output tool beside the completion tool; replace the completion tool with a structured-output tool whose input schema is the caller's schema, validate its input, and accept JSON-only text with one bounded retry.
- 선택한 방식: Replace the completion tool with `codex_kiro_structured_output`, force completion mode `required`, relay the validated tool input as final-answer text, accept clean-stop text that is itself the JSON, retry once on prose or an invalid input, and fail with `invalid_kiro_structured_output` after that. Held prose is dropped on every structured-output path.
- 다른 대안 대신 이 방식을 선택한 이유: A tool input is JSON by construction and its schema is the caller's format, which a prompt alone does not give; relaying unvalidated text would break the promise the refusal existed to keep. Advertising both tools would offer the model a prose exit. Accepting JSON-only text avoids paying a second request for a correct answer delivered without the tool.
- 장점, 단점 및 영향: Structured-output turns on Kiro now succeed, and failures stay explicit errors. Validation is light (parse, root type, root `required` keys), so a value that violates a deeper schema constraint can still pass. A turn can cost two upstream requests. Kiro's acceptance of every caller schema shape as a tool input schema is verified only by sanitization, not live.
