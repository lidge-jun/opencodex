# 040 — Remove Antigravity's false-429 identity paragraph

Issue #2899 is not a quota failure. A Claude Code Task subagent routed to
`google-antigravity/gemini-3.7-flash` reaches Cloud Code Assist with its complete client system
prompt, and the upstream rejects one standalone paragraph while reporting the rejection as
`RESOURCE_EXHAUSTED`:

```text
You are a Claude agent, built on Anthropic's Claude Agent SDK.
```

The controlled issue reproduction changes from 429 to 200 when that paragraph alone is absent;
tool count, output budget, thinking configuration, session identity, and concurrency do not change
the result. The release patch therefore removes the incompatible paragraph at the one destination
where it is proven harmful. It does not reinterpret 429s, rewrite Claude identity generally, or
change the system prompt sent to another Google surface or model.

The snapshot is `dev@47b8d1643`. At that head, `src/claude/inbound.ts:122-130`
(`systemToInstructions`) joins Claude system text blocks with `\n\n`, and
`anthropicToResponsesTranslation` joins the resulting `systemParts` again at lines 480-507. The
Responses parser consequently gives the Google adapter one complete client string in
`parsed.context.systemPrompt`, not one array element per original Claude block. Filtering array
elements would miss the real Task request.

## Runtime patch

`src/adapters/google.ts` owns both the shared Gemini conversion and the CCA envelope, so the
compatibility rule stays there. No parser, provider registry, retry policy, or error formatter
changes.

Add a private constant beside `GOOGLE_BREVITY_INSTRUCTION` at lines 44-55 containing the exact
paragraph above. Add a private string helper immediately before `messagesToGeminiFormat` at line
227. The helper splits on the same `\n\n` paragraph separator used by the inbound and Google joins,
filters only elements strictly equal to the constant, and rejoins with `\n\n`. It must not trim,
case-fold, use a substring match, or replace a near match: an embedded quotation or a paragraph
with any extra byte is client content and remains untouched. With no exact element, the helper
returns a byte-identical string.

Extend `messagesToGeminiFormat` at lines 227-239 with one explicit boolean saying whether this
single compatibility rewrite is active. Keep its present order: join
`parsed.context.systemPrompt`, the optional tool-catalog nudge, and
`GOOGLE_BREVITY_INSTRUCTION`; run `identifyRoutedModel`; then apply the exact-paragraph helper before
constructing `systemInstruction.parts[0].text`. This means the sanitizer sees the final text shape
that lines 741-742 currently forward, while preserving every generated instruction around the
removed client paragraph.

In `createGoogleAdapter(...).buildRequest`, lines 724-742, pass that boolean only when both
conditions are true:

```ts
provider.googleMode === "cloud-code-assist"
  && parsed.modelId === "gemini-3.7-flash"
```

The predicate uses the requested picker-visible model ID, before the CCA wire rename performed by
`resolveAntigravityEffortWireModel` at lines 725-730. Direct Gemini's own `-tiered` rename, Vertex,
other CCA models, and compatibility aliases therefore do not inherit an undocumented prompt
mutation. The existing CCA branch at lines 781-825 still adds effort, session identity, signature
handling, and the compiled envelope without knowing about the content exception.

## Regression boundary

Add a new `describe("google adapter — Antigravity system-instruction compatibility", ...)` block
to `tests/google-adapter.test.ts` after the direct/Vertex wire-rename block ending at line 474. Keep
the fixture adapter-only: the defect is request serialization, and a live CCA call would make the
test depend on credentials and an undocumented upstream filter.

The exact cases to add are:

- `removes only the rejected standalone paragraph for Cloud Code Assist Gemini 3.7 Flash (issue #2899)`
- `does not remove the rejected sentence when it is not a standalone paragraph`
- `preserves the paragraph for direct Gemini, Vertex, and another Cloud Code Assist model`

The first case builds a CCA request whose single `systemPrompt` string contains a byte-sensitive
prefix, the rejected paragraph, and a byte-sensitive suffix. It extracts
`envelope.request.systemInstruction.parts[0].text` and compares it with the full system text from an
otherwise identical control request in which only that paragraph was omitted. Equality, rather
than separate `contains` assertions, proves that the rest of the assembled prompt—including the
Google brevity instruction—is byte-identical.

The second case puts the same sentence inside a larger paragraph on the targeted CCA/model path and
asserts that the complete client string remains present. That drives the standalone-paragraph
boundary independently of the provider/model gate.

The third case runs the exact standalone paragraph through three controls: direct Gemini
`gemini-3.7-flash`, Vertex `gemini-3.7-flash`, and Cloud Code Assist `gemini-3.1-pro`. It reads the
flat body for direct/Vertex and `envelope.request` for CCA, then asserts the original client prompt
prefix is unchanged and still includes the rejected paragraph. These controls fail if the helper
is moved into shared Google conversion without the two-part gate.

The expected implementation remains below roughly 100 changed lines across
`src/adapters/google.ts` and `tests/google-adapter.test.ts`. There is no docs-site change: this is a
transparent provider compatibility repair with no new configuration or public command.

## Focused verification

During implementation, drive the new boundary directly:

```bash
bun test tests/google-adapter.test.ts --test-name-pattern "Antigravity system-instruction compatibility"
```

Then run the complete adapter file once to catch interaction with existing CCA wire-model,
identity, tool, and Vertex cases:

```bash
bun test tests/google-adapter.test.ts
```

No repository-wide local test suite is part of wp4. Final cross-platform evidence belongs to wp6
on the exact integrated head.
