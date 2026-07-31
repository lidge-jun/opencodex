# WP1 — Anthropic defensive strip of Responses-only `encrypted` marker

Goalplan: `ship-remaining-encrypted-marker-hardening-anthro` (wp1, criteria c1/c2).
Session: 019f4b46-b688-7562-a040-ae948b045eda. Class: C2 (single adapter file + tests,
conventional hardening mirroring the shipped google/kiro guards in e335e843).

## Loop-spec header

- **Archetype:** spec-satisfaction repair (verifier defines done).
- **Trigger:** provider-risk audit (000_plan.md) marked Anthropic "UNVERIFIED but
  schema-strict → defensive strip recommended"; Codex multi-agent v2 stamps
  `encrypted: true` on collaboration tool schemas (`spawn_agent`/`send_message`/
  `followup_task` → `properties.message.encrypted`).
- **Goal:** nested `encrypted` schema keyword never reaches serialized Anthropic
  `tools[].input_schema`; a property literally NAMED `encrypted` survives.
- **Non-goals:** other adapters; OpenAI Responses passthrough (must keep marker);
  any user WIP file; behavior of existing root normalization.
- **Verifier:** `bun test tests/anthropic-tool-schema.test.ts` + `bun x tsc --noEmit`.
- **Stop condition:** both criteria green; LOOP-REPAIR-01 bounds (2 same-failure
  repairs → root-cause mode; 3 → replan at P).
- **Memory artifact:** this doc + goalplan ledger.
- **Terminal outcomes:** DONE | BLOCKED (env) | NEEDS_HUMAN (WIP isolation).
- **HOTL bounds:** worker writes ONLY `src/adapters/anthropic.ts` +
  `tests/anthropic-tool-schema.test.ts`; budget ≤60 min wall-clock; subagents
  `anthropic/claude-opus-4-6` medium, fork none.

## Current state (read, HEAD e335e843)

- `src/adapters/anthropic.ts:485` — `toolsToAnthropicFormat` maps each tool to
  `input_schema: normalizeAnthropicInputSchema(t.parameters)`.
- `normalizeAnthropicInputSchema` (line ~490) normalizes the ROOT only: ensures
  `type:"object"` + `properties`, flattens root `oneOf/anyOf/allOf`. It never
  recurses, so a nested `properties.message.encrypted: true` passes through
  verbatim to the wire.
- Google guard: `DROPPED_SCHEMA_KEYS` incl. `encrypted` in
  `src/adapters/google-tool-schema.ts`. Kiro guard: `KIRO_REJECTED_SCHEMA_KEYS`
  in `src/adapters/kiro-tools.ts`. Anthropic has no equivalent recursive pass.
- Tests live in `tests/anthropic-tool-schema.test.ts` (no `encrypted` coverage yet).

## Diff-level plan

### `src/adapters/anthropic.ts` (only file changed in src)

1. Add a module-level helper near `normalizeAnthropicInputSchema`:

   ```ts
   // Codex multi-agent v2 stamps a Responses-only `encrypted: true` marker on
   // collaboration tool schemas (openai/codex 5f4d06ef; issue #85). It is an
   // annotation for the ChatGPT backend only. Anthropic input_schema is strict
   // JSON Schema; strip the marker defensively everywhere it can appear as a
   // schema keyword, while preserving properties literally named "encrypted".
   function stripEncryptedMarker(node: unknown, inPropertyBag = false): unknown
   ```

  Semantics:
  - Arrays → map over items with `inPropertyBag=false`.
  - Non-objects → returned as-is.
  - Object with `inPropertyBag=true` (the value of a NAME→SCHEMA map key):
    each entry's KEY is a NAME (so a key named `encrypted` survives); each
    VALUE is a schema → recurse with `inPropertyBag=false`. Name-bag keys:
    `properties`, `patternProperties`, `$defs`, `definitions` (audit fix #2 —
    a definition literally named `encrypted` must survive).
  - Object with `inPropertyBag=false` (a schema node): drop the `encrypted`
    key; for each remaining entry — if the key is a LITERAL-VALUE keyword
    (`const`, `default`, `enum`, `examples`), copy the value verbatim with NO
    recursion (audit fix #1 — e.g. `default: { encrypted: true }` is user
    data, not a schema keyword); if the key is a name-bag key above, recurse
    with `inPropertyBag=true`; otherwise recurse with `inPropertyBag=false`.
  - Pure function: builds new objects, never mutates input (t.parameters is
    shared parsed state, consumed by other adapters too — reviewer confirmed
    via src/responses/parser.ts:106 / openai-chat.ts:142).

