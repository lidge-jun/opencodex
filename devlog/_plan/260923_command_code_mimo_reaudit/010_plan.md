# 260923 Command Code / MiMo re-audit: tool-call text leak, wire compatibility, catalog

## Problem

Users report that Xiaomi MiMo models routed through Command Code show tool calls as plain
assistant text in Codex. Separately, the shipped Command Code facts (model fixture, reasoning
ladders, wire selection) drifted from the live Provider API, which now publishes a per-model
`supported_endpoints` list.

## Evidence (collected 2026-09-23, raw captures in `.tmp/cc-audit/`, not committed)

| Question | Surface | Finding |
|---|---|---|
| Does a simple MiMo tool call work? | direct `/alpha/generate`, `/provider/v1/chat/completions`, proxy chat + responses | Yes for single, parallel and multi-turn calls on `xiaomi/mimo-v2.6-flash`, `-pro`, `v2.5-pro`. |
| Where does the text come from? | real `codex exec -m command-code/xiaomi-mimo-v2.6-flash -c model_reasoning_effort=high` (2 of 2 long runs leaked) and a direct replay of the captured turn | Upstream order: `tool-input-start(exec)` → `tool-input-delta*` → `text-start` → `text-delta "<tool_call><function=exec>RAW JS…</parameter></function></tool_call>"` → `text-end` → `tool-input-end` → `tool-call{toolName:exec,input:"RAW JS",invalid:true}` → `tool-error` → `finish-step(tool-calls)`. MiMo writes Codex's freeform `exec` body as raw JavaScript, the gateway's JSON parse of the `{input:string}` schema fails, and the gateway re-emits the model's native XML as text. The native call still executes downstream; the duplicate text is what the user sees. |
| Other wires | same captured turn on Chat and Responses | structured calls, no marker text. |
| MiMo 2.7 | Command Code live catalog, Xiaomi docs/release note, OpenRouter, Zen, Vercel AI Gateway | Not present anywhere checked. Newest ids are `mimo-v2.6-pro`, `mimo-v2.6-flash`, `mimo-v2.6-pro-ultraspeed` (Command Code added them 2026-09-22). |
| Command Code endpoints | live `/provider/v1/models` (77 rows) + docs | 9 `claude-*` ids are `/messages` only; 7 ids are `/chat/completions` only; the rest serve Chat and Responses. MiMo v2.6 rows: Chat + Responses. |
| Key preset on Claude | direct POST | `/chat/completions` → 400 `must be called via /provider/v1/messages`; `/provider/v1/messages` routes (403 plan gate on this account), Bearer and x-api-key both accepted. |
| Other clients (Aside research, `.tmp/cc-audit/client-handling.md`) | GitHub issues | Same leak without any native call: anomalyco/opencode#43385, patlux/pi-commandcode-provider#110 (Command Code: mimo 2.5, 2.6 flash, qwen 3.8 omni flash, GLM 5.3 flash), QwenLM/qwen-code#10692, XiaomiMiMo/MiMo#44 (worse with thinking high). Proposed fix everywhere is a text fallback parser. Vercel AI SDK `repairToolCall` cannot see text leaks. |
| MiMo grammar (Aside research, `.tmp/cc-audit/mimo-tool-format.md`) | HF chat templates, vLLM/SGLang parsers | `<tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>`; strings raw, other types JSON; freeform input is the raw body with no parameter tags. |
| Catalog drift | live catalog vs `tests/fixtures/commandcode-models.json`; commandcode.ai profile payloads | fixture 59 rows vs live 77 (20 new, 2 retired); ladder corrections for `deepseek-v4.1-flash`, `Qwen3.8-Flash`, `muse-spark-1.3-contributor`; new ladders for 12 ids; Muse 1.3 profile URLs point at non-model routes; the refresh parser matches prose the pages no longer contain. |

## Architect consultation

Architect (gpt-6-sol, read-only) proposed D1-D4. Main dispositions:

