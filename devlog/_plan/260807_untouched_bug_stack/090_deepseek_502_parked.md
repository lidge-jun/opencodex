# 090 — #1176: DeepSeek V4 Flash 502 — parked, NEEDS-REPRO

Recording why this is NOT being fixed in this stack, because "we looked and
chose not to act" is a different disposition from "nobody looked".

## What is real

The 502 is real and the local guard that produces it is identified:

- `src/server/responses/core.ts` configures 180s total/first-byte and 30s
  inter-chunk inactivity for the bounded JSON body read.
- `src/lib/bounded-body.ts` arms the first-byte deadline, then resets to the
  30s inter-chunk deadline after every non-empty chunk.
- A truncated bounded read becomes the reported local 502.
- `src/providers/registry.ts` deliberately routes DeepSeek Responses inbound
  through bounded JSON, because native DeepSeek SSE previously omitted or
  delayed terminal events (#875).

## Why we are not fixing it

The reporter is on v2.10.2, which already contains PR #1088 — the first-byte
deadline fix for the identical symptom in #1065. So this is not a stale package.

Their trace shows `durationMs: 90241`. That rules out the 180s total deadline
and is consistent with a 30s inter-chunk timeout after an earlier chunk. What it
does NOT show is how many bytes arrived, when the last chunk landed, or whether
the upstream would eventually have completed.

Three hypotheses remain live and the trace cannot separate them:

1. A legitimate >30s inter-chunk pause from this model, which our deadline kills.
2. The bounded-JSON route is wrong for this case.
3. A genuine upstream stall that we correctly surface as 502.

If (3), the "fix" is a regression: we would be removing a guard that is doing
its job. If (1), the fix is a model-scoped inactivity policy — not a bump to the
shared helper default, which has callers in Responses, upstream-error handling,
Kiro, Command Code, auth/quota, images, and web search.

Raising a timeout because a timeout fired is how a real stall becomes a hang.

## What would unpark it

Either would settle it:

- A reporter capture with byte counts and chunk timings, or
- A controlled direct-upstream run that waits past 30s and shows whether the
  same body eventually reaches a valid EOF.

## Cheap step that makes the next report decisive

Independent of the fix, the failure is currently indistinguishable from other
truncations. Extending `BoundedBodyResult` with `timeoutPhase`
(`first_byte` | `inter_chunk` | `total`), `receivedBytes`, and `nonEmptyChunks`,
and using them in the 502 message, would mean the NEXT such report arrives
already diagnosed. That is a small observational change with no behavior risk,
and it belongs in its own PR rather than inside a bug-fix stack.
