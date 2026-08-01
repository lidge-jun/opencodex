# Phase 120 (P1-1) - Tool schema sanitization

## Problem

`convertTools()` currently passes tool JSON Schema through directly:

```ts
inputSchema: { json: (t.parameters ?? {}) }
```

kiro-gateway strips schema fields Kiro rejects, especially:

- `additionalProperties`
- empty `required: []`

Without this, valid Codex/OpenAI-style tool schemas can become Kiro 400s.

## Scope

This phase closes schema sanitization only. It also moves tool conversion out of
`kiro.ts` because that file is already at the 500-line limit.

Out of scope for this phase:

- long tool description -> system prompt movement
- orphaned toolResult / no-tools fallback

Those remain P1 follow-up phases.

## File changes

### ADD src/adapters/kiro-tools.ts

- export `convertKiroTools(parsed: OcxParsedRequest): unknown[]`
- recursively sanitize schemas:
  - remove every `additionalProperties` key
  - remove `required` if it is an empty array
  - preserve non-empty `required`, `properties`, `items`, `oneOf`, `anyOf`, etc.
- keep existing behavior:
  - name sliced to 64 chars
  - description placeholder when empty, sliced to 1024
  - inputSchema json defaults to `{}`

### MODIFY src/adapters/kiro.ts

- remove local `convertTools`
- import/use `convertKiroTools`
- keep file <= 500 lines

### MODIFY tests/kiro-adapter.test.ts

Add test that a tool schema with nested `additionalProperties` and empty
`required: []` is sanitized before payload construction, while non-empty
required is preserved.

## Verification

- bun x tsc --noEmit
- bun test tests/kiro-adapter.test.ts

## Commit

fix(kiro): sanitize tool schemas before CodeWhisperer payload
