# wp3 — carry #8591: normalize root tool schemas for Command Code's Claude upstreams

Source: PR #8591 by @mursyidd, head `7e10e16aed8f6ae3a3bf73e88907c5f70f26cb61`, merge base
`277d9771bc`. Since then `dev` changed `src/adapters/anthropic.ts` (+3 lines, #8787, outside the moved
function) and `tests/fixtures/test-layout-expected.json`; the net diff applies clean.

## Diff

Apply `git diff 277d9771bc 7e10e16aed` (squashed; 663+/69-):

- NEW `src/adapters/anthropic-input-schema.ts` (188 lines): `normalizeAnthropicInputSchema` moved out of
  `anthropic.ts`, extended with local `#/...` ref inlining before root flattening, `$ref` sibling merge
  (properties merged, `required` unioned, shared property conjoined under `allOf`), null-prototype
  property maps, and a 4096-visit expansion bound that throws.
- MODIFY `src/adapters/anthropic.ts`: import the shared normalizer, delete the local copy (−62 lines).
- MODIFY `src/adapters/command-code.ts`: `wireTools` sends `normalizeAnthropicInputSchema(tool.parameters)` as `input_schema`.
- NEW `tests/providers/command-code-tool-schema.test.ts` (372 lines), registered as `providers` in
  `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.
- MODIFY `tests/providers/command-code-provider.test.ts` (one expectation for a type-only root) and
  `tests/adapters/anthropic/anthropic-tool-schema.test.ts` (+93 shared-helper cases).
- MODIFY `structure/providers-and-adapters.md`: line-neutral (joins two wrapped lines, adds the
  two-line normalizer paragraph); the file must stay at ≤ 600 lines.

## Verify

- Red: tests only (src reverted) → `tests/providers/command-code-tool-schema.test.ts` fails on the wire
  assertions (the module import itself fails, so also confirm with `command-code.ts` reverted but the new
  module present: the wire cases must fail).
- Green: `bun test tests/providers/command-code-tool-schema.test.ts tests/providers/command-code-provider.test.ts tests/providers/commandcode-provider.test.ts tests/adapters/anthropic/anthropic-tool-schema.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts`.
- Broader: `bun test tests/adapters/anthropic` and `tests/providers/command-code*`.
- `wc -l structure/providers-and-adapters.md` ≤ 600.

Commit: `fix(command-code): normalize root tool schemas for Claude upstreams`, trailer `Co-authored-by: mursyidd <…>`.

## Audit amendment A1 — composition on both sides of a `$ref` (follow-up commit)

Found while auditing the carry (reproduced with a scratch copy of the PR module): `mergeRefSiblings`
builds `{ ...resolved, ...siblings }`, so a sibling `allOf`/`oneOf`/`anyOf` replaces the referenced
schema's composition. Input
`{ $defs: { A: { allOf: [{ properties: { a }, required: ["a"] }] } }, allOf: [{ $ref: "#/$defs/A", allOf: [{ properties: { b }, required: ["b"] }] }] }`
normalizes to `properties: { b }, required: ["b"]`; `a` is lost although the module comment promises
that a `$ref` with siblings keeps both sides.

MODIFY `src/adapters/anthropic-input-schema.ts` `mergeRefSiblings`, after building `merged`:

```ts
// Both sides' composition applies (JSON Schema conjoins a $ref with its siblings).
const allOf: unknown[] = [];
for (const source of [resolved, siblings]) if (Array.isArray(source.allOf)) allOf.push(...source.allOf);
for (const key of ["oneOf", "anyOf"] as const) {
  if (Array.isArray(resolved[key]) && Array.isArray(siblings[key])) {
    allOf.push({ [key]: resolved[key] }, { [key]: siblings[key] });
    delete merged[key];
  }
}
if (allOf.length > 0) merged.allOf = allOf;
```

`collectRootComposition` already recurses into each `allOf` branch's own composition, so the
wrapped `oneOf`/`anyOf` keep today's lossy-alternative behaviour (properties merged, `required` not promoted).

Test (in `tests/providers/command-code-tool-schema.test.ts`, through `wireTools` like the existing
wire cases): the input above yields `properties` with both `a` and `b` and `required` containing both;
a both-sided `oneOf` keeps the properties of all four branches and promotes no `required`.
Red before the amendment, green after.

Structure: in `structure/providers-and-adapters.md` replace the carried sentence fragment
"Local `#/$defs/...` and `#/definitions/...` references are inlined before flattening, and a `$ref` with siblings keeps both property maps, unions `required`, and conjoins a property declared on both sides under `allOf`."
with
"Local `#/...` references are inlined before flattening, and a `$ref` with siblings keeps both property maps, unions `required`, conjoins a property declared on both sides under `allOf`, and keeps composition from both sides."
(same line, so the file stays at 600).

Commit: `fix(command-code): keep composition from both sides of a schema $ref` (lane-authored, on top of the carry).
