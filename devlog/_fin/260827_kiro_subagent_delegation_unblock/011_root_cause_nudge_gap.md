# wp1 (revised) — Kiro never enables the code-mode nudge

Unit: `260827_kiro_subagent_delegation_unblock` · work-phase `wp1`

Supersedes the approach in `010`. Same symptom, correct mechanism, much smaller
fix.

## The sentence already exists

`src/adapters/tool-catalog-nudge.ts:122` already emits exactly what the Kiro
model was missing, as a **system nudge** rather than a tool description:

> Absence from the top-level catalog or from `exec`'s description is not
> absence: deferred helpers stay callable on `tools.<name>`. Discover them from
> the isolate global `ALL_TOOLS`, not `tools.ALL_TOOLS`.

This is emitted only when `verifiedCodeModeExecName` is truthy. Otherwise the
builder falls through to a generic sentence that never names `ALL_TOOLS`:

> If a listed tool exposes nested helpers such as a tools.* API, call the listed
> parent tool and use those helpers only inside that tool's input.

That fallback is what Kiro receives today.

## Why Kiro alone falls through

There are two entry points into the same builder, and they are not equivalent:

| entry point | passes `codeModeExecName`? | used by |
|---|---|---|
| `buildNonOpenAIToolCatalogNudgeForTools` (:133) | yes — detects via `isCodexCodeModeExecTool` | anthropic, google, openai-chat, command-code |
| `buildNonOpenAIToolCatalogNudgeFromNames` (:98) | only if the caller supplies it | **kiro (:477)** |

`src/adapters/kiro.ts:477` calls the name-only entry point with two arguments
and omits the optional third:

```ts
const toolCatalogNudge = buildNonOpenAIToolCatalogNudgeFromNames(
  kiroToolWireNames(kiroTools),
  name => advertisedAlias.get(name) ?? name,
);                       // <- codeModeExecName never supplied
```

`codeModeExecWireName()` (:90) then returns `undefined` for the reason its own
doc comment states: the name-only path *cannot* decide code mode, because
`kiroToolWireNames()` (`kiro.ts:111`) has already reduced the tool objects to
strings and thrown away the `freeform` flag that distinguishes Codex's
JavaScript `exec` from an ordinary structured tool named `exec`.

So this is not a missing feature. It is a **capability the module documents,
implements, and tests — that Kiro's call site never opts into.**

## Corrected causal chain

```text
kiro.ts reduces tools to wire names (freeform flag lost)
  -> codeModeExecName omitted at the call site
  -> codeModeExecWireName() returns undefined
  -> generic fallback sentence replaces the ALL_TOOLS sentence
  -> model never learns deferred helpers are discoverable
  -> "No spawn/subagent tool exists in my current tool catalog."
```

The 1024-char cap is real and does delete the same sentence from the `exec`
description — but it is now the *second* line of defense, not the cause. Fixing
the nudge restores discovery without touching the owner-confirmed cap at all.

## Diff plan

### MODIFY `src/adapters/kiro.ts`

Detect code mode from `parsed.context.tools` — the objects, while `freeform` is
still present — then map to the Kiro wire alias and pass it in.

Constraints that make this non-trivial and must be honored:

1. **Alias coordinate system.** The nudge compares `codeModeExecName` against
   the advertised set, which for Kiro holds *aliases* (`registry.alias()`
   output), not raw wire names. Pass the alias or the guard silently rejects it.
2. **Never call `registry.alias()` to resolve it.** `alias()` REGISTERS
   (`kiro-wire.ts:90-95`: on a miss it calls `kiroToolName`, writes `wireToKiro`,
   and may write `nameMap`). The existing comment at `kiro.ts:471-474` warns that
   calling it for a non-advertised tool pollutes the collision domain. Read
   `advertisedAlias`, which is already built directly above the call site.
3. **Respect `tool_choice`.** `convertKiroToolContext` drops every tool when
   `toolChoice === "none"` (`kiro-tools.ts:189`); a code-mode name must not be
   advertised for a turn whose catalog is empty.
