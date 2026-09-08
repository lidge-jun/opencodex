# Cursor freeform input guidance — follow-up repair plan

Status: dedicated repair P cycle; source still248177c9. Prior Logs D completed its candidate verification; shipping obligations remain separate.
Inspected current checkout HEAD: `248177c9eccc639557c1770c59384dd6a6e27934` (2026-09-06 KST), after the original Cursor delivery and with ongoing Logs work. This is newer than the task's shorthand `6005+Logs`; all line anchors below describe the inspected source. Recheck them at the repair cycle's P after Logs C.

## Review disposition and delivery boundary

Accept the metadata-loss finding in `PRRT_kwDOS-0Gi86fmCS9` as a source-confirmed P2 regression. GitHub's read-only GraphQL response shows the thread unresolved on `src/adapters/cursor/tool-schemas.ts:115`, reviewing `6005ea8017dc7d113bba0d8dcef061d4f677c60f`:
https://github.com/lidge-jun/opencodex/pull/3707#discussion_r3941721795

The actual loss is confirmed by inspecting parser and schema code, not by running a test or making a live Cursor request. The claim that losing guidance can increase rejected model calls is plausible, but its runtime frequency was not measured here.

Original #3628 was integrated by `6dd23d6314c41f1113639e042353aae9e6614e62`, also recorded in `.tmp/d-delivery/cursor-admin-audit.json`. Main should implement this as a new follow-up PR after Logs C. Do not amend, reset, rebase, or replace landed commits. Preserve SB Yoon's existing authorship and cite #3707/#3628 as provenance; do not attribute this later repair to an unperformed original-author change.

## Actual source path and loss point

1. `src/responses/parser-tools.ts:41` exports `buildTools`; `pushCustom` at line 67 handles custom/freeform tools. Lines 82–84 select a tool-scoped input description: apply_patch gets exact Begin Patch envelope guidance, other custom tools get generic freeform guidance. Line 88 stores it in `parameters.properties.input.description`, and line 89 marks `freeform: true`. Namespace children route through this same function (lines 109–111), so the metadata also exists for namespaced custom tools. Reserved `functions` groups flatten to bare tools.
2. `src/responses/parser.ts:465` and `:466` call buildTools for declared and discovered tool specs. This is production ingress, not a test-only construction.
3. `src/adapters/cursor/request-builder.ts:476` createCursorRequest filters the request-visible tools then applies the existing byte/count budget at `:483`; returned tools enter the Cursor request at `:497`. `applyCursorToolBudget` (`:79`) copies/filter-selects tool objects and measures actual definitions via cursorMcpToolsEncodedSize. It does not strip the nested description.
4. `src/adapters/cursor/tool-schemas.ts:110` cursorToolInputSchema rejects reserved bare freeform shell names, but line 115 then unconditionally returns CURSOR_FREEFORM_INPUT_SCHEMA. The constant at `:37` has input.type=string, required input, and additionalProperties=false, but no input.description. This is the loss point. The normalization branch at `:125`–`:130` repeats the same replacement.
5. `src/adapters/cursor/tool-definitions.ts:80` buildCursorToolDefinitions copies only tool.description to the top-level protobuf description (`:91`), and encodes cursorToolInputSchema(tool) into inputSchema at `:92`. A top-level description of “Apply a patch” cannot replace the parser-generated nested envelope guidance.
6. Both outgoing callers use the same definitions: `src/adapters/cursor/live-transport.ts:645` stores them in execContext; `src/adapters/cursor/protobuf-request.ts:1594` constructs them for the Run request and `:1699` includes them in McpTools. The latter also decodes inputSchema for model-visible text measurement (`:1333`, consumed at `:1714`). Fixing the schema owner therefore updates both advertisement sites and their byte accounting.
7. `live-transport.ts:672` independently stores cursorToolArgNormalizeSchema(tool) in its normalization map. `src/adapters/cursor/arg-normalize.ts:69` normalizes property names; descriptions do not alter key normalization. Preserve the description in both schema selectors for a consistent per-tool schema, without changing normalization rules.

Falsification checks: `tests/responses/responses-parser.test.ts:102` already proves the parser emits apply_patch guidance, but stops before Cursor encoding. Current Cursor tests (`tests/providers/cursor/cursor-tool-definitions.test.ts:147`, `:188`) use empty parameters or missing metadata and expect the generic schema, so they cannot catch this loss. `tool-guidance.ts:187` contains code-mode/nested-helper prose and structured-edit tools provide another editing path, but neither preserves the discarded per-tool input metadata. This finding is metadata loss, not a claim that every Cursor editing path lacks all patch guidance.

