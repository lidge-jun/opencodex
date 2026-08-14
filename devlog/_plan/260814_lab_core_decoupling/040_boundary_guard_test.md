# 040 — Phase 4: make the boundary executable

Unit: `260814_lab_core_decoupling`. Depends on: phases 1–3.

## Why this phase exists

Phases 1–3 restore the boundary once. Nothing stops the next well-intentioned patch from
adding `import { something } from "../lab/..."` to `responses/core.ts` — which is exactly
how the current state arose. CL-01 through CL-09 each passed CI and automated review.

A prose rule in `AGENTS.md` would not have caught it. A test does.

This repository already treats structural invariants as tests: `tests/repo-hygiene.test.ts`
asserts no `160000` gitlink is tracked and no vendored reference clone reappears, and both
were driven red once to prove they are not vacuous. This phase follows that precedent.

## NEW: `tests/core-lab-boundary.test.ts`

### Guard 1 — no static Lab import in core files

```ts
const CORE_FILES = [
  "src/router.ts",
  "src/server/index.ts",
  "src/server/lifecycle.ts",
  "src/server/responses/core.ts",
] as const;

const FORBIDDEN = /^\s*import\s[^;]*from\s+["'][^"']*(?:\/|^)(?:lab\/|routing\/compatibility\/)/m;
```

For each core file, read the source and assert no matching import line. The message names
the offending file, the import, and points at this devlog unit, so whoever trips it learns
why rather than deleting the assertion.

### Guard 2 — the module graph, not just the text

Text matching alone is insufficient: the original defect reached Lab through
`assemble.ts → routing/quota.ts → providers/quota.ts → codex/auth-api.ts →
codex/native-main-admission.ts → server/lifecycle.ts → lab/automation/orchestrator.ts`,
where no single file looked wrong.

Walk the transitive relative-import graph from each core file and assert that no
`src/lab/` module is reachable. Implementation notes:

- Parse `from "..."` specifiers, resolve relative ones against the importing file, try
  `.ts` then `/index.ts`.
- Skip `import type` — type-only imports are erased and cost nothing at runtime. This is a
  real distinction, not a loophole: the runtime property under test is module evaluation.
- Track visited paths so the known cycles terminate.
- On failure, print the **full chain** from core file to Lab module. A bare "Lab is
  reachable" verdict would send the next maintainer on the same multi-hour hunt this unit
  required.

### Guard 3 — behavioral proof

Structure is a proxy for the property the owner actually asked for. Assert the property
directly: build a config with zero routing profiles, install an instrumented linker slot,
run a request through the responses handler, and assert the slot was never invoked and
`labRouteSubjectId` is absent from the resulting attempt.

### Guard 4 — the positive case still works

A guard that only forbids can be satisfied by deleting the feature. Assert that with a
routing profile configured and Lab activated, the passive linker is invoked and
compatibility evidence reaches the evaluator.

## Proving the guards are not vacuous

Per the repository's own precedent, each guard is driven red once before the unit closes:

1. Guard 1 — temporarily add `import { labRoot } from "../lab/paths";` to
   `responses/core.ts`, confirm failure, revert.
2. Guard 2 — temporarily restore the `lifecycle.ts` Lab import, confirm the chain is
   printed, revert.
3. Guard 3 — temporarily register the Lab linker unconditionally, confirm failure, revert.
4. Guard 4 — temporarily skip activation, confirm failure, revert.

The red-run output is recorded in `050` as evidence.

## MODIFY: `AGENTS.md`

Add a short subsection under repository layout stating the invariant and naming the test
that enforces it, so a contributor meets the rule before CI does:

> **Optional subsystems stay off the core path.** `src/lab/` (Compatibility Lab) is
> opt-in. `src/router.ts`, `src/server/index.ts`, `src/server/lifecycle.ts`, and
> `src/server/responses/core.ts` must not import it, directly or transitively — enforced by
> `tests/core-lab-boundary.test.ts`. Optional subsystems register into core-owned slots at
> activation. An install with no routing profile must execute no Lab code.

## Accept criteria

- All four guards pass on the phase-3 tree.
- Each guard has been driven red once, with output recorded.
- `bun x tsc --noEmit` exits 0.
