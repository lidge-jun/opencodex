# 000 — Plan: schema-aware integer coercion for routed tool arguments (#1611)

Unit: `260813_issue1611_float_tool_args`
Baseline: `origin/dev` `3982dae47`
Issue: [#1611](https://github.com/lidge-jun/opencodex/issues/1611)

## The defect

Grok serializes integer tool-call arguments as floats. The arguments string reaches
Codex with `.0` intact, and Codex rejects the call **before executing it**, because its
tool schemas declare those fields as Rust integer types:

```
failed to parse function arguments: invalid type: floating point `120000.0`, expected u64
failed to parse function arguments: invalid type: floating point `29356.0`, expected i32
failed to parse function arguments: invalid type: floating point `12000.0`, expected usize
```

This is a hard failure, not a degradation. The tool never runs, the model gets no
result, and it retries the same float. A captured session lost five consecutive tool
calls this way across `exec_command` and `write_stdin`.

The reporter established that this is not a round-trip artifact inside OpenCodex —
`JSON.stringify(JSON.parse(...))` preserves integers exactly — so the `.0` arrives from
upstream and survives because nothing on the routed path reconciles argument values
against the declared schema.

## Seam (verified by reading, not assumed)

| Location | Role |
|---|---|
| `src/bridge.ts` `closeCurrentToolCall` (~579) | streaming path: emits `function_call_arguments.done` and the `function_call` item |
| `src/bridge.ts` `flushToolCall` (~1544) | non-streaming path: pushes the same arguments string |
| `src/bridge.ts` `parseArgsObj` (246) | `tool_search_call` only — adjacent to the defect, not the fix point |
| `src/server/responses/collaboration.ts` `buildToolBridgeMaps` (103) | already iterates `parsed.context.tools`; where the schema map is built |
| `src/types.ts` `OcxTool.parameters` (184) | the declared JSON Schema |

Both bridge paths must be covered. A streaming-only fix would leave the buffered path
broken, and `#1576` established the exact plumbing this fix reuses: a map built in
`buildToolBridgeMaps`, threaded through the same `options` object that already carries
`declaredToolNames` into both paths.

`rg` for `coerce` / `Number.isInteger` across `src/bridge.ts`, `src/server/responses/`,
and `src/adapters/` returns only unrelated HTTP-status checks, confirming no coercion
exists today.

## Contract

1. Coerce **only** when the declared schema type for that field is `integer` (or a
   union containing `integer`) **and** the value is integral. `120000.0` -> `120000`.
2. A non-integral value for an integer field (`1.5`) is a real upstream error. Leave it
   alone so it still fails. Never truncate, never round.
3. Never touch `number`-typed fields, strings, or fields with no declared schema.
   Absent schema means the value passes through byte-identical.
4. Walk nested shapes: object `properties`, array `items`, `$ref` into `$defs` /
   `definitions`.
5. Re-serialize only when something actually changed, so an unaffected payload keeps
   its exact original bytes.

## Why coerce rather than only report

`120000.0` has one unambiguous integer reading, and today the user has no recovery
path: the model cannot see the rejection well enough to stop repeating it. Rejecting
what we can safely repair spends the user's turn on a serialization detail. The
boundary is intent: an integral float is a representation artifact, while `1.5` in an
integer field is a genuine disagreement and stays an error.

## Precision boundary

JSON numbers beyond `Number.MAX_SAFE_INTEGER` cannot survive a JS round-trip intact.
The coercion therefore refuses to rewrite a value it cannot represent exactly, leaving
the original text in place rather than emitting a silently wrong integer.

## Verification

- Focused regression driven **red** first by ablating the coercion.
- `bun run typecheck` and the full suite on host `lidge`.
