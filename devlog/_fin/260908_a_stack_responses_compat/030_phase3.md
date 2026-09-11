# 030 — Phase 3: fix issue #3922 (Claude tool strict default on Responses routes)

Branch `codex/a-stack-l3-claude-strict`, based on layer 2. New work; no existing
pull request. This is the only layer authored here.

## Problem

When Claude Code sends a custom tool without an explicit `strict`, the
Messages -> Responses translation emits a function tool that also omits `strict`.
The Responses API treats an omitted `strict` as an attempt to normalize the schema
into strict mode, so parameters that the Anthropic `input_schema` marks optional
are treated as required upstream, and a tool call that omits them fails. Anthropic
requires an explicit `strict: true` to opt in, so the two defaults disagree.

## MODIFY map

`src/claude/inbound-content-options.ts` — `toolsToResponses`, the function-tool
branch at 26-33.

Before:

```ts
    if (typeof raw.name === "string" && raw.name.length > 0 && isRec(raw.input_schema)) {
      out.push({
        type: "function",
        name: raw.name,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        parameters: raw.input_schema as Record<string, unknown>,
      });
      continue;
    }
```

After:

```ts
    if (typeof raw.name === "string" && raw.name.length > 0 && isRec(raw.input_schema)) {
      out.push({
        type: "function",
        name: raw.name,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        parameters: raw.input_schema as Record<string, unknown>,
        // Anthropic opts into strict tool use explicitly, while Responses normalizes
        // an omitted strict into strict mode. Carry the source intent rather than the
        // destination default, so an optional input_schema parameter stays optional.
        strict: typeof raw.strict === "boolean" ? raw.strict : false,
      });
      continue;
    }
```

The value is derived from the source tool rather than hardcoded, so an explicit
`strict: true` or `strict: false` from the client survives translation, which is
what issue #3922 asks for.

## How the existing strict-tool admission policy relates (audit finding 2)

An earlier draft of this document described `src/claude/compatibility.ts:102`
backwards. What that line actually does:

```ts
if (tool.strict === true) codes.add("strict_tools");
```

`strict_tools` is listed as an incompatible feature at `compatibility.ts:16`, and
`analyzeClaudeCompatibility` (`compatibility.ts:179`) returns `"reject"` for an
incompatible request under enforce mode (decision expression at `:189`), which
`src/server/claude-messages.ts:733-740` applies **before**
translation. So an explicit `strict: true` is already refused in enforce mode and
only reaches translation on the default and shadow paths.

This phase does not change that policy. Detection reads the **source** Anthropic
tool before translation, so emitting a default `strict: false` downstream adds no
new rejection; `tests/claude-integration/claude-compatibility.test.ts:73-78`
already covers the explicit-false allow case, and `:24` lists strict tools among
rejected features.

## Propagation (independently traced twice, no further change needed)

- `src/claude/inbound-content-options.ts:26-32` builds the tool.
- `src/claude/inbound.ts:350-351` assigns it to `body.tools`.
- `src/server/claude-messages.ts:875,897` serializes that body into the internal
  Responses request; `src/server/responses/core.ts:3160` parses it.
- `src/responses/schema.ts:114` accepts `strict`; `parser-tools.ts:63` preserves an
  explicit value including `false`.
- `src/responses/parser.ts:570` keeps `_rawBody`, and
  `src/adapters/openai-responses.ts:2362-2364` starts from it. Canonical-field
  stripping only removes `external_web_access`/`defer_loading` (`:189-200`) and
  schema normalization spreads the tool (`{ ...tool, parameters }`, `:648-658`),
  so `strict` reaches `JSON.stringify(finalBody)` at `:2523`.

## Boundaries

- Hosted `web_search` leaves the function at 22-24, before this branch, so it gains
  no `strict` field.
- Native Anthropic passthrough never reaches translation:
  `src/server/claude-messages.ts:721-722` returns from `anthropicNativePassthrough`
  before the translation call at 757.
- Other Anthropic server tools still drop at 35.

## Schema promise, stated precisely (audit finding 4)

At translation, `parameters` is the caller's `input_schema` reference
(`inbound-content-options.ts:31`), so `properties`, `required` and nested schemas
are unchanged there. That is not a promise of a byte-identical schema on every
outbound route: `openai-responses.ts:651` runs `normalizeXaiToolParameters`, `:657`
supplies a root `type: "object"` when absent, `responses-code-mode.ts:23-27` can
rewrite an `exec` parameter description, and Azure Chat sanitizes at
`openai-chat.ts:1359-1361`. The regression asserts an unchanged schema through the
ordinary OpenAI Responses route.

Adding the field also shifts fallback cache-cohort hashes, because translated tool
definitions participate in the hash at `src/claude/inbound.ts:386-392`. That is a
cohort change, not a correctness change.

## Known risk

The same translated tools feed translated Chat Completions routes, where
`openai-chat.ts:1343` forwards an explicit `strict`; Azure deletes it at `:1364`,
and `tests/providers/azure-model-router-tool-schema.test.ts:42` already pins that
absence. No repository-declared rejection of an explicit `strict: false` was found,
but universal upstream acceptance is not proven. A provider rejecting it is an
escalation.

## TESTS

`tests/claude-integration/claude-inbound.test.ts`:

- **Update the existing assertion at 80-83.** It is an exact `toEqual` on the
  translated `Read` tool and will fail once `strict` is present; the expected
  object gains `strict: false`.
- Keep `expect(tools[1]).toEqual({ type: "web_search" })` at 84 unchanged.
- New cases: omitted `strict` -> `false`; explicit `false` -> preserved; explicit
  `true` -> preserved; an `input_schema` with one required and one optional
  property keeps its `required` array through `parseRequest`.
- Assert the three values on the **serialized adapter output**, not only the
  translator return, so the wire body is what is pinned.

## Verification (C)

No local command. Verified by the single tip CI run in 050. Local suites: NOT RUN.