2. Wire it in `normalizeAnthropicInputSchema` as the FIRST step: replace the
   initial `obj` derivation so the incoming schema is
   `stripEncryptedMarker(schema)` before existing root normalization. One call
   site; both the no-composition and composition paths inherit the strip.
   Existing root-flattening behavior is unchanged (strip only removes the one
   keyword).

### `tests/anthropic-tool-schema.test.ts`

Add tests (activation scenarios, C-ACTIVATION-GROUNDING-01):

- **c1a (marker stripped, end-to-end):** build a parsed request whose tool
  mirrors the real v2 collaboration shape —
  `{ type:"object", properties:{ message:{ type:"string", encrypted:true } }, required:["message"] }`
  — call the adapter's `buildRequest`, parse the serialized body, and assert
  `JSON.stringify(tools[0].input_schema)` contains no `"encrypted"` while
  `properties.message.type === "string"` survives.
- **c1b (named property survives):** schema with
  `properties: { encrypted: { type:"boolean" } }` → after buildRequest, the
  wire input_schema still has `properties.encrypted` with `type:"boolean"`.
- **c1c (deep nesting, REQUIRED for c1 — audit fix #3):** marker under
  `items`, under a nested object property, and inside a root `anyOf` branch
  (exercising the composition-flatten path) is stripped in all three spots.
- **c1d (literal values survive — audit fix #1):** a schema with
  `default: { encrypted: true }` (and/or `const`/`enum` carrying an object
  with an `encrypted` key) keeps that value byte-identical on the wire;
  `required: ["encrypted"]` stays unchanged.
- Reuse the file's existing helpers `toolsOf` (drives buildRequest and parses
  the serialized body) and `toolSchema` (one-tool schema fixture) —
  tests/anthropic-tool-schema.test.ts:7,21.
- Follow the file's existing harness/helpers for constructing parsed requests
  (reuse whatever fixture builder the current tests use).

## Accept criteria (goalplan)

- c1: serialized input_schema contains no `encrypted` schema keyword across
  ALL tested paths (root property, nested property, items, anyOf branch);
  named property AND named `$defs` entry survive; literal `default`/`const`/
  `enum` values containing an `encrypted` key survive verbatim; test output
  pass lines captured.
- c2: touched test file(s) 100% pass; `bun x tsc --noEmit` exit 0.

## Audit round 1 synthesis (terra reviewer, GO-WITH-FIXES blockers=3)

- #1 Medium (ACCEPTED): blind recursion corrupts JSON-valued annotations
  (`const`/`default`/`enum`/`examples`) → literal-value keys copied verbatim.
- #2 Low (ACCEPTED): `$defs`/`definitions` are name→schema maps → added to
  name-bag set so a definition named `encrypted` survives.
- #3 Low (ACCEPTED): c1 now requires the deep-path + literal-survival tests
  explicitly so a shallow implementation cannot pass.
- Reviewer confirmed: single wire path via normalizeAnthropicInputSchema
  (anthropic.ts:485), marker reaches adapters verbatim (parser.ts:99-106,463),
  strip-before-flatten ordering sound, non-mutation necessary.

## Scope boundary

- IN: the two files above + this devlog doc + goalplan ledger updates.
- OUT: everything else. Worker must NOT touch user WIP (README*, docs-site/*,
  src/web-search/*, src/server/*, src/lib/*, other adapters, catalog, types,
  untracked tests) and must NOT run `git add`/`commit` (main session owns wp3).

## SoT sync target (SOT-SYNC-01)

`structure/` docs: e335e843 did not add an encrypted-marker note to structure
docs; check `structure/` for the adapter schema-sanitization SoT during C and
patch only if a matching section exists (likely `structure/01_runtime.md` or a
providers doc). If none exists, note in D summary.
