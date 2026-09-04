# 040 — wp1b: leave the parser guidance alone (rejected)

Follow-on to `030_review_round.md`. Proposed while closing the loop, audited, and
**rejected before implementation**. No code changed.

## What was proposed

OpenCodex describes the `apply_patch` grammar in three places. The merged change
updated two; `src/responses/parser.ts:202` still reads "begin exactly with
`*** Begin Patch` (no trailing `***`)". The proposal was to align the third with the
other two, on the theory that a routed model should never see two descriptions of one
grammar.

## Why that was wrong

The premise was a category error, and the audit caught it.

**They are not the same grammar in three places. They are two different tools with two
different repair policies.**

- The two updated sites describe **nested** `tools.apply_patch(input)` inside code-mode
  `exec`. There OpenCodex does not rewrite JavaScript, so a decorated marker really is
  rejected. "Exactly, with no further asterisks" is true there.
- `parser.ts:202` describes the **top-level custom `apply_patch` tool**, whose payloads
  are repaired: `repairFreeformToolInput` runs `normalizeApplyPatchDelimiters` for
  exactly that tool. A decorated envelope on this path is *fixed*, not rejected.

Confirmed by running the shipped function on one decorated envelope, both ways:

```
top-level apply_patch repaired? true  -> "*** Begin Patch"
nested exec body repaired?      false -> "*** Begin Patch ***"
```

The identical input is silently fixed on one path and left broken on the other. That is
the policy split, demonstrated rather than argued.

Copying the strict wording onto the lenient path would have taught the model a
rejection this path does not perform. Alignment would have made the copy consistent and
the *meaning* wrong — the opposite of the goal.

The original defect was a copy-hazard: printing `*** Begin Patch ***` as a copyable
literal. This site never did that; it names the decorated form only inside a
parenthetical prohibition. The reason the first pass skipped it still holds.

## Two further defects in the proposal

1. **The plan named the wrong test.** `040` claimed
   `tests/responses-custom-tool-guidance.test.ts` asserts this description and would go
   red first. It does not — it only checks that the text contains `*** Begin Patch`,
   true of both wordings. The single red would have been
   `tests/responses-parser.test.ts:111`, which pins `begin exactly with`. A plan whose
   stated proof does not fire is a plan that cannot be verified.
2. **The replacement string was worse mechanically.** 128 -> 253 characters and two
   U+2014 em-dashes in a model-facing schema string, where the sites it was meant to
   match use commas. Length is harmless here (the Kiro limiter bounds injected system
   instructions and tool descriptions, not parameter descriptions), but it was needless
   Unicode added for no behavior change.

## Dual injection, checked

A model can receive both strings in one request, on the intersection catalog: a
top-level custom `apply_patch` plus a code-mode freeform `exec`. The nudge goes into the
system prompt while the parser text rides on `parameters.properties.input.description`.

They do not contradict each other — both say start with `*** Begin Patch` and do not add
stars. The rewrite would not have removed a contradiction; it would only have made two
genuinely different call paths sound like one.

## Outcome

**NOOP.** `parser.ts:202` stays as it is.

If this is ever revisited, the defensible version is a short ASCII mention of
`*** End Patch` that does not import the nested-exec strictness, together with an update
to `tests/responses-parser.test.ts:111`. That is not justified now.