- D1 accepted and widened after the Aside research below: drop a text block only when it exactly duplicates the following native call; salvage a complete block only for a declared tool when no native call exists (architect advised rejecting salvage; external reports show the text-only form is the common failure and the undeclared-tool guard plus the declared-name check bound the risk).
- D2 accepted: provider-scoped `claude-` prefix pin to `anthropic` for `commandcode`, shared by the runtime resolver, config validation and the captured fast-policy authority.
- D3 accepted: refresh the static table and fixture, and repair the refresh parser to read the serialized profile payload, keeping the static row on any ambiguity.
- D4 rejected for this unit: `upstreamProtocolForAdapter` groups cursor, devin, kiro and command-code under the chat translation family on purpose; a distinct label needs Lab observation changes that no user path exercises. Recorded as a follow-up.

## Diff-level plan

wp2 — MiMo tool-call text handling (`src/adapters/command-code.ts`, new sibling `src/adapters/command-code-tool-text.ts`)
1. `buildRequest` attaches `commandCodeDeclaredTools` (wire name → `{ freeform, schema }` from `OcxTool.freeform` and `parameters`) to the `AdapterRequest` (new optional field in `src/adapters/base.ts`, same pattern as `convertedMuseToolNameAliases`; spread copies such as the effort-downgrade retry keep it). `fetchResponse` maps every returned `Response` to it in a module `WeakMap`; `parseStream` reads it. No declared tools → no salvage.
2. `parseStream` tracks open tool inputs by id (`tool-input-start` → name, cleared on `tool-input-end`/`tool-call`) and text blocks by `text-start`/`text-end` id. A block is held while its whitespace-trimmed lead is a prefix of, or starts with, `<tool_call>`; a divergent prefix flushes immediately and the block streams normally. Each held block records the set of input ids open when it started. Held bytes are reserved in the translator budget; a 64 KiB cap releases the block as text.
3. Parsing follows the official MiMo/Qwen3-Coder grammar (SGLang `MiMoDetector`, vLLM `mimo` → Qwen3 engine): `<tool_call><function=NAME>BODY</function></tool_call>`; BODY with `<parameter=K>V</parameter>` pairs → object (string schema types raw, one wrapping newline trimmed; integer/number/boolean/null/object/array JSON-decoded per the declared schema, a value that does not decode to its declared type makes the block non-salvageable); BODY without parameter tags → the raw freeform string (a stray trailing `</parameter>`, as captured, is tolerated).
4. Dedupe: on `tool-call`, a held block is dropped only when it parses completely, its NAME equals the call's toolName, the call's id is in the block's recorded open-input set (or the set was empty), and the decoded value equals the call input exactly (string vs trimmed string; object deep-equal). A non-matching call leaves a block held while that block's recorded input ids are still unresolved; each arriving call rules out its own id, and the block is released as text only after every recorded candidate id has been ruled out (or immediately on a mismatch when it recorded none).
5. Salvage: at `finish-step`/`finish`/stream end, an unmatched held block becomes a synthetic call (`tool_call_start`/`delta`/`end`, id `call_ocx_<uuid>`) only when it parses completely, names a declared tool, and its arguments fit that tool: a freeform tool takes a parameter-free body as its raw input (the same raw form the native path already relays); a function tool takes a parameter object that contains every `required` key and only declared keys, serialized as JSON. A finish reason of `stop` is reported as `tool-calls`. Anything else is released as text.
6. Tests (`tests/providers/command-code-tool-text.test.ts`, registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`): captured event order (text dropped, one call), two interleaved tool inputs (each block paired by id), split `<tool`/`_call>` deltas, name/param mismatch and substring-only match (released), text-only freeform block (salvaged raw), text-only function block with typed params (salvaged JSON), missing required key or undeclared key or undeclared name (released), a typed parameter that does not decode (released), call B arriving before the call matching block A (A still dropped), ordinary text untouched, overflow release, and a salvaged call id paired with its tool result on the next request (`wireMessages`). One end-to-end case drives a salvaged function call through the Responses bridge.

wp3 — catalog re-aggregation
1. `tests/fixtures/commandcode-models.json` ← live snapshot (77 rows including `supported_endpoints`).
2. `src/providers/command-code-efforts.ts`: correct 3 rows, add rows backed by profile payloads, fix Muse profile URLs, teach `parsedProfileEfforts` to decode the serialized payload for the requested model (static row kept on ambiguity).
3. Tests: `tests/providers/command-code-provider.test.ts` (ladders, URLs, parser), `tests/providers/commandcode-provider.test.ts` (fixture count).

wp4 — compatibility
1. `src/types/wire.ts`: add provider-scoped prefix pins (`commandcode`: `claude-` → `anthropic`) beside the exact-id table; `isWirePinnedModel` and `pinnedWireAdapter` consult both, so `src/server/adapter-resolve.ts:35`, `src/providers/resolved-model-policy.ts:284`, `src/config/provider-validation.ts:373` and `src/config/schema/leaf-validators.ts:493` follow automatically. Export `captureWireAdapterHardPinPrefixes(providerName)` returning a frozen `Record<prefix, adapter>`, re-exported from the `src/types.ts` barrel (`tests/config/types-barrel-identity.test.ts`).
2. `src/providers/fastwire.ts`: optional `hardPinPrefixes` on `FastPolicyAuthority`, applied after exact pins and before overrides; `src/providers/service-tier.ts:115` captures it; the no-provider authority (`service-tier.ts:155`) and the synthetic one (`:207`) keep it empty.
3. Tests: `tests/server/adapter-resolve.test.ts` (claude id → anthropic even with a Chat `modelAdapters` entry, MiMo stays chat, other providers unaffected), `tests/routing/fastwire-policy.test.ts` (prefix pin through policy resolution), and a new sibling `tests/config/config-commandcode-claude-pin.test.ts` (registered in layout) because `tests/server/config.test.ts` sits at its 3,828-line cap.
4. Docs: `docs-site/src/content/docs/guides/providers.md` Command Code paragraph and `reference/adapters.md` Command Code section state the real wires (key: Chat, `claude-*` on Messages; OAuth: `/alpha/generate` NDJSON) and the MiMo text handling; translations checked for contradiction. `structure/` owners for `src/adapters/` and `src/types/` reviewed via `bun run structure:check` and updated if they name the touched contracts.

## Acceptance

- The captured failing event order produces one `exec` call and zero text in a focused test (red before wp2, green after).
- `resolveWireProtocolOverride("commandcode", "claude-opus-5-5", keyProvider).adapter === "anthropic"`, MiMo ids stay `openai-chat`.
- Fixture and effort table match `.tmp/cc-audit/live-models.json` and `.tmp/cc-audit/B/report.md`.
- `bun test` on the touched files, `bun run typecheck`, `bun run structure:check`, `tests/test-layout.test.ts`, `tests/ci-workflows/file-size-ratchet.test.ts` pass.

## Out of scope / residual

- Dotted flat tool names (`functions.exec_command`) echoed without prefix by MiMo (synthetic probe only).
- Intermittent upstream `The connection was closed` 502s on `/alpha/generate`.
- Lab protocol label (D4).
- Profile-declared vision for new ids (needs route-specific image proof before `COMMAND_CODE_IMAGE_MODELS`).

## wp3 amendments (P, 2026-09-23)

The W3 worker draft (`.tmp/cc-audit/wp3.patch`) is applied in B with three corrections found in review:
restore the rationale comments it deleted (exact-id key rule and the measured index map), fix the
remaining Muse 1.2/1.1 profile URLs (`meta-muse-spark-1.2` redirects 302; `muse-spark-1-2`,
`muse-spark-1-2-contributor`, `muse-spark-1-1` serve the payload), and raise the refresh bound from
256 KiB to 512 KiB because live profile pages now measure 240-259 KB. Every captured ladder matched
the payload parser (`.tmp/cc-audit/chk/ladders.ts`); live refresh reproduces the committed rows for
gpt-5.6-luna, GLM-5.2/5.3, deepseek-v4-flash and gemini-3.7-flash.

Audit fold (reviewer, wp3): the payload parser also rejects a record whose indexed keys decode to the
same field name twice, with a test; the 512 KiB bound gets a test with a page above 256 KiB.

Audit fold (reviewer, wp4): the `claude-` prefix pin applies only when the provider's baseUrl is
Command Code's Provider API endpoint, so a custom provider that reuses the `commandcode` name for
another destination keeps its own wire and its Chat overrides; every consumer passes the provider
config. The unused `ResolvedFastPolicy.hardPinned` field is dropped, and the guide says the Messages
route authenticates with `x-api-key` (Command Code accepts it).
