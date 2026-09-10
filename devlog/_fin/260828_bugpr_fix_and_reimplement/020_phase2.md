# 020 — wp3 REIMPLEMENT lane: #2693 antigravity signature fallback

#2693 head `8775d77d6`, 131 behind, merge CLEAN, tsc OK, **62/0 on its own suite**.
The green suite is not evidence: all three reviewer-reproduced defects survive it,
because tests written beside a defect encode it.

## The intent is right

Gemini 3 function calls require a `thought_signature` on the first `functionCall`
part of a model turn. When neither the wire metadata nor the replay cache has one,
the request fails. Injecting the official
`skip_thought_signature_validator` bypass is the correct remedy. Three defects sit
between that intent and the diff.

## Defect 1 — presence check instead of `extractSignature()`

The diff tests `part.thoughtSignature !== undefined || part.thought_signature !== undefined`.
The module already owns the real contract at
`src/adapters/google-antigravity-replay.ts:513`:

```ts
function extractSignature(part: Record<string, unknown>): string | undefined {
  const direct = part.thoughtSignature ?? part.thought_signature;
  if (typeof direct === "string" && direct.length >= MIN_SIGNATURE_LEN) return direct;
  const extra = part.extra_content as { google?: { thought_signature?: unknown } } | undefined;
  const nested = extra?.google?.thought_signature;
  if (typeof nested === "string" && nested.length >= MIN_SIGNATURE_LEN) return nested;
  return undefined;
}
```

Two consequences, both reproduced by the reviewer:

- a **nested** `extra_content.google.thought_signature` is invisible to the presence
  check, so a turn that already carries a valid signature gets a competing sentinel
  added;
- a **direct but too-short** value (`"short"`, below `MIN_SIGNATURE_LEN = 16`) reads
  as present, so the fallback is suppressed on a turn that genuinely needs it.

FIX: decide from `extractSignature(part)`, never from key presence.

## Defect 2 — `turnHasSignature` is a turn-wide boolean set by a later sibling

The diff scans all parts and sets `turnHasSignature` if **any** part has one, then
skips the sentinel for the whole turn. But the requirement is specifically about the
**first** `functionCall` of the turn. Reviewer's reproduction: a two-call turn where
only the second matches the cache — the second gets a real signature, the first stays
unsigned, and the sentinel that the first call required is skipped.

FIX: track the first `functionCall` part explicitly, replay real signatures, then
decide the fallback from `extractSignature(firstFunctionCall)` alone. A later
sibling's signature must not vote on the first call's state.

## Defect 3 — the sentinel reaches non-Gemini models

`antigravityUsesReplayCache(model)` is `!/claude/i.test(model)` — every non-Claude
model qualifies. The reviewer reproduced the Gemini-only sentinel being injected into
`gpt-oss-120b-medium`.

FIX: gate sentinel injection on a Gemini wire model. The replay cache's own scope is
deliberately broad and must stay that way; only the **sentinel** narrows. A new
predicate local to this module:

```ts
export function antigravitySupportsThoughtSignatureSentinel(model: string): boolean {
  return /(^|[/:])gemini[-.\d]/i.test(model);
}
```

**The separator is the load-bearing detail.** An earlier draft of this doc wrote
`/(^|\/)gemini[-.\d]/i` — slash only. The A-gate reviewer and a local probe caught
the same hole independently: `src/adapters/google.ts` builds the Vertex replay key
as `vertex:<project>:<location>:<modelId>`, a **colon**. A slash-only regex looks
correct against every CCA id and would have silently stripped the bypass from every
Vertex Gemini request — a regression introduced by the fix meant to prevent one.
Three namespaces reach this module and all three must match: `gemini-3-pro`,
`google/gemini-3-pro`, `vertex:api-key:global:gemini-3-pro`. The trailing
`[-.\d]` keeps `geminibot` and `my-gemini-clone` out.

## Where the sentinel lives, and why not inside `applyAntigravityReplay`

The first implementation put the fallback inside `applyAntigravityReplay` and broke
**12 existing tests**. That was not a broken-test problem; it was a design answer.
That function's *absence* of a signature is meaningful — 18 assertions read
`thoughtSignature === undefined` as "the cache did not match", covering eviction,
TTL expiry, oversize refusal, and clear-on-invalid. Writing a fabricated token into
that slot overwrites the exact signal those tests read.

So the sentinel is its own exported pass,
`applyAntigravityThoughtSignatureFallback(model, contents)`, called immediately
after replay at both `src/adapters/google.ts` call sites. Replay answers "what did
upstream already tell us"; the sentinel answers "does the first call still lack a
signature". A cache miss keeps looking like a cache miss, and all 61 pre-existing
tests pass untouched.

A model outside that set that genuinely needs the sentinel must arrive with a captured
accepted CCA contract, not by widening the predicate on inference.

## Also: the reviewer's non-blocking test defect

The unknown-version snapshot test reuses the object mutated by the corrupt-snapshot
call, so its second assertion is not load-bearing. The reimplementation gives the
version-99 branch a fresh unsigned payload.

## Lane mechanics

REIMPLEMENT on `codex/antigravity-signature-fallback` cut from `origin/dev`, then a
PR targeting `dev` that closes #2693 as superseded. The author's commits are not
carried because the logic is being replaced, not rebased; the PR credits the original
diagnosis and links #2693.

## TESTS — `tests/google-antigravity-replay.test.ts`

Each must fail without its corresponding fix:

1. two-call turn, only the second matches the cache -> the FIRST call receives the
   sentinel (defect 2).
2. valid **nested** `extra_content.google.thought_signature` on the first call -> no
   sentinel added (defect 1a).
