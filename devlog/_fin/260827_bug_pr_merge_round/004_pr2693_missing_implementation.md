# #2693 — Gemini 3 thought-signature fallback: test without implementation

Head branch `fix/gemini-thought-signature-bypass`, author yxr1995-maker. The diff is
15 added lines in ONE file: `tests/google-antigravity-replay.test.ts`. No source file
is touched.

The test asserts that when the replay cache misses, the first `functionCall` part gets
`thoughtSignature = "skip_thought_signature_validator"`:

```
$ cd /tmp/ocx-tc-2693 && bun test ./tests/google-antigravity-replay.test.ts
(fail) durable antigravity replay snapshot > fallback to skip_thought_signature_validator
       on the first functionCall when replay cache misses
 61 pass, 1 fail

  1015 | expect(parts[0].thoughtSignature).toBe("skip_thought_signature_validator");
  Expected: "skip_thought_signature_validator"
  Received: undefined
```

The string `skip_thought_signature_validator` appears nowhere under `src/`:
`grep -c` returns 0 for `google-antigravity-replay.ts`, `google.ts`, and
`google-antigravity-wire.ts`. `applyAntigravityReplay` only assigns a signature it
actually has cached (`src/adapters/google-antigravity-replay.ts`), so on a cache miss
the part is left alone by design.

So the PR is a red test for an unimplemented behavior. It is still a DRAFT with
CodeRabbit pending, which is consistent — the author may not have pushed the source
half yet.

## Is the underlying claim right?

Plausible but unverified here. CLIProxyAPI uses that sentinel to bypass Gemini's
signature validator when it has nothing genuine to replay. The existing dev design
takes the opposite position — `src/adapters/google-antigravity-wire.ts` deliberately
refuses to forward a non-genuine signature, because "sending a foreign id as `n`
breaks" continuity. A sentinel that upstream treats as "skip validation" is a
different thing from a forged signature, but that distinction needs an upstream fact
to settle, and nothing in this repository establishes it.

## Lane

**L4 — reimplement**, downgraded from the initial L1 read. Either implement the
fallback in `applyAntigravityReplay` and keep the test, or close the PR as
not-reproducible. Deciding needs one external fact: whether Gemini 3 on Antigravity
actually honors `skip_thought_signature_validator` on a functionCall part. Until that
is answered the PR is BLOCKED on an upstream provider fact, not on our implementation.
