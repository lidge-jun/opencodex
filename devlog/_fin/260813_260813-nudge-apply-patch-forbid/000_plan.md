# 000 — 260813-nudge-apply-patch-forbid: Plan

> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## Objective

Stop the injected tool-catalog nudge from telling routed non-OpenAI models that
`apply_patch` is off-limits. Today every code-mode turn against a routed provider
carries a sentence that forbids the exact tool Codex wants the model to use, so the
model falls back to `python3 - <<'END'` heredocs and `sed` for edits.

### Observed failure

User-reported: after a recent update, routed (external) models stopped emitting
patch-shaped edits and started rewriting files with `python3` heredocs. The Codex
UI shows `Ran python3 - <<'END' from pathlib import Path...` instead of an
`Edited <file>` diff row.

### Root cause

`src/adapters/tool-catalog-nudge.ts` holds:

```ts
const NEIGHBOR_AGENT_TOOL_NAMES = ["Read", "Grep", "Glob", "Bash", "LS", "apply_patch"];
...
const unavailableNeighborNames = NEIGHBOR_AGENT_TOOL_NAMES.filter(name => !advertised.has(name));
```

`advertised` is built from the FLAT wire tool-name list. Under Codex **code mode**
the wire catalog is roughly `exec`/`custom_exec`, `wait`, `request_user_input`,
`web_search` — and `apply_patch` is NOT a top-level entry. It is a nested helper
declared inside the `exec` tool's own description:

```ts
declare const tools: { apply_patch(input: string): Promise<unknown>; };
```

So `advertised.has("apply_patch")` is false on every code-mode turn, and the nudge
emits:

> Do not use neighboring-agent tool names `Read`, `Grep`, `Glob`, `Bash`, `LS`,
> `apply_patch` unless this turn's catalog lists those exact names.

That sentence lands in the same system prompt as Codex's own "Use `apply_patch` for
local file edits", and the later, more specific prohibition wins.

### Why `apply_patch` never belonged in that list (audit-revised)

The introducing commit `cc59cc596` states the intent: models "stop calling
neighbor-agent tools (Read/Grep/Bash/...) that exist only in **other harnesses**."
`apply_patch` is not another harness's tool - it is Codex's own first-class edit
tool. The sibling implementation confirms the list was over-broad here:
`src/adapters/cursor/tool-definitions.ts:21` uses
`["Read", "Grep", "Glob", "Bash", "LS"]` with **no** `apply_patch`.

### Scope correction (A-gate blocker 3)

The defect is NOT every routed turn. `src/responses/parser.ts:166-175` keeps a real
Responses `{type:"custom", name:"apply_patch"}` declaration as a top-level tool, so
in that catalog `advertised.has("apply_patch")` is true and nothing is forbidden
(locked by `tests/responses-parser.test.ts`). The false prohibition fires
specifically when the client advertises patching only as a nested helper inside the
`exec` tool - the Codex **code mode** catalog, which is exactly the reported case.


### Evidence base (live, this session)

| Source | Evidence |
|---|---|
| `kimi/k3[1m]` subagent (routed) | "my tool contract explicitly forbids calling `apply_patch` by that bare name" |
| `xai/grok-4.6` subagent (routed) | quoted the forbid sentence verbatim alongside Codex's "Use `apply_patch`" line |
| `gpt-5.6-sol` subagent (native, NOT routed through ocx) | no forbid sentence present — control case |
| main session (routed) | same forbid sentence present while `tools.apply_patch` executes successfully |

The native-vs-routed contrast localizes the injection to ocx, not to Codex.

## Loop-spec

- Loop archetype: verifier-defined (spec-satisfaction repair).
- Write scope: `src/adapters/tool-catalog-nudge.ts`, `tests/tool-catalog-nudge.test.ts`.
- Out of scope: `src/responses/parser.ts` freeform conversion, `src/bridge.ts`,
  `src/responses/custom-tool-compat.ts`, `codex-rs`, GUI, docs-site, version bumps.
- Budget: one work-phase; full suite runs on `ssh lidge`; push to `dev` with
  `--no-verify` per explicit user instruction.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010_phase1.md | Nested-reachability detection in the nudge + regressions | — |

## Accept criteria

- c1: the nudge never names `apply_patch` in the forbid clause, for any catalog shape and every adapter (including Kiro's names-only call site).
- c2: genuinely absent neighbor names (`Read`/`Grep`/`Glob`/`Bash`/`LS`) are still forbidden.
- c3: repository suite on `ssh lidge` green, or zero NEW failures versus baseline.
- c4: a post-fix routed-model subagent reports no `apply_patch` forbid sentence.