3. direct but **too-short** signature on the first call -> sentinel IS added
   (defect 1b).
4. `gpt-oss-120b-medium` with an unsigned first call -> **no** sentinel (defect 3).
5. a Gemini model with an unsigned first call and no cache entry -> sentinel added
   (the feature still works).
6. version-99 snapshot branch uses a fresh unsigned payload.
7. a later sibling signed **on the wire** (no cache at all) does not vote away the
   first call's sentinel — the reviewer noted that test 1 only covers the cache-hit
   arm, so a weaker patch could pass it and leave this open.
8. a Vertex-prefixed Gemini id receives the sentinel end to end, driving the real
   function rather than only asserting the predicate.

## Verification (C)

```bash
bun x tsc --noEmit
bun test tests/google-antigravity-replay.test.ts
```

Then the mutation oracle per defect: revert each fix individually and confirm the
matching test — and only that test — fails. A single combined revert is weaker
evidence, because it cannot show that each test binds its own defect.

Result (all four confirmed):

| mutation | tests that fail |
|---|---|
| presence-check instead of `extractSignature` | 2 — nested, too-short |
| turn-wide flag instead of first-call | 1 — first-call sentinel |
| gate on `antigravityUsesReplayCache` | 1 — non-Gemini injection |
| slash-only regex | 2 — Vertex predicate and end-to-end |

70 pass / 0 fail with every fix in place; `tsc --noEmit` exit 0.

## The blast radius the focused suites did not show

70/0 on `tests/google-antigravity-replay.test.ts` and exact-head CI still failed
three shards. **Five tests in four OTHER suites** break, all with one shape: they
assert `thoughtSignature` is `undefined`, and the sentinel now fills that slot.

```
tests/google-signature-history-roundtrip.test.ts
  "history without a signature stays unsigned rather than borrowing one"
  "an unknown call_id stays unsigned"
tests/google-vertex-thought-signature.test.ts
  "#1312: shared prompt cache keys cannot cross client-thread replay namespaces"
tests/google-antigravity-wire.test.ts
  "custom_tool_call item ids (ctc_...) are NOT forwarded (issue #174)"
```

This is the round's own standing gate #4 firing on me: green targeted suites are
not health, because I chose the targets. I picked the file I was editing, and the
consumers are where the change actually landed.

### The question, stated honestly

Those tests use `undefined` as a **proxy** for "no signature was borrowed from
another call, another thread, or another namespace". #1312 is a genuine security
boundary: thread-b must not inherit thread-a's signature under a shared prompt-cache
key. The sentinel is a constant carrying no information from any other call, so on
that reading the isolation property survives and the assertions should read
`toBe(BYPASS)`.

**That reading is convenient for me, which is why it is not mine to certify.** It
is dispatched to an independent reviewer with the alternative designs named: (a)
update the five assertions, (b) narrow the sentinel so it never applies to replayed
client history, (c) something else.

Direct evidence gathered meanwhile — thread-a records a real signature, thread-b
replays the same call under a different session:

```
after replay   (thread-b): { functionCall: { name: "shell", args: {} } }
after fallback (thread-b): "skip_thought_signature_validator"
leaked thread-a's real signature? no
```

So the leak the test guards against does not occur. Whether `undefined` was
load-bearing for a *different* reason is the reviewer's call, not mine.

### It was not just assertion drift — two real defects were hiding there

Investigating the five failures found two genuine problems, both of which make the
sentinel behave as if it were a real signature:

**1. The replay cache ingested it.** `observeAntigravityReplay` stored the sentinel
like any other signature, so a token we fabricate on the way out round-tripped back
in and was replayed later as evidence a turn was signed:

```
observe(sentinel)  ->  {"sessions":1,"calls":1,"totalBytes":160}
apply              ->  "skip_thought_signature_validator"
```

`extractSignature` now refuses it on both the direct and nested paths, so observing
it leaves the cache empty (`sessions: 0`) instead of polluting it.

**2. `isLikelyRealThoughtSignature` accepted it.** That predicate exists to reject
synthetic ids — `fc_`, `ctc_`, `tsc_`, `call_` — and it is what
`tests/google-antigravity-wire.test.ts` #174 protects. The sentinel is alphanumeric
with underscores, so it slipped through every filter and would have been treated as
genuine anywhere that predicate gates. Now rejected by name.

Neither was visible from the focused suite. Both were found by asking why the
*other* suites disagreed, instead of assuming they were stale.

### The design verdict

With both closed, the five assertions really are proxies, and the independent
reviewer reached the same conclusion on its own reasoning:

> All five are proxies for "no *real* signature was borrowed/forwarded", not a
> requirement that the slot stay empty. [...] There is no honest "replayed history
> vs fresh turn" bit at those call sites [...] every unsigned first `functionCall`
> *is* history, which is the Gemini 3 400 this PR is fixing. (b) would disable the
> feature on the path that needs it.

It also independently flagged the `isLikelyRealThoughtSignature` hole as a residual
risk — "do not let it enter the remember/observe path" — which is exactly the defect
already closed above.

Design (a) adopted: each assertion now expects the sentinel and carries a comment
explaining why the property it protects still holds. #1312 keeps its positive
control that thread-a still receives the real `SIGNATURE`, so a genuine
cross-namespace leak would still fail the test.

159 pass / 0 fail across all four affected suites.

Differential probe required (gate 4): `applyAntigravityReplay` changes behavior, so
enumerate the arms — cache hit / miss, signed / unsigned first call, nested / direct /
short signature, Gemini / non-Gemini — against unpatched `dev` and record which move.
