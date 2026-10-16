# 010 — Deferred V1 evidence from the `<tools>` world-state fragment

## Files

- NEW `src/server/responses/deferred-collab-surface.ts`
- MODIFY `src/server/responses/code-mode-collab-surface.ts` — export `analyzeCodeModeExec(tools)`
  returning `{ genuineExec: boolean; renderedV1: boolean; foreignCollabClaim: boolean }`;
  `codeModeV1Evidence()` becomes a wrapper with unchanged results. Update the header comment that says
  deferred V1 has no evidence.
- MODIFY `src/server/responses/collaboration.ts` `collabSurface()` (`:319-327`).
- NEW `tests/codex-integration/deferred-collab-surface.test.ts`; register it by appending to an
  existing line of `scripts/test-layout/layout.json` (file stays at 1999 lines) and in
  `tests/fixtures/test-layout-expected.json`.
- MODIFY `structure/subagents.md` (detection paragraph), `docs-site/src/content/docs/guides/sub-agent-surface.md`
  (v1 code-mode sentence).

## deferred-collab-surface.ts

```ts
export function deferredV1Evidence(parsed: OcxParsedRequest): boolean
```

1. Host coherence first: true only if `analyzeCodeModeExec(tools).genuineExec` or some un-namespaced
   tool has `toolSearch === true`. Otherwise false.
2. Walk `parsed.context.messages` in order; only `role === "developer"`. For string content use the
   whole string as one candidate; for array content, each `type === "text"` part separately.
3. A candidate is considered only if, after trimming surrounding whitespace, it starts with `<tools>`.
   Anything else is ignored: prose, quotes and fences that merely mention the tag never qualify.
   A considered candidate that does not end with `</tools>` is a broken envelope and counts as
   **malformed** (clears carried evidence). The body between the outer tags is validated only by the
   line grammar in step 4: a row's description is opaque (upstream copies the first description line
   unescaped, `world_state/tools.rs:54`, `tools_budget.rs:32`), so `<tools>`/`</tools>` inside a
   description is fine, while a stray envelope on its own line fails the grammar and is malformed.
4. Parse the body line by line (`\n`, ignore empty lines):
   - group headers `Deferred tool namespaces:` (snapshot), `Added deferred tool namespaces:`,
     `Removed deferred tool namespaces:`;
   - rows `- <ns>` or `- <ns>: <text>` under the current header, `<ns>` = `[^:\s]+`, `<text>` opaque;
   - omission `... <n> additional namespaces omitted.` under the current header;
   - `No deferred tool namespaces remain.`;
   - any other line, a row before a header, snapshot mixed with added/removed, or a namespace listed
     under both Added and Removed in the same fragment => malformed.
5. Apply in order to `current: Set<string>` plus `known: boolean`:
   - malformed: clear, `known=false`;
   - snapshot: `current = rows` (omitted rows unknown, not inherited);
   - diff, in this order: (a) an omission under Removed clears `current`; (b) add the explicit Added
     rows; (c) delete the explicit Removed rows. An omission under Added adds nothing;
   - empty-state line: clear.
6. Result: `current.has("multi_agent_v1")`.

### Capability boundary (audit finding 1, disposition: rebutted with evidence, documented)

The namespace row proves that at least one deferred `multi_agent_v1` tool is registered, not that
`spawn_agent` is. Upstream can only split them through an embedder-supplied `ToolPolicy.allowed_tools`
ceiling (`ext/extension-api/src/tool_policy.rs:10-44`, applied per tool in `core/src/tools/registry.rs:428`).
The only in-tree production allowlist, `reviewer_tool_policy` (`ext/guardian-reviewer/src/settings.rs:44-55`),
admits no `multi_agent_v1` tool, so the whole namespace disappears; the V1 depth limit disables the surface
as a unit (`core/src/tools/spec_plan.rs:728-740`). Codex CLI/Desktop therefore never emit a
management-only V1 namespace. A third-party embedder with a custom allowlist could; that case receives
advisory guidance it cannot act on. This is the accepted fallback for #6844 and is stated in
`structure/subagents.md` and the helper header; a test pins the namespace-only classification so a
future change to it is deliberate.

## collabSurface()

```ts
export function collabSurface(parsed: OcxParsedRequest): "v1" | "v2" | null {
  const direct = directCollabSurface(parsed.context.tools);
  const codeMode = analyzeCodeModeExec(parsed.context.tools);
  if (codeMode.renderedV1 && codeMode.foreignCollabClaim) return null;         // #6977 ambiguous
  const inferredV1 = codeMode.renderedV1 || deferredV1Evidence(parsed);
  if (!inferredV1) return direct.surface;                                       // unchanged path
  if (codeMode.foreignCollabClaim) return null;                                 // deferred V1 vs rendered V2
  return !direct.sawNativeCollabTool || direct.surface === "v1" ? "v1" : null;
}
```

Rendered-only behaviour is identical to #6977 (rendered+foreign → null; rendered alone → same rule).

## Tests (`tests/codex-integration/deferred-collab-surface.test.ts`, through `parseRequest`)

Positive: snapshot + genuine exec → v1 and Max/Ultra guidance text; structured tool_search host → v1;
additional_tools envelope; name-only row; descriptions containing `<tools>` and `</tools>` keep the
fragment valid; namespace-only classification pinned (documented capability boundary).
Gates: medium and disabled stay silent.
Replay: snapshot replaces; add-remove-add; addition without baseline; empty state clears; full
snapshot without V1 drops prior V1.
Budget: omitted snapshot rows do not establish; omitted additions do not; omitted removals invalidate
carried V1; explicit addition in that same diff survives; a diff listing `multi_agent_v1` under both
Added and Removed (with and without omitted removals) is malformed and clears evidence.
False positives: user/assistant text quoting the block; developer text embedding it mid-prose; lookalike
namespace `multi_agent_v1x`; caller function named `tool_search` without the structured marker and
no exec; malformed fragment clears carried evidence; valid V1 snapshot followed by an unterminated
`<tools>` fragment yields no deferred evidence; a stray `<tools>` line inside a fragment body is
malformed. Host guards repeated **with an otherwise valid V1 block**: exec declared as a function,
namespaced exec, exec beside a flat shell bridge, exec whose description lacks the codex-rs template
line → all null.

Continuation (`rememberResponseState` + `expandPreviousResponseInput` + `parseRequest`): the suite sets a
temporary `OPENCODEX_HOME` before any state access, resets state inside that sandbox, settles pending
persistence before cleanup and restores the environment afterwards, following
`tests/responses/responses-state.test.ts:279`. Chain: stored snapshot → continuation with no new fragment keeps v1; → continuation carrying a
Removed row → null; → later continuation carrying an Added row → v1 again; → continuation carrying
`No deferred tool namespaces remain.` → null.
Combination: direct V1 agrees; direct V2 conflicts → null; rendered V2 listing + deferred V1 → null;
MCP collaboration-named tools keep existing rules; deferred evidence never yields v2.

## Verification

`bun test` (Bun 1.4.3) on the new file, `tests/codex-integration/code-mode-collab-surface.test.ts`,
`multi-agent-compat.test.ts`, `effort-policy.test.ts`; `bun run typecheck`; layout, tooling and
file-size guards; `bun run structure:check`; `bun run privacy:scan`.

