# wp2 — protect the code-mode `exec` tool from Kiro catalog-budget eviction

Unit: `260827_kiro_subagent_delegation_unblock` · work-phase `wp2`

## Why this is a separate work-phase

wp1 restored the sentence that tells a Kiro model deferred helpers exist. That
sentence is worthless if the tool it points at was never sent. Under code mode
`exec` is not one tool among many — it is the ONLY door to shell, file edits,
`apply_patch`, and every MCP helper. Dropping it does not degrade the turn, it
ends it.

Kiro currently ranks it as filler:

```ts
// src/adapters/kiro-tools.ts:175-179
function boundedCatalogPriority(tool: OcxTool): number {
  if (tool.loadedFromToolSearch) return 0;
  if (tool.toolSearch) return 1;
  return 2;
}
```

Cursor solved the same problem for the same reason and says so in the code:
*"Execution path ... outranks filler so a crowded catalog cannot drop the Codex
shell bridge (#399)"* (`cursor/request-builder.ts:52-55`).

## The trap, found by the research lane

The obvious move — give `exec` priority 0, or a new -1 — **regresses #2475**.

Priority 0 today is `loadedFromToolSearch`, and `09062014e fix(kiro): prioritize
tool search results within catalog budget (#2475)` exists precisely because Kiro
was dropping tools a `tool_search` had just loaded. Its regression test demands
the loaded tool first and the gateway second:

```ts
// tests/kiro-adapter.test.ts:764-769
expect(names.slice(0, 2)).toEqual([loadedTool.name, searchGateway.name]);
```

Sharing tier 0 makes declaration index the tie-break, so an `exec` declared
earlier silently displaces them. Tier -1 demotes them unconditionally.

Worse, the admission loop stops at the FIRST candidate that does not fit and
discards the entire remaining suffix:

```ts
// src/adapters/kiro-tools.ts:214-221
for (const [index, entry] of candidates.entries()) {
  if (convertedTools.length >= MAX_KIRO_TOOL_COUNT
    || serializedToolCatalogBytes([...convertedTools, entry.converted]) > MAX_KIRO_TOOL_CATALOG_BYTES) {
    omittedAt = index;
    break;
  }
```

So one byte-hungry tool promoted to the front can evict everything behind it.
Promoting `exec` to the very front is not a free safety improvement; it is a new
way to lose the tools #2475 protects.

## Chosen ladder

```text
0  loadedFromToolSearch      (unchanged — #2475 keeps its guarantee)
1  semantic code-mode exec   (NEW)
2  toolSearch gateway        (was 1)
3  everything else           (was 2)
```

`exec` outranks the gateway and the ordinary catalog while staying behind
already-loaded search results. The reasoning: a loaded tool is one the model
asked for by name this turn, so displacing it breaks an explicit request; `exec`
outranks the *gateway* because it reaches every nested helper on THIS turn while
the gateway needs a discovery round-trip first.

*(Corrected after audit: an earlier draft said a gateway without `exec` "can
search but never act." That is overstated —
`tests/responses-tool-conformance.test.ts:212-216` shows a searched tool becomes
callable on a later turn. The honest argument is latency and directness, not
impossibility.)*

Detection uses the shared semantic predicate `isCodexCodeModeExecTool`
(`tool-catalog-nudge.ts:31`, exported in wp1), not a name match. A structured
`exec` that runs a shell string is ordinary filler and must stay at tier 3.

## A tier alone does NOT achieve this (audit blocker 1, High)

The first draft of this document stopped at the tier change and argued that
ordering-only was a virtue: *"it cannot admit a tool that does not fit."* The
reviewer turned that sentence into a counterexample.

`src/responses/parser.ts:661-666` pushes `tool_search_output` specs with an
unbounded `loadedToolSpecs.push(...specs)`, and `:726-748` marks every one
`loadedFromToolSearch: true` — tier 0. Accumulate 48 loaded tools across a
session and the fill loop reaches `convertedTools.length >= MAX_KIRO_TOOL_COUNT`
before it ever reaches tier 1, so `exec` is omitted anyway.

That outcome is worse than it first looks. Those 48 loaded tools are reachable
ONLY as nested `tools.<name>(...)` helpers inside `exec`. Dropping `exec` to keep
all 48 produces a catalog where every admitted tool is uncallable. Keeping 47 and
`exec` produces 47 callable tools.

## Reservation, not eviction

Cursor guarantees admission by evicting occupants (`evictNonExecutionPath`,
`request-builder.ts:126-137`). Kiro will not copy that: the routine exempts only
execution-path tools, so it can evict a `loadedFromToolSearch` tool — the #2475
regression by another route.

Reserve instead. Before filling, set aside one count slot and `exec`'s serialized
bytes; fill the remaining room by priority; then admit `exec`.

The distinction is not cosmetic. Eviction removes a tool that was already
admitted, which is what makes it capable of undoing #2475. Reservation only
lowers the room the fill loop sees, so the loop admits one fewer tool and never
takes one back. #2475 asks that loaded results be prioritized *within* the
bounded catalog; it does not promise an unbounded number of them.

## Diff plan, revised

```ts
const execIndex = candidates.findIndex(entry => isCodexCodeModeExecTool(entry.tool));
const execEntry = execIndex >= 0 ? candidates[execIndex] : undefined;
// fill loop skips execEntry, checks count against (MAX - 1) and bytes against a
// projection that always includes exec, then exec is admitted after the loop
```

`omittedTools` is then derived by set difference rather than `candidates.slice`,
because `exec` is skipped during the fill and admitted afterwards. Emitted order
is restored from the sorted candidate positions, so the wire order stays
loaded -> exec -> gateway -> filler.

## Diff plan

### MODIFY `src/adapters/kiro-tools.ts`

```ts
import { isCodexCodeModeExecTool } from "./tool-catalog-nudge";

function boundedCatalogPriority(tool: OcxTool): number {
  if (tool.loadedFromToolSearch) return 0;
  if (isCodexCodeModeExecTool(tool)) return 1;
  if (tool.toolSearch) return 2;
  return 3;
}
```

Check the import direction first: `tool-catalog-nudge.ts` must not import from
`kiro-tools.ts`, or this creates a cycle.

### MODIFY `tests/kiro-adapter.test.ts`

## A wp1 test must be REPLACED, not preserved (audit blocker 2, Medium)

wp1 landed this assertion four hours ago:

```ts
// tests/kiro-adapter.test.ts:1301 "does not name a code-mode exec that the catalog budget dropped"
expect(emitted).not.toContain("exec");
expect(current.content).not.toContain("ALL_TOOLS");
```

Its fixture is 48 fillers followed by a freeform `exec` — exactly the shape wp2
now intends to make survive. Implementing wp2 without touching it guarantees a
red suite.

The two are not in conflict about behavior; they were written against different
worlds. wp1 asserted the CONSEQUENCE of exec being droppable: if the model cannot
call `exec`, do not advertise it as the execution surface. wp2 removes the
premise. The rule wp1 actually encodes — never name a tool the catalog omitted —
is still exactly right, and still needs a test.

So the fixture is re-pointed rather than deleted. wp1's rule keeps its own test
using a **structured** `exec`, which stays tier 3 and stays droppable; the
freeform fixture becomes wp2's survival test. Both invariants keep a home.

## Accept criteria

1. An over-budget catalog declaring a freeform `exec` LAST still emits `exec`,
   and the wp1 nudge then names `ALL_TOOLS`. Red-first: fails today.
2. **48 loaded tools plus a last-declared `exec`**: `exec` is emitted, exactly
   one loaded tool is omitted, and the omission notice names it. This is the
   blocker-1 reservation case; a tier-only implementation fails it.
3. An **over-budget** fixture declared gateway -> exec -> loaded emits
   loaded -> exec -> gateway with none of the three omitted.
   *(Amended per blocker 3: the fixture MUST exceed a budget. The sort at
   `kiro-tools.ts:207-211` only runs when `exceedsBudget` is true, so a
   three-tool fixture would pass identically before and after the change and
   prove nothing.)*
4. A **structured** `exec` declared last in an over-budget catalog is still
   dropped, and is still not named — the must-NOT-fire control, and wp1's
   invariant preserved on its own fixture.
5. `tests/kiro-adapter.test.ts:728` and `:789` (declared-prefix order) stay
   green: those fixtures hold only ordinary tools, all tier 3, so the
   `|| a.index - b.index` tie-break keeps them byte-identical.
6. `tests/kiro-adapter.test.ts:736-770` (#2475) stays green untouched: its
   fixture contains no `exec`, and loaded/gateway/ordinary land in distinct
   tiers 0/2/3 with no tie to break.

## Verification

```bash
bun x tsc --noEmit
bun test tests/kiro-adapter.test.ts
bun run test
```
