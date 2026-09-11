# Kiro subagent delegation — unblock parallel spawning

Unit: `260827_kiro_subagent_delegation_unblock` · opened 2026-08-27

## Owner decision that scopes this unit

Two things that look like defects are deliberate and stay:

- The **1024-char description cap** for unverified Kiro models is intentional.
  Raising it broke Kiro before (see "Why the cap exists"), so this unit does not
  raise it as a blanket change.
- The **5-model `spawn_agent` override list** is intentional
  (`MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT = 5`). Not a bug, not in scope.

What the owner *does* want: **Kiro subagents allowed to spawn in parallel,
without a depth ceiling.** That is the goal of this unit.

## Symptom (measured, not inferred)

A top-level `kiro/claude-opus-5` task reports that no delegation tool exists:

> No spawn/subagent tool exists in my current tool catalog.

It then lists a 26-name top-level surface with no `spawn_agent` in it. The tool
is in fact registered — a forced `ALL_TOOLS` probe in the same session found
`multi_agent_v1__spawn_agent` at 6598 chars with `model`, `reasoning_effort`,
and `service_tier` all intact.

So the capability is present and the model cannot see it.

## Mechanism

> **Superseded by the P-phase re-read. See `011_root_cause_nudge_gap.md`.**
> The truncation described below is REAL and measured, but it is the second
> line of defense, not the cause. The actual cause is that
> `src/adapters/kiro.ts:477` omits the optional `codeModeExecName` argument, so
> `codeModeExecWireName()` returns `undefined` and Kiro receives a generic
> fallback sentence that never names `ALL_TOOLS` — regardless of any cap.
> This section is retained because the truncation evidence is what located the
> gap, and because the cap would re-break discovery if the nudge ever regressed.

Codex code mode does not advertise `spawn_agent` at the top level. It defers the
nested tools and tells the model where to look, inside the `exec` tool
description:

> Some deferred nested tools may be omitted from this description. They are
> still available on the global `tools` object and listed in `ALL_TOOLS`.

That sentence sits past the 1024-char mark. `toolDescriptionLimit()` in
`src/adapters/kiro-tools.ts:143` gives 9216 chars to `gpt-5.6-sol` and 1024 to
every other Kiro model, so a Claude-family Kiro model receives `exec` truncated
at exactly 1024 chars ending in `…`.

Confirmed from inside the Kiro session:

| probe | Kiro model sees | control (native) |
|---|---|---|
| `exec` description length | ~1010-1020, ends `…` | full |
| contains `ALL_TOOLS` | NO | YES |
| contains `Some deferred nested tools…` | NO | YES |
| contains `Shared MCP Types` / `declare const tools` | NO | YES |

The failure chain, as corrected at P:

```text
kiro.ts:477 omits codeModeExecName
  -> codeModeExecWireName() returns undefined
  -> generic fallback replaces the ALL_TOOLS sentence in the system nudge
  -> (and independently: exec's own description is cut at 1024, removing it there too)
  -> model concludes no spawn tool exists
  -> zero delegation attempts, no model/effort/tier override ever formed
```

The model is not misreading the spawn schema. It never learns the schema is
reachable.

## Why the cap exists (do not regress this)

`devlog/_fin/143_kiro-gateway-parity/125_phase_tool_fallback_hardening.md`
originally moved long descriptions **into the system prompt** and left a pointer
in the tool spec. That was later replaced: `tests/kiro-adapter.test.ts:690` is
now named *"tool descriptions use deterministic model-specific caps **without
prompt injection**"* and asserts `current.content` does **not** contain
`### Tool documentation`.

So there are two rejected designs already on record:

1. Send the full long description to Kiro — the reason the cap was added.
2. Relocate it into the prompt — explicitly reverted; the test now guards
   against it.

Any proposal in this unit that reintroduces either is out of bounds.

## Design constraint that follows

> **Superseded.** This section reasoned toward a truncation-strategy fix inside
> `kiro-tools.ts`. The implemented direction is `011`: pass `codeModeExecName`
> at the nudge call site, which delivers the discovery contract as system text
> and never touches the cap.

The reasoning is kept because its conclusion still holds and still constrains
the unit: the load-bearing content is ONE sentence (`ALL_TOOLS` discovery), not
the 5.5 KB of type declarations around it. That is why a system-nudge delivery
works — it carries the sentence without carrying the payload.

It also names the residual risk `012` records: the nudge is truncated from the
TAIL under budget pressure, and the code-mode sentence sits late in it. Today
there is ~10 KB of headroom, so the risk is dormant, not absent.

## Work phases

| phase | file | scope |
|---|---|---|
| wp1 | **`011_root_cause_nudge_gap.md`** | pass `codeModeExecName` at Kiro's nudge call site so the shipped `ALL_TOOLS` sentence reaches Kiro |
| wp2 | `020_unbounded_kiro_delegation.md` | remove the depth-1 ceiling for Kiro parents (host config, not code) |
| wp3 | `030_verification.md` | live proof + full gates + PR against `dev` |

`010_exec_discovery_preservation.md` is **superseded** by `011`. It is retained
for its reasoning about why the description tail matters, which is what led to
finding the real call-site gap. Do not implement from `010`.

wp1 is a prerequisite for wp2. Lifting the depth ceiling changes nothing while
the parent still believes the tool does not exist.

## Non-goals

- Raising `MAX_KIRO_TOOL_DESCRIPTION_UNVERIFIED` as a blanket change.
- Changing `MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT`.
- Reintroducing tool documentation into the Kiro system prompt.
- Touching `multi_agent_version` catalog pins — `kiro/claude-opus-5` already
  pins `v1` correctly in both `~/.codex/models_cache.json` and
  `~/.codex/opencodex-catalog.json`.
