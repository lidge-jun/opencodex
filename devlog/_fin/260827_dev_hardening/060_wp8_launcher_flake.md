# wp8 — the launcher-recovery flake is not a budget problem

`tests/update-stop-first.test.ts` > "npm launcher restarts the stopped runtime after a
staged update failure" failed twice during this round's CI, both times at ~46.8s, while
passing locally in ~2.5s.

## Why the obvious answer is wrong

The reflex is "raise the timeout". That has already been done twice:

- `34ef53966` raised the readiness wait 15s -> 45s
- `538a602af` (#2666) then fixed the arithmetic, because 30s spawn + 45s readiness +
  30s teardown could not fit in a 60s Bun case timeout

Both are ON `dev` (`git merge-base --is-ancestor 538a602af origin/dev` -> true, 174
commits back). The failure still reproduces. So the budget is no longer the constraint.

## What the timestamp actually says

`PROXY_READY_TIMEOUT_MS = 45_000` (`tests/update-stop-first.test.ts:39`), and
`waitForProxy` polls `/healthz` every 100ms until that deadline, returning `false` on
expiry. The observed failure is `expect(await waitForProxy(port)).toBe(true)` receiving
`false` at 46,797ms — the 45s budget plus the surrounding spawn work.

That is not a case that ran out of room. It is a proxy that did not answer `/healthz`
within 45 seconds on a loaded macOS runner. The assertion is doing its job; the thing
under test is genuinely slow or genuinely not recovering.

## What to determine before changing anything

1. Does the recovered proxy eventually become ready — is 45s slow, or never? Capture
   the child's stdout/stderr on failure instead of discarding it, so the next CI
   failure says WHY rather than only that readiness expired.
2. Is the recovery spawn racing the stop that precedes it? The case stops a running
   proxy, fails a staged update, then expects the launcher to restart the previous
   version. A port still held by the stopping process would present exactly as
   "healthz never answers".
3. Is this macOS-specific? Both observed failures were on the macOS shard.

## Rule for this repository

Per the user's standing instruction — "flacky는 전부 놔두면 안돼" — a rerun-to-green is
only acceptable after the causal question has been asked. It was asked in this round
(the diff touches no update/launcher file, and the case has two prior timing repairs),
which is why the reruns were legitimate. But the underlying slowness is now a KNOWN
open defect rather than an unexplained blip, and a third timeout bump would be the
wrong fix.

## Scope

Diagnosis only in this loop unless the capture in (1) immediately reveals the cause.
A speculative fix to a test that passes locally, on a runner we cannot reproduce, would
be the same mistake in a new direction.
