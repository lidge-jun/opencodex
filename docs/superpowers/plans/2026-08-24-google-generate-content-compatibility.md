# Google GenerateContent Compatibility

## Goal

Fail closed on malformed or blocked Google responses, normalize adjacent user
contents, and expose a strict Google-only Responses request extension for
thinking, safety, and explicit cached-content reuse.

## Global Constraints

- Work test-first and retain RED/GREEN evidence in the SDD report.
- Preserve AI Studio, Vertex, and CCA stream/buffer parity.
- Provider extensions are strict trust-boundary input: reject unknown or
  unsupported fields/routes rather than silently dropping or forwarding them.
- The wire compiler remains allowlisted. `safetySettings` and
  `cachedContent` are top-level GenerateContent fields.
- Do not import Compatibility Lab into the core request graph.
- Preserve tool calls, thought signatures, cancellation, images, and existing
  `MAX_TOKENS` semantics.

## Task 1: Harden response termination and prompt-feedback handling

Reproduce and fix `MALFORMED_FUNCTION_CALL` success leakage for AI Studio,
Vertex, and CCA in stream and buffered paths. A malformed call emits an error
and no successful done event. Keep `MAX_TOKENS` successful without an
unfinished call and erroneous with one. When candidates are absent and
`promptFeedback.blockReason` is nonempty, emit a sanitized provider error;
candidates take precedence and absent feedback retains the generic error.

Focused verification:

- `bun test tests/google-hardening.test.ts tests/google-vertex-stream.test.ts`

## Task 2: Normalize adjacent Google user contents

Add tests for adjacent developer/user, ordinary user/user, and
function-response/user content, plus a model-turn boundary. Merge only adjacent
`role: "user"` contents by appending parts in order; never merge across a
model turn.

Focused verification:

- `bun test tests/google-empty-content.test.ts`

## Task 3: Add the strict Google provider-options extension

Add snake-case Responses schema fields under `provider_options.google` and
typed camel-case internal fields. Reject unknown keys. Validate:

- `thinking_budget`: safe integer >= -1.
- `include_thoughts`: boolean.
- At most 16 safety settings; current official category/threshold enums; no
  duplicate category.
- Cache names exactly `cachedContents/{id}` or
  `projects/{project}/locations/{location}/cachedContents/{id}`, without
  whitespace, query, or fragment.

Explicit thinking budget overrides derived thinking level; include-thoughts
augments the remaining thinking configuration. Support AI Studio and Vertex.
Reject CCA and non-Google routes before transport. Preserve
`cachedContentTokenCount` cache-read accounting and compile no other fields.

Focused verification:

- Parser/schema tests near existing Responses request tests.
- `bun test tests/google-hardening.test.ts tests/google-wire-compiler.test.ts`

## Task 4: Documentation and branch verification

Document the extension, cache resource formats, provider support, and privacy
implications. Run all focused Google suites, `bun run typecheck`,
`bun run test`, and `bun --cwd docs-site run build`. Commit the plan and
implementation on `codex/provider-google`.
