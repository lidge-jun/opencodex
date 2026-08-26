# 020 — wp3: #2483, capitalized and dotted Claude ids must classify as adaptive

Phase: wp3. Depends on: wp1. PR: #2483, head `3304814c5`, author `L-Y-J`.

> Numbering note: the decade order follows the corrected dependency order from
> 000 (runtime fixes first, #2427 last). wp2 (#2427) is documented at 070.

## Defect

`claudeFamilyVersion` in `src/adapters/anthropic.ts` parses a model id into
`{family, major, minor}`. On `dev` the regex is lowercase-and-dash only:

```ts
/(?:^|\/)claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/
```

A vendor id like `Claude-Opus-4.8-joybuilder` matches nothing, so
`meetsFamilyMinimum` (`src/adapters/anthropic.ts:481-489`) returns false, so
`usesAdaptiveThinking` (`:492-494`) is false, so the request falls through to
the legacy branch at `:948-958`:

```ts
body.thinking = { type: "enabled", budget_tokens: budget };
```

Adaptive-thinking models reject that shape. The PR reports the exact upstream
response:

```
ValidationException: "thinking.type.enabled" is not supported for this model.
Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
```

This is a model-unusable defect, not a cosmetic one.

## The change

`src/adapters/anthropic.ts:469` — MODIFY:

```diff
-  const match = /(?:^|\/)claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(modelId);
+  const match = /(?:^|\/)claude-([a-z]+)-(\d+)(?:[.-](\d{1,2}))?(?![\d.])/i.exec(modelId);
```

`src/adapters/anthropic.ts:473` — MODIFY:

```diff
-    family: match[1]!,
+    family: match[1]!.toLowerCase(),
```

The `(?![\d.])` guard is load-bearing: without it, `claude-opus-4-20250514`
would parse minor as `20` and a date-pinned id would silently cross the
adaptive threshold. The reviewer confirmed date-pinned ids still parse to
minor `0`.

## Gap this phase must close before merge

The classifier feeds **two** predicates, and the PR only tests one:

- `usesAdaptiveThinking` (`:492-494`) — tested by the PR.
- `supportsExplicitThinkingDisable` (`:512-514`) — **not** tested with a
  capitalized id; existing cases at `tests/anthropic-reasoning.test.ts:318-330`
  are all lowercase.

The PR's matrix is also incomplete: it adds `Claude-Opus-4.8-joybuilder` and
`claude-opus-4.8-joybuilder` but not capitalized-dashed or capitalized
date-pinned forms.

## Required test additions

`tests/anthropic-reasoning.test.ts` — MODIFY:

1. Extend the adaptive matrix with `"Claude-Opus-4-8"`, `"claude-opus-4-8"`,
   `"Claude-Opus-4.8"`, `"claude-opus-4.8"`; assert
   `thinking == {type:"adaptive"}` and `output_config == {effort:"xhigh"}`.
2. Extend the legacy matrix with `"Claude-Opus-4-20250514"`; assert
   `thinking.type == "enabled"`, `budget_tokens` present, `output_config` absent.
3. Add an explicit-disable case with `"Claude-Sonnet-5"` and reasoning `none`;
   assert `thinking == {type:"disabled"}`. This is the only assertion that
   exercises the classifier's second caller.

## Accept criteria

| # | Criterion | Proof |
|---|-----------|-------|
| 1 | All four separator/capitalization forms classify adaptive | `bun test tests/anthropic-reasoning.test.ts` |
| 2 | Capitalized date-pinned id stays on the legacy wire | same |
| 3 | Explicit-disable caller covered with a capitalized id | same |
| 4 | Fork Cross-platform CI approved and green at head | `gh pr checks 2483` at exact head SHA |
| 5 | Merged into `dev` | merge SHA + `git merge-base --is-ancestor` |

## Scope boundary

IN: the regex, the family lowercasing, and the test matrix.
OUT: any other model-classification behavior; effort ladder changes; anything in
`src/adapters/anthropic.ts` outside `claudeFamilyVersion`.

