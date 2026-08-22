# 010 - Phase 1 (260813-nudge-apply-patch-forbid)

> Audit-revised after A-gate VERDICT: FAIL (3 High blockers). The original
> description-regex design is WITHDRAWN; see 'Rejected design' below.

## MODIFY / NEW / DELETE map

### MODIFY `src/adapters/tool-catalog-nudge.ts`

One-line deny-list correction. BEFORE:

```ts
const NEIGHBOR_AGENT_TOOL_NAMES = ["Read", "Grep", "Glob", "Bash", "LS", "apply_patch"] as const;
```

AFTER:

```ts
// Neighbor-agent tools are names that exist only in OTHER harnesses (Claude Code, etc.).
// `apply_patch` is Codex's own first-class edit tool and is deliberately NOT listed: under
// Codex code mode it is reachable as a nested `tools.apply_patch(...)` helper declared inside
// the `exec` tool description rather than as a top-level wire tool, so a flat catalog check
// cannot see it. Forbidding it there pushed routed models into `python3` heredoc edits.
// The sibling list in src/adapters/cursor/tool-definitions.ts has always omitted it.
const NEIGHBOR_AGENT_TOOL_NAMES = ["Read", "Grep", "Glob", "Bash", "LS"] as const;
```

No signature change, so NO call site changes are needed:
`anthropic.ts`, `openai-chat.ts`, `google.ts`, `command-code.ts`, `kiro.ts`.
This also resolves A-gate blocker 2 (Kiro's names-only call site) for free, since the
correction is in the shared constant rather than in a description-inference path.

### MODIFY `tests/tool-catalog-nudge.test.ts`

The existing test `"does not forbid neighboring tool names that are actually listed"`
asserts the forbid clause CONTAINS `apply_patch` and must be revised intentionally
(A-gate noted this as the one deliberate test change).

## Rejected design (A-gate blocker 1)

Scanning tool descriptions with a regex such as
`/(?:^|[^A-Za-z0-9_])apply_patch\s*(?:\(|:)/` was rejected: it false-positives on prose
like `do not call apply_patch(input)` and `unavailable API: apply_patch: string`.
Inferring capability from free text is the wrong mechanism when the correct fix is to stop
asserting a falsehood about a tool this proxy does not own.

## TESTS

`tests/tool-catalog-nudge.test.ts`:

1. REVISE `"does not forbid neighboring tool names that are actually listed"` - drop the
   `apply_patch` expectation; assert the clause is exactly ``Read`, `Grep`, `Bash`, `LS``.
2. NEW `"never forbids apply_patch, which Codex owns"` - names `["exec_command"]`;
   assert the note does NOT contain `apply_patch` anywhere, and DOES still forbid
   ``Read`, `Grep`, `Glob`, `Bash`, `LS``.
3. NEW `"still forbids apply_patch-free neighbor set via ForTools"` - build from OcxTool
   values including an `exec` tool whose description declares the nested helper; assert the
   same absence, proving the code-mode catalog shape is covered end to end.

## Verification (C)

```bash
# local, focused
bun test tests/tool-catalog-nudge.test.ts     # expect exit 0
bun test tests/cursor-tool-definitions.test.ts tests/cursor-blob.test.ts   # sibling list untouched

# ssh lidge, full suite (per user instruction)
ssh lidge 'cd ~/Developer/opencodex && git fetch origin && git checkout dev && git pull && bun install && bun run test'
```

Live re-probe: after the fix reaches the running proxy, spawn a routed-model subagent
(`kimi/k3[1m]` or `xai/grok-4.6`) and ask it to quote any sentence forbidding
`apply_patch`; expect NONE.

## Bug 2 - wire-coordinate mismatch (user-reported, reproduced)

The same one-line filter compares two DIFFERENT name coordinate systems:

```ts
const unavailableNeighborNames = NEIGHBOR_AGENT_TOOL_NAMES.filter(name => !advertised.has(name));
```

`advertised` holds WIRE names (post-`toWire`), while `NEIGHBOR_AGENT_TOOL_NAMES` holds
LOGICAL names. Whenever a provider rewrites tool names, the membership test can never
match, so every neighbor name is declared unavailable even when it is right there in the
catalog.

Prefixing paths in the tree:

| Path | toWire | Source |
|---|---|---|
| Claude OAuth (Pro/Max) | `custom_` prefix | `src/oauth/anthropic.ts:21` applyClaudeToolPrefix |
| Anthropic compat | `cx_` prefix | `src/adapters/anthropic.ts:554` |
| others | identity | `src/adapters/anthropic.ts:558` |

### Reproduction (executed, `bun run` against the real module)

CASE A - identity toWire, tools = shell/apply_patch/read_file:

> ... Valid tool names ... `shell`, `apply_patch`, `read_file`. ... Do not use
> neighboring-agent tool names ``Read`, `Grep`, `Glob`, `Bash`, `LS``

Correct: apply_patch is advertised, so it is not forbidden.

CASE B - SAME tools through applyClaudeToolPrefix:

> ... Valid tool names ... `custom_shell`, `custom_apply_patch`, `custom_read_file`.
> ... Do not use neighboring-agent tool names ``Read`, `Grep`, `Glob`, `Bash`, `LS`, `apply_patch``

WRONG: `custom_apply_patch` IS in the catalog, yet `apply_patch` is forbidden in the
same sentence. This fires on ordinary (non-code-mode) Claude subscription turns.

CASE C - code-mode catalog (exec/wait/request_user_input): apply_patch forbidden (Bug 1).

### Fix for Bug 2

Compare in ONE coordinate system by mapping the neighbor names through the same
`toWire` the catalog used, and treat EITHER form as advertised:

```ts
export function buildNonOpenAIToolCatalogNudgeFromNames(
  wireNames: readonly string[] | undefined,
  toWireName: (name: string) => string = name => name,
): string | undefined {
  const names = uniqueNames(wireNames ?? []);
  if (names.length === 0) return undefined;

  const advertised = new Set(names);
  // Compare in the catalog's own coordinate system: a provider that rewrites tool names
  // (Claude OAuth `custom_`, Anthropic compat `cx_`) would otherwise never match a neighbor
  // name and would forbid tools the turn actually advertises.
  const unavailableNeighborNames = NEIGHBOR_AGENT_TOOL_NAMES.filter(
    name => !advertised.has(name) && !advertised.has(toWireName(name)),
  );
```

`buildNonOpenAIToolCatalogNudgeForTools` already receives `toWireName` as its third
parameter; it forwards a name-only adapter of it. Anthropic's call site passes
`toolNames.toWire(namespacedToolName(...))`, so the nudge builder derives the bare-name
transform from the same function object.

### Additional tests for Bug 2

4. NEW `"does not forbid a neighbor name the catalog advertises under a wire prefix"`
   - names `["custom_shell", "custom_apply_patch"]` with `toWireName = applyClaudeToolPrefix`;
   assert `Read`/`Grep`/`Glob`/`LS` still forbidden but nothing about apply_patch.
5. NEW `"maps every neighbor name through toWire"` - names `["cx_Read", "cx_Bash"]`
   with `toWireName = n => "cx_" + n`; assert `Read` and `Bash` are NOT forbidden while
   `Grep`/`Glob`/`LS` are.

Note: Bug 1's fix (dropping apply_patch from the list) and Bug 2's fix are independent and
both required - Bug 2 also mis-forbids Read/Grep/Glob/Bash/LS on every prefixing provider.
