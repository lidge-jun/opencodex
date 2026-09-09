# 050 — Delivery record

Closes the unit. Everything below is verifiable from public git history.

## What shipped

PR #3498, squash commit `16c7f1ee1`, merged to `dev` and proven an ancestor of
`origin/dev`. Three commits on the branch, each responding to a review round.

| Concern | Outcome |
|---|---|
| MODE A: raw envelope as the `exec` body | Repaired |
| MODE B: decorated envelope inside JavaScript | Refused, recorded |
| Injected guidance printing the forbidden literal | Reworded, effect unproven |
| `parser.ts` guidance (`040`) | Rejected as a category error |

## End-to-end confirmation of the merged code

Run against this checkout at the merged head:

```
MODE A recognized under code mode: apply_patch
compiled: const result = await tools.apply_patch("*** Begin Patch\n***
refused under flat-bridge catalog: undefined
MODE B left alone (js body):       undefined
```

Four behaviors in one run: the envelope is recognized, its decorated delimiters are
normalized on the way into the compiled call, a flat-bridge catalog is refused, and
JavaScript that merely contains an envelope is untouched.

## MODE B still fails closed, checked against the adversarial shapes

The reviewer that refused MODE B named the shapes a rewrite would corrupt. Each was run
against the shipped code: none resolves to a helper, and every one comes back
byte-identical.

```
SAFE  block comment /*** ... ***/
SAFE  string literal
SAFE  regex
SAFE  helper call arg
SAFE  concatenation
ALL MODE B SHAPES FAIL CLOSED AND BYTE-EXACT
```

The block-comment case is the one worth remembering: `/*** Begin Patch ***/` is a legal
JavaScript comment, and a lexical rewrite of the marker would leave it unclosed, turning
a text substitution into a control-flow change.

## Review rounds

Five reviewers across three rounds, and each round found something real.

1. **Pre-implementation.** Three `xai/grok-4.6` investigators mapped the seam, the
   safety case, and the prompt wording. MODE B came back
   UNSAFE-RECOMMEND-PROMPT-FIX-ONLY.
2. **Design audit.** Two adversarial reviewers returned IMPLEMENT-WITH-CHANGES with six
   required changes, including the streaming rewind the plan had missed. All applied.
3. **Post-push.** The Codex reviewer, CodeRabbit, and the maintainer independently
   found the native SSE rewind; Codex and CodeRabbit both raised the missing code-mode
   gate. Both fixed.

The pattern worth keeping: every defect that mattered was found by someone auditing the
implementation against its own stated contract, not by adding more tests to the happy
path.

## Verification

- `bun run typecheck` clean.
- Focused suites only; the repository-wide suite was never run, per instruction.
- CI on exact head `16cfdf33e`: 23 pass, 0 fail, 1 skipping.
- Merged code re-verified in a scratch checkout: 190 pass, 0 fail.
- The native regression was mutation-tested — breaking the gate makes it fail, restoring
  it makes it pass — so it is known to fail for the right reason.

## Accepted residual risk

A model that *quotes* a complete patch envelope, rather than intending to apply one, now
has it applied. No parse separates quotation from intent. This is the stated price of
reading "never valid JavaScript" as "meant `apply_patch`", and it is accepted
knowingly rather than solved.

## Shipping claims, re-verified live at close

Not asserted from memory. Re-checked against GitHub and git while closing the unit:

```
PR #3498      MERGED 2026-09-04T18:14:46Z 16c7f1ee12e91eb57e2b438a21ce72d9a46f7c11
CI exact head 23 pass, 1 skipping, 0 fail
ancestry      16c7f1ee1 IS an ancestor of origin/dev
```

The `skipping` row is the Windows shard selector, which resolves to the four `test N/4`
legs that pass; it is not a suppressed failure.