## Minimal implementation scope

Class C2 bounded adapter repair, one separate implementation PABCD cycle owned by main. No new dependencies, parser changes, transport changes, tool execution, approval policy changes, facade exports, or generated protobuf updates.

| Operation | Path | Planned change |
|---|---|---|
| MODIFY | `src/adapters/cursor/tool-schemas.ts` | Add a private schema builder that copies only a string-valued input.description onto the canonical closed freeform envelope; use it after the existing reserved-name guard in both schema selectors. |
| MODIFY | `tests/providers/cursor/cursor-tool-definitions.test.ts` | Add actual buildTools-to-protobuf regressions and schema/isolation controls; retain every existing shell, reserved-name, login=false and closed-schema test. |
| MODIFY | `structure/04_transports-and-sidecars.md` | In the existing Cursor executable schema ownership section, state that tool-specific input descriptions survive canonicalization while structure remains closed. Main owns this doc during planning. |
| MODIFY | `docs-site/src/content/docs/reference/adapters.md` | Amend the existing Cursor freeform bullet to state that tool-specific input guidance is retained; no duplicate section or unrelated locales. |
| NEW | none | Reuse the current test file and registration; no new test-layout entries. |

Necessity/owner search: searched buildTools, CURSOR_FREEFORM_INPUT_SCHEMA, input.description, cursorToolInputSchema, cursorToolArgNormalizeSchema and modelVisibleToolText. A configuration change cannot recover metadata that the adapter unconditionally drops. Reuse the existing schema constant, schema module, parser, and protobuf encoder; do not copy apply_patch prose into Cursor code or import the Responses parser's object guard into the runtime adapter leaf merely for this repair.

### Proposed source patch

Insert this private helper immediately after the freeform constant (name is new; no equivalent per-tool builder exists in the inspected schema module):

```ts
function cursorFreeformInputSchema(tool: OcxTool): unknown {
  const properties = tool.parameters?.properties;
  const input = properties && typeof properties === "object" && !Array.isArray(properties)
    ? (properties as Record<string, unknown>).input
    : undefined;
  const description = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).description
    : undefined;
  if (typeof description !== "string") return CURSOR_FREEFORM_INPUT_SCHEMA;
  return {
    ...CURSOR_FREEFORM_INPUT_SCHEMA,
    properties: {
      input: { ...CURSOR_FREEFORM_INPUT_SCHEMA.properties.input, description },
    },
  };
}
```

Replace exactly the two `return CURSOR_FREEFORM_INPUT_SCHEMA;` statements in cursorToolInputSchema/cursorToolArgNormalizeSchema with `return cursorFreeformInputSchema(tool);`. Do not replace the helper's fallback return. Keep both reserved-name guards before the call.

Preserve empty descriptions as strings; do not trim or synthesize guidance. Copy no arbitrary input schema keys, sibling properties, required lists, additionalProperties flags, enums, or constraints from the input parameters. Never mutate the shared constant or tool.parameters. A freeform tool with no valid description still receives exactly the current closed canonical schema. Ordinary function/shell schemas remain untouched.

## Regression cases and independent oracles

Add an import of `buildTools` from `../../../src/responses/parser-tools` to the existing Cursor test file. Reuse existing fromBinary/toJson/ValueSchema and buildCursorToolDefinitions. Do not test only an invented OcxTool: the primary regression must run the real parser conversion.

1. **Real apply_patch ingress → schema → encoded protobuf.** Feed `buildTools([{type:"custom", name:"apply_patch", description:"Apply a patch"}])`. Assert one freeform tool and a source input.description equal to this literal:
   ``Raw tool input. For apply_patch, begin exactly with `*** Begin Patch` (no trailing `***`), then use its standard patch envelope.``
   Assert both schema selectors AND decoded `buildCursorToolDefinitions(tools)[0].inputSchema` equal an independently written object: type object; properties exactly `{input:{type:"string",description: <literal above>}}`; required exactly `["input"]`; additionalProperties exactly false. Top-level protobuf description remains `Apply a patch`. This fails at the current schema replacement, even though the parser's own test passes.
