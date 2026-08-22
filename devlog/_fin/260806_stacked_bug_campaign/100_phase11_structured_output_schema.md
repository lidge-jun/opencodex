# 100 — Phase 11: routed structured-output schema preservation (PR #985)

Credit: **Pranav Yerramaneni** (`devmello <email from PR head>`), PR #985.
Adoption: **adapted** — one schema-loss bug closed.

## Defect (verified on `dev` = e9d957bf6)

The Responses `text.format` request is reduced to a boolean at the parser:
`parseRequest` calls `detectStructuredOutput(data.text)`
(`src/responses/parser.ts:671`) and keeps only `_structuredOutput: true`
(`:685`). The format object — schema, name, strict — is discarded there, so no
adapter can forward it.

`src/adapters/openai-chat.ts` has no `response_format` handling at all on `dev`
(`rg response_format src/adapters/openai-chat.ts` returns no matches); body
assembly ends at the `promptCacheKey` block near `:818`. A client routed to an
`openai-chat` provider therefore asks for a JSON schema and receives prose.

## Why adapted

#985's architecture is right: carry the parsed format on `options.textFormat`,
keep `_structuredOutput` for the web-search sidecar, and re-nest the flattened
Responses fields under `json_schema` — the inverse of `responseFormatToText`.

One gap remains in the contributor's adapter code: the `json_schema` branch is
guarded by `textFormat.schema !== undefined`, so a schema-less `json_schema`
falls through and **no** `response_format` is sent. That silently reproduces the
original defect on a narrower input.

## Change

Cherry-pick #985's commits, then correct the adapter guard.

| Path | Op | Content |
|------|----|---------|
| `src/responses/parser.ts` | ADOPT | Replace `detectStructuredOutput` with `parseTextFormat` returning the format object; set `options.textFormat`; derive `_structuredOutput` from it (~`:668-711` as authored) |
| `src/types.ts` | ADOPT | `textFormat` on `OcxRequestOptions` (+14 as authored) |
| `src/adapters/openai-chat.ts` | ADAPT | Add the `response_format` mapping after the `promptCacheKey` block (~`:820`). **Change from #985:** enter the `json_schema` branch whenever `type === "json_schema"`, adding the `schema` member conditionally instead of gating the whole branch on it |
| `src/adapters/openai-responses.ts`, `src/server/responses/core.ts`, `src/server/chat-completions.ts` | ADOPT | As authored |
| `tests/openai-chat-hardening.test.ts` | ADAPT | Authored cases plus a schema-less `json_schema` case asserting `response_format.type === "json_schema"` is still sent |
| `tests/responses-parser.test.ts`, `tests/chat-completions-endpoint.test.ts`, `tests/responses-compaction-routing.test.ts`, `tests/kiro-adapter.test.ts`, `tests/server-kiro-completion-e2e.test.ts` | ADOPT | As authored |
| `docs-site/src/content/docs/reference/proxy-formats.md` | ADOPT | +7 as authored |

## Verification

- `bun test` on the structured-output and openai-chat adapter suites
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 10, base = stack 09 head. Credits Pranav Yerramaneni.