4. **Both predicates run over the EMITTED catalog, not the requested list.**
   *(Amended after audit round 1, blocker 1 — High.)*

   The naive implementation evaluates `isCodexCodeModeExecTool` and
   `isBareShellBridgeTool` over `parsed.context.tools`. That is wrong in a
   reproducible way, and the reviewer reproduced it with a 49-tool catalog:
   `exec` is emitted while `exec_command` is dropped by the count/byte budget
   (`kiro-tools.ts:215-218`). Scanning the REQUESTED list then finds the omitted
   bridge and suppresses code mode — even though the catalog the model actually
   receives is code-mode-shaped and has no shell bridge in it.

   The model can only call what was emitted, so the shape that matters is the
   emitted one. Resolve BOTH predicates over requested tool objects whose
   resolved alias is present in the emitted-name set:

   ```ts
   const emitted = new Set(kiroToolWireNames(kiroTools));
   const inCatalog = (t: OcxTool) =>
     emitted.has(advertisedAlias.get(namespacedToolName(t.namespace, t.name))
       ?? namespacedToolName(t.namespace, t.name));
   ```

   This keeps constraints 3 and 4 satisfied by construction: an empty catalog
   yields an empty `emitted` set, so nothing can be named.

### MODIFY `src/adapters/tool-catalog-nudge.ts`

Export `isCodexCodeModeExecTool` and `isBareShellBridgeTool` so `kiro.ts` reuses
the shared predicates instead of duplicating the semantics. Both are currently
module-private; no behavior change, export only.

### MODIFY `tests/kiro-adapter.test.ts`

See `030_verification.md` for the regression contract.

## Scope boundary

IN: the Kiro call site, two predicate exports, tests.
OUT: `MAX_KIRO_TOOL_DESCRIPTION_UNVERIFIED`, `MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT`,
the nudge's wording, every other adapter.

## Accept criteria

1. A Kiro turn advertising a freeform `exec` and no bare shell bridge produces a
   system prefix containing `ALL_TOOLS`.
2. A Kiro turn advertising a **structured** `exec` (`freeform` absent) does NOT
   contain `ALL_TOOLS` — it keeps the generic fallback. This is the assertion
   that proves the semantic predicate is doing the work rather than a name match.
3. A Kiro turn advertising `exec` **and** `exec_command` does NOT claim code
   mode: that is the flat-bridge shape.
4. **Emitted-catalog resolution, both directions** *(amended, blocker 1/2):*
   - 4a. A budget-omitted `exec_command` beside an emitted freeform `exec` still
     yields code mode. This is the blocker-1 regression and it must be driven
     red first.
   - 4b. A budget-omitted `exec` is NOT named, even though it was requested.

   The original criterion 4 ("the name reaching the nudge is the alias") is
   **withdrawn as non-discriminating**. The reviewer is right: the only valid
   code-mode tool is bare `exec`, and `kiro-wire.ts:53-55` passes an already-
   valid name through unchanged, so asserting `alias === "exec"` cannot tell a
   correct alias lookup from a raw-name shortcut. Alias transformation is
   covered at its own seam in `tests/kiro-wire`-level naming tests; membership
   in the emitted catalog is what this unit must prove.
5. `tests/kiro-adapter.test.ts:690` stays green — no prompt-injected tool docs.

Criteria 2 and 4b are the activation-grounding controls
(C-ACTIVATION-GROUNDING-01): they are the cases that must NOT fire. Without
them a name-only implementation passes every other assertion.

## Verification

```bash
bun x tsc --noEmit
bun test tests/kiro-adapter.test.ts tests/tool-catalog-nudge.test.ts
bun run test          # required: this is an adapter change (src/AGENTS.md:26)
```

`bun run test` is the completion gate, not the focused run *(amended, blocker
4)*. `src/AGENTS.md:26` requires the full suite for adapter behavior, and this
change is in the adapter layer.

## Documentation disposition *(blocker 5 — rebutted with evidence)*

`src/AGENTS.md:28` requires a `docs-site/` update when a change affects
user-visible behavior or configuration.

**Correction (audit round 2).** An earlier draft of this section claimed the
behavior was undocumented and cited a no-hit `rg`. That was wrong — the search
covered `reference/` and missed `guides/`. The behavior IS documented:

`docs-site/src/content/docs/guides/codex-integration.md:314-316`:

> In normal routed code mode, Codex can expose deferred MCP/app tools through
> the official `exec` tool's `tools` global and `ALL_TOOLS`; that path does not
> require the model to see or call `tool_search`.

That page is written adapter-neutrally and describes the behavior this change
RESTORES for Kiro. So the page does not become wrong — it becomes true for one
more provider. No `docs-site/` edit is required to keep the docs honest, which
is what `src/AGENTS.md:28` exists to protect.

The correction matters more than the conclusion it survived. The original
rebuttal reached the right answer through a false premise: had the guide instead
said this path works on every routed provider, the same evidence would have
demanded a docs change, and a no-hit `rg` would have hidden that.

No configuration surface, flag, or command is added. The devlog unit is the
durable record. A `reference/` section covering the nudge across ALL adapters
would be a genuine improvement, but it is its own unit, not a rider on a
one-provider parity fix.
