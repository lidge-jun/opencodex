# 030 — Adversarial review round and what it changed

Two `xai/grok-4.6` reviewers audited the MODE A proposal before implementation. Both
returned **IMPLEMENT-WITH-CHANGES**. A separate reviewer audited MODE B and returned
**UNSAFE-RECOMMEND-PROMPT-FIX-ONLY**, which `010` adopts.

## What the review found that the plan had missed

### 1. A streaming rewind (real defect, fixed)

The strongest finding. `codeModeHelperName` is chosen at `tool_call_start`, before any
arguments exist, and the bridge suppresses live input deltas when it is set. MODE A can
only decide at completion, so the planned change would have streamed raw
`*** Begin Patch` bytes to the client and then replaced the completed item with compiled
helper JavaScript — precisely the rewind the bridge's own comment forbids
("never rewind on mode flips").

Fixed by `mayBecomePatchEnvelope`, which holds a delta while the buffer could still grow
into an envelope. It is deliberately one-sided: it holds what *might* become one and
never asserts that it will. A held buffer that turns out to be ordinary JavaScript still
reaches the client in the authoritative completed item; only the live preview is skipped.

### 2. The locked test froze a rejected alternative, not just a function

The review traced `tests/apply-patch-envelope.test.ts:61` back to
`structure/04_transports-and-sidecars.md`, where "wrap a raw `exec` patch body as a
helper call" is recorded as an explicitly **rejected** alternative. So the test is not
incidental coverage; it is the enforcement of a product decision.

Its verdict on shipping at the bridge while leaving that test green: the *placement* is
honest, because `repairFreeformToolInput` really is the wrong layer for compiling a
helper call, but doing it without rewriting the test name and without bridge-level tests
would be "passing the lock by not aiming at it."

Adopted. The test's assertions are unchanged and still pass, its name now describes the
function it actually guards, the decision log records the narrowed exception rather than
leaving an undead rejection, and the new behavior is tested end to end at the bridge.

### 3. The never-valid-JavaScript proof holds, but does not cover intent

The reviewer tried to find a body that is both a complete anchored envelope and valid
JavaScript, and could not. It also named the residual risk precisely: the remaining miss
is not "this was a program" but "this was a patch the model was quoting rather than
applying" — a scratchpad or an example. That class is real and is accepted knowingly.
Today those bodies throw; after this change they apply.

### 4. The fail-open is genuine, and bounded by an existing precedent

This does convert a guaranteed `SyntaxError` into a real filesystem write. What makes it
proportionate is that the same compile already ships on the name-based path: a provider
that emits tool *name* `apply_patch` under a declared `exec` catalog is already rewritten
and compiled by `normalizeDeclaredToolName`. Same helper, same write, same
`JSON.stringify` fence keeping patch bytes as data. MODE A reaches it by payload shape
instead of by name.

The reviewer's condition for that equivalence to hold is the gate this implements:
complete envelope only, tool name exactly `exec`, no namespace, and no
`codeModeHelperName` already resolved.

## Changes required by review and applied

| # | Required | Where |
|---|---|---|
| 1 | One exported predicate, not a copied regex | `isCompletePatchEnvelope` |
| 2 | One shared resolver, not four forked ternaries | `resolveCodeModeHelperName` |
| 3 | Leave `repairFreeformToolInput` unchanged | unchanged |
| 4 | Hold streaming deltas, never rewind | `mayBecomePatchEnvelope` |
| 5 | Update the header comment and the decision log | both updated |
| 6 | Rename the lock, add product tests | done, assertions unchanged |

## Verification

`bun run typecheck` clean. Focused suite of 10 files: **276 pass, 0 fail**. The
repository-wide suite was not run, per instruction.

## Second review round, after the first implementation was pushed

A second adversarial reviewer and the human maintainer independently found the SAME
remaining defect, which is the strongest possible signal that it was real: the native
Responses path still rewound.

The first fix held streaming deltas in `src/bridge.ts` only. The native SSE path in
`src/server/responses-custom-tool-repair.ts` kept emitting
`response.custom_tool_call_input.delta` with the raw envelope as soon as the wrapper
unwrapped, then replaced the same call with compiled helper JavaScript at the done
event. So one tool call showed the patch text mid-stream and delivered entirely
different JavaScript as its final input — exactly the rewind the first fix was written
to prevent, left live on the route grok actually uses.

Fixed by applying the same `mayBecomePatchEnvelope` hold in that delta path, and covered
by two regressions over the full `output_item.added` -> deltas -> done sequence: envelope
deltas are suppressed and only compiled JavaScript is delivered, while ordinary exec
JavaScript keeps its progressive deltas.

The reviewer also caught a fixture defect: the bridge test patch body used a leading
space instead of `+` on its added line. It passed anyway, because the predicate only
requires the operation line, so the test was not proving what its name claimed. Fixed.

Two other findings were assessed and deliberately not acted on. `*** Move to:` stays
outside the predicate, since widening the accepted grammar is not this change’s job. And
the residual “the model was quoting a patch rather than applying it” case remains
accepted rather than solved: no parse can separate quoting from intent, and it is the
stated price of treating “never valid JavaScript” as “meant apply_patch”.

