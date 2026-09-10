# wp1 — restore `ALL_TOOLS` discovery for Kiro code-mode turns

Unit: `260827_kiro_subagent_delegation_unblock` · work-phase `wp1`

> **P-phase amendment, 2026-08-27.** The original draft of this document assumed
> the fix had to be a truncation-strategy change inside `truncateDescription()`.
> Re-reading the tree at P found the discovery sentence **already written and
> already shipped** in `src/adapters/tool-catalog-nudge.ts:122`, injected as a
> system nudge that bypasses the 1024 cap entirely — and found that Kiro is the
> one adapter that never enables it. The root cause moved one file; the fix got
> much smaller. The superseded preserve-tail design is kept below as the
> rejected alternative, because the reasoning about *why* the tail matters is
> what led here.

## The one sentence that must arrive

```text
Some deferred nested tools may be omitted from this description. They are
still available on the global `tools` object and listed in `ALL_TOOLS`.
```

~150 chars. Everything the parent needs to discover `spawn_agent` is in it.
A Kiro Claude model currently receives none of it, because the cap keeps the
first 1024 chars of a 5.5 KB description and this sentence is not in that
window.

## Why head-truncation is the wrong shape here

`truncateDescription()` (`src/adapters/kiro-tools.ts:150`) is a pure prefix
slice with a surrogate-safe boundary. It is correct as a byte-safety routine
and wrong as a *documentation* routine: it assumes the first N chars are the
most valuable N chars.

For `exec` that assumption inverts. The head is prose framing ("Run JavaScript
code to orchestrate/compose tool calls"), which the model can infer from the
tool name. The tail carries the discovery contract and the type declarations,
which it cannot infer at all.

## Candidate approaches

### A. Preserve-tail truncation for `exec` only — recommended

Keep the cap. Change *which* 1024 chars survive for the code-mode tool: keep a
head budget for framing, then append the discovery sentence verbatim.

Sketch:

```ts
const KIRO_DISCOVERY_HINT =
  "Deferred nested tools are omitted here; they are callable as "
  + "`await tools.<name>(...)` and enumerable via the `ALL_TOOLS` global.";
```

When a description exceeds the limit **and** the original text contains
`ALL_TOOLS`, reserve the hint's length, head-truncate to `limit - hint.length`,
and append. Output stays exactly at the cap, so the wire-size property the cap
exists to protect is unchanged.

- Payload size: identical to today (still capped at 1024).
- Blast radius: only descriptions that mention `ALL_TOOLS` — in practice the
  single code-mode `exec` tool.
- Does not touch the prompt, so `tests/kiro-adapter.test.ts:700`
  (`not.toContain("### Tool documentation")`) stays green.

### B. Per-tool allowlist limit

Give `exec` a larger cap while every other unverified-model tool stays at 1024.
Simple, but it is a narrower version of the change that previously broke Kiro,
and it needs a live probe per model family to establish the real ceiling. Keep
as fallback if A proves insufficient.

### C. Do nothing in the adapter; fix upstream ordering

Ask for the discovery sentence to move to the top of the `exec` description.
Correct in principle, out of this repository's control, and leaves every
shipped Codex version broken. Rejected as the primary path.

## Chosen path

**A**, with **B** held in reserve.

## Implementation targets

| file | change |
|---|---|
| `src/adapters/kiro-tools.ts` | add discovery-preserving branch inside the truncation path |
| `tests/kiro-adapter.test.ts` | regression next to the existing cap test at :690 |

## Regression contract

The new test must assert all four, or it is not proving the fix:

1. A >1024-char description containing `ALL_TOOLS` still yields
   `spec.description.length === 1024` for an unverified model.
2. That output **contains** `ALL_TOOLS`.
3. A >1024-char description **without** `ALL_TOOLS` is byte-identical to
   today's behavior (plain head-truncate ending in `…`).
4. `current.content` still does not contain `### Tool documentation`.

Assertion 3 is what keeps this from becoming a general cap change. Drive the
test red once before wiring the fix — a preserve-tail assertion passes
vacuously if the fixture description happens to be under the cap.

## Verification

```bash
bun x tsc --noEmit
bun test tests/kiro-adapter.test.ts
```

Focused per `AGENTS.md`: this is a scoped adapter change, not shared runtime.

## Exit criterion

A live `kiro/claude-opus-5` task, asked what tools it has, names
`multi_agent_v1__spawn_agent` **without being told where to look**. Today the
same prompt returns "No spawn/subagent tool exists in my current tool catalog."
