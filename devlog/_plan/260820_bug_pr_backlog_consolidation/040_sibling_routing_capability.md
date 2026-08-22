# 040 — Sibling B: routing capability + lab behavior evidence

Work-phase: wp5. Branch: `codex/absorb-capability-evidence`. Base: **dev**.
Absorbs: **PR #2100 and PR #2077, both by @ntdatt812**. Closes both as superseded.

## Why these two together, and why a sibling

#2100 touches `src/routing/capability.ts`; #2077 touches
`src/routing/compatibility/behavior.ts`. Disjoint files, one author, one thesis: *model-keyed
lookups must use the same resolution rules the runtime uses*. Neither depends on layers 1-2.

Note: #2077 is Lab-adjacent. Verify `tests/core-lab-boundary.test.ts` stays green — the file
already imports Lab types, so this must not newly puncture the boundary.

## Defects

#2100: bare map lookups made `gpt-oss:120b` inherit the provider-wide 8k window instead of the
`gpt-oss` family's 131072, and `noVisionModels` was ignored.
#2077: `map[modelId]` missed family/case overrides, and `constructor` resolved to
`Object.prototype.constructor`, making `jcsStringify` throw and silently dropping Lab subjects.

## Change

Route both through `modelRecordValue` / `isModelTextOnly` as @ntdatt812 wrote them. Prototype-id
safety (`constructor`, `toString`) is the load-bearing part; keep those tests verbatim.

## Test plan

Carry both test files. Confirm the exact-own maps (`modelPreferHostedTools`,
`modelOpenRouterRouting`) still do NOT family-spread.