2. **Generic and namespaced custom ingress.** Build custom exec plus one namespace-wrapped custom tool (e.g. mcp__custom/exec_command) through buildTools. Their input.description must equal the independent literal `Raw freeform input for this tool.`; protobuf names retain the established namespace convention and neither schema receives apply_patch text. The namespaced shell-like custom tool remains accepted, while bare freeform exec_command/shell_command still fail existing tests.
3. **Per-tool isolation/no shared mutation.** Build two freeform fixtures with different input descriptions, e.g. `guidance-A` and `guidance-B`, plus a third metadata-free tool. Invoke both selectors and encode all three in one batch. Each output must retain only its own literal description; the third and CURSOR_FREEFORM_INPUT_SCHEMA must remain equal to the original description-free closed literal. Freeze the supplied nested parameter objects or compare their before/after values so accidental mutation is detected.
4. **Metadata is copied, shape is not.** Supply a freeform tool whose parameters declare input.type=number, extra input constraints, sibling command, required command, and additionalProperties=true, but input.description=`guidance-A`. Expected schema is still exactly closed `{input:string}` with only guidance-A retained. This prevents “fixing” the regression by returning/spreading arbitrary tool.parameters. Parameters are a Record<string, unknown>; this is reachable from direct integration callers and guards against widening their freeform contract.
5. **Absent or ill-typed description fallback.** Keep all current `{}`/missing-input positive cases. Add representative numeric/null description and non-object properties/input cases; expect the same description-free closed literal, no throw and no metadata bleed. Use labeled tuple wrappers if an array-valued case is included. An empty string description should be copied, not replaced.
6. **Existing behavior controls.** Preserve all original executable shell field assertions, both cmd/command normalization directions with login=false, reserved bare names, namespaced acceptance, code-mode and structured-edit tests. Do not refresh existing expected generic schemas into values derived from the implementation constant.

The main test is a runtime-source-to-wire contract comparison, not a test for prose in a markdown file. Full-object literal assertions catch closure/type/extra-property drift, while source-to-wire assertions prove the actual description transport path. Do not add a parallel prose owner in production.

## Verification plan (remote/CI only)

No tests, typecheck, builds, commits, or GitHub writes were performed for this investigation. Read-only source inspection and a read-only GraphQL review fetch are the evidence so far.

After Logs C, main should capture a new pinned head and run remotely:

```sh
bun test tests/providers/cursor/cursor-tool-definitions.test.ts tests/responses/responses-parser.test.ts tests/providers/cursor/cursor-request-builder.test.ts
```

Then required pinned-head typecheck/full-suite/privacy/docs build and hosted CI under the existing workflow. Preserve evidence that the new primary parser-to-protobuf regression fails on the old schema owner and passes after the repair if main performs the isolated remote RED/GREEN check; do not claim that proof before it exists.

Byte accounting risk: retaining descriptions increases encoded catalog size, so a catalog already near the cap may omit a lower-priority tool. Both budget and wire use buildCursorToolDefinitions and the same schema helper; do not bypass the cap to conceal this correction. Existing `cursor-request-builder.test.ts` budget controls around lines 537–612 must remain green. No new budget mechanism is needed.

Re-request independent review for blocker closure on the follow-up head. Main owns PR publication, exact-head CI, final review, merge proof and resolving the original late review with a link to the landed follow-up. This scratch plan does not certify the old merge gates or authorize rewriting landed history.

## Repair cycle binding

Loop archetype: bounded adapter regression repair. Trigger: review thread PRRT_kwDOS-0Gi86fmCS9. Goal: retain parser-owned per-tool input descriptions in both Cursor schema consumers without widening the closed freeform contract. Non-goals: parser semantics, shell execution, transport or approval changes. Verifier: pinned remote regression tests/typecheck/full suite and hosted CI; no local application checks. Stop: reviewed correction published and proven on dev, then original review resolved with its commit. Memory: this031 record plus ignored execution receipts. Outcomes: DONE only with evidence; a failed or unresolved gate remains open. Escalation: main reclaims the packet after two distinct worker failures; all added write scopes require a P amendment.

Main owns FSM, docs, GitHub and remote orchestration. Inherited Godel worker owns only tool-schemas.ts and cursor-tool-definitions.test.ts. Independent Nash audits this plan and a separate reviewer verifies implementation. No local test/typecheck; shared remote test lock remains respected. The repair is a child of open Logs3712, then retargets dev when its parent lands. Every original authored commit remains intact. Remotealias now depends on this correction; final landing still verifies all D changes.
