# Phase 3 — Google structured output and Anthropic parallel-tool disable

Branch `agent/provider-parity-03-wire`, base `agent/provider-parity-02-controls`.
Findings F3 and F4.

Thesis: two request options the IR already carries have no consumer in their
vendor adapter. Both vendors document the exact field; map to it, and refuse
explicitly where the field is not verified rather than dropping it in silence.

The vendor contracts and their citations are in
[`001_audit_evidence.md`](001_audit_evidence.md#vendor-contracts).

## Scope

IN: `options.textFormat` onto the Gemini `generateContent` wire, and
`options.parallelToolCalls` onto Anthropic `tool_choice`.

OUT: Google `tool_choice` (already implemented), Google response parsing (the
response type does not change), the Interactions API (not used), Antigravity and
Claude-through-CCA structured output (not verified — refused instead).

## File change map

| File | Action |
|---|---|
| `src/adapters/google.ts` | MODIFY — build structured-output config |
| `src/adapters/google-wire-compiler.ts` | MODIFY — pass it to the wire |
| `src/adapters/anthropic.ts` | MODIFY — emit the disable flag |
| `tests/adapters/google/google-structured-output.test.ts` | NEW |
| `tests/adapters/anthropic/anthropic-parallel-tool-disable.test.ts` | NEW |
| `scripts/test-layout/layout.json` | MODIFY |
| `tests/fixtures/test-layout-expected.json` | MODIFY |
| `structure/providers/google.md` | MODIFY |
| `structure/providers/chat-compat.md` | MODIFY |
| `docs-site/` | MODIFY — structured output is user-visible |

## MODIFY `src/adapters/google.ts` — F3

Added to the `generationConfig` construction at `:826-849`, after the
`thinkingConfig`/`responseModalities` block:

```ts
      // Structured output travels in generationConfig on generateContent itself.
      // responseJsonSchema takes ordinary JSON Schema (lowercase types), which is
      // exactly what options.textFormat.schema already holds; responseSchema would
      // require Gemini's uppercase typed Schema form. The response type is
      // unchanged — the model returns text containing conforming JSON — so no
      // response-parsing change belongs in this diff.
      const textFormat = parsed.options.textFormat;
      if (textFormat && !isImageCapableModel(parsed.modelId)) {
        if (provider.googleMode === "cloud-code-assist") {
          throw new Error(
            "structured output is not supported on this Google mode (cloud-code-assist); "
            + "remove response_format or route the model to AI Studio or Vertex",
          );
        }
        generationConfig.responseMimeType = "application/json";
        if (textFormat.type === "json_schema" && textFormat.schema) {
          generationConfig.responseJsonSchema = textFormat.schema;
        }
      }
```

Four decisions, each with a reason:

- **`responseJsonSchema`, not `responseSchema`.** The IR schema is an OpenAI-style
  JSON Schema with lowercase type names; `responseSchema` expects Gemini's typed
  form with `"OBJECT"`/`"STRING"`. Choosing the matching field avoids a lossy
  case translation.
- **No sanitizer.** `sanitizeGeminiToolParameters` narrows a schema to the
  tool-declaration subset. Running it over an output schema would strip valid
  constructs; the output path carries the schema through as-is.
- **`json_object` sets only the MIME type.** That is the whole of the contract for
  schemaless JSON.
- **Cloud Code Assist refuses.** The CCA envelope is proprietary and this field is
  not verified there, for Gemini or for Claude models served through it. An explicit
  error tells the caller their constraint was not applied; silence would return
  unconstrained prose that looks like success.

Image-capable models are excluded for the same reason `thinkingConfig` excludes
them at `:845-847`: the `responseModalities` fallback must keep working.

## MODIFY `src/adapters/google-wire-compiler.ts` — F3

`compileGenerationConfig` (`:118-151`) is a whitelist, so the adapter change alone
would be dropped before the wire. This is the half that makes the field real.

Added before the final `return`:

```ts
  if (typeof value.responseMimeType === "string" && value.responseMimeType.length > 0) {
    out.responseMimeType = value.responseMimeType;
  }
  // Carried through unmodified: this is a caller-authored output schema, not a tool
  // declaration, so the tool-parameter sanitizer must not touch it.
  if (isObject(value.responseJsonSchema)) out.responseJsonSchema = value.responseJsonSchema;
```

## MODIFY `src/adapters/anthropic.ts` — F4

Before, at `:1015-1022`:

```ts
      if (parsed.options.toolChoice && (tools || parsed.options.toolChoice === "none")) {
        const tc = parsed.options.toolChoice;
        if (tc === "auto") body.tool_choice = { type: "auto" };
        else if (tc === "none") body.tool_choice = { type: "none" };
        else if (tc === "required") body.tool_choice = { type: "any" };
        else if (isAllowedToolChoice(tc)) body.tool_choice = { type: tc.mode === "required" ? "any" : "auto" };
        else if (typeof tc === "object" && "name" in tc) body.tool_choice = { type: "tool", name: toolNames.toWire(resolveToolChoiceWireName(parsed.context.tools, tc.name)) };
      }
```

After — the mapping is unchanged; the flag is attached afterwards, and an implicit
auto is synthesized so a caller who sent only `parallel_tool_calls:false` is heard:

```ts
      if (parsed.options.toolChoice && (tools || parsed.options.toolChoice === "none")) {
        /* ...unchanged mapping... */
      } else if (tools && parsed.options.parallelToolCalls === false) {
        // No explicit choice, but the caller asked for one tool at a time. Anthropic
        // carries that intent inside tool_choice, so auto must be stated to hold it.
        body.tool_choice = { type: "auto" };
      }
      // disable_parallel_tool_use is nested in tool_choice and caps the model at one
      // tool call for auto/any/tool. It is irrelevant under type "none" (tool use is
      // already off) and meaningless with no tools on the wire.
      if (parsed.options.parallelToolCalls === false
          && isRec(body.tool_choice)
          && body.tool_choice.type !== "none") {
        body.tool_choice = { ...body.tool_choice, disable_parallel_tool_use: true };
      }
```

Branch behavior, matching the documented table:

| caller | emitted |
|---|---|
| `parallel=false`, no `tool_choice`, tools present | `{type:"auto", disable_parallel_tool_use:true}` |
| `parallel=false`, `auto` | `{type:"auto", disable_parallel_tool_use:true}` |
| `parallel=false`, `required` | `{type:"any", disable_parallel_tool_use:true}` |
| `parallel=false`, named tool | `{type:"tool", name, disable_parallel_tool_use:true}` |
| `parallel=false`, allowed-tools `auto`/`required` | `auto`/`any` + flag |
| `parallel=false`, `none` | `{type:"none"}`, no flag |
| `parallel=false`, no tools | no `tool_choice` at all |
| `parallel` unset or true | byte-identical to today |

The PR description states the boundary the vendor doc states: the flag constrains
the model's output, not execution ordering. Sequential tool use is enforced by the
caller's loop returning each `tool_result` before the next request.

## Acceptance criteria

| # | Scenario | Observable effect |
|---|---|---|
| 1 | AI Studio route, `text.format` `json_schema` | wire `generationConfig.responseMimeType === "application/json"` and `responseJsonSchema` equals the caller's schema |
| 2 | same, through `compileGenerationConfig` | both fields survive compilation |
| 3 | Vertex route, `json_schema` | same as 1 |
| 4 | `json_object` | MIME type only, no schema key |
| 5 | schema containing `additionalProperties:false` and nested `required` | reaches the wire unmodified; the tool sanitizer is not applied |
| 6 | cloud-code-assist route with `text.format` | explicit error naming the unsupported mode; no silent drop |
| 7 | image-capable model | `responseModalities` fallback still emitted |
| 8 | no `text.format` | `generationConfig` byte-identical to today |
| 9-15 | each row of the Anthropic table above | the stated `tool_choice` object |

Rows 1-6 and 9-14 are the red-first regressions.

## Bypass record

Tier E7. Executing surface: the two new test files plus `bun run typecheck`.
Known bypass: a Vertex model or API version that rejects `responseJsonSchema`
returns an upstream error rather than being caught locally — there is no local
capability table for this field and inventing one would be a guess. Residual risk:
accepted; the CCA path refuses explicitly, which is the case actually known to be
unsupported. No wording downgraded — this is a wire mapping, and support is claimed
only for the two modes named.
