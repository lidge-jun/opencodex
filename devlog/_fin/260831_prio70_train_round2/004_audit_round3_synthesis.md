# 004 — audit round 3: FAIL, five blockers, four of them created by round 1's fixes

First round to read the correctly-staged tree. Index gate confirmed clean: 11 files
staged, staged blobs matching the working tree, `git diff --cached --check` clean.

The shape of this round is the interesting part. Round 1 found nine holes in the
original plan; four of round 3's five blockers are in the *amendments*, not in what
they replaced. Each fix was correct about the defect it named and wrong about the
boundary of its own remedy.

## Blocker 2 — wp3's tuple predicate has a false positive, and it is reachable

The round-1 amendment said: accept `0 → 1` drift only when `model_provider` and
`source` still match the original tuple, on the theory that an OpenCodex write always
moves one of them.

There is a two-step sequence where it does not. Routing takes `openai/vscode/0` to
`opencodex/vscode/1` (`src/codex/history-provider.ts:1158`). Explicit legacy recovery
then takes that same row to `openai/vscode/1` — it sets `model_provider = 'openai'`,
leaves `source` alone for a non-`exec` row, and sets `has_user_event = 1`
unconditionally (`:991`, `:1013`).

Final state: original provider, original source, `has_user_event` moved `0 → 1`. The
predicate reads it as user activity. Every byte of it was written by OpenCodex.

The lesson is about the shape of the inference, not the specific sequence: **a final
state cannot establish authorship when more than one writer can reach it.** The
amendment tried to recover provenance from the endpoint of a path, and two paths share
that endpoint. Provenance has to come from something that records the transition, or
the check has to refuse the ambiguous case.

## Blocker 1 — wp2's reservation is released before the shutdown fallback writes

The amendment required releasing reservations on cancellation and supersession. During
drain expiry `supersedeShutdownFallbackBatch` marks every job cancelled
(`src/responses/state.ts:470`, `:542`) and `installShutdownFallbackSpill` then performs
a *synchronous* durable write (`:557`) — with its own link → exclusive-copy fallback
holding temp and destination together (`src/responses/spill-store.ts:370`).

So the release fires and then the biggest write of the shutdown path runs unreserved.
The amendment closed the async publication hole and opened a synchronous one in the
code round 1 of this train hardened.

Correct shape: the reservation is *transferred* through the fallback rather than
released at supersession, and only settled at swap or terminalization.

## Blocker 3 — my own amendment contradicted its own test plan

`040` says a snapshot with no `shortResetAt` scores unknown, and two lines later
describes regression cases 3 and 4 with account A carrying "only `shortPercent: 100`".
Under the amended contract those cases score unknown, so neither the new-thread switch
nor the affinity rebind can occur, and both tests would fail for a reason unrelated to
the defect.

This is the vacuity class inverted: not a test that passes when it should fail, but a
test that cannot reach the behaviour it claims to prove. Round 1 added the freshness
gate to the contract and did not carry it into the fixtures written before it existed.

## Blocker 4 — the exit code was not actually free

Round 2 established that `handleStop` uses only `1`, and `src/cli/index.ts` only
`0`/`1`/`130`. Both true, and both beside the point: the process exit is supplied by
`dispatchCommand` (`src/cli/index.ts:989`), whose own contracts already return `2`
(`src/cli/dispatch.ts:193`, `:265`, `:598`, `:675`), `4` (`:277`) and `64` (`:560`).
`bin/ocx.mjs:659` mirrors whatever the child returns, so picking `2` would have made a
history-only stop indistinguishable from a config conflict.

"Pick something outside that set" was a deferral, and the set was wrong. The plan now
reserves a concrete code and names the full occupied set.

## Blocker 5 — `selfRefreshed === false` is two different things

The round-1 amendment fixed the generation-as-lineage error by keying on
`selfRefreshed`: spend the recovery budget when true, reset when false. But the
primitive returns false in two unrelated situations. One is external replacement. The
other is a caller that *joined an in-flight refresh* and adopted the stored result
(`src/codex/account-store.ts:639-645`) — same lineage, not a replacement.

Consequence: two concurrent 401 callers produce one refresh; the joiner sees
`selfRefreshed === false` and clears the owner's spent fence; a later 401 refreshes
again. The bounded-retry property the phase exists to guarantee is gone, and existing
case 4 does not catch it because it only observes the concurrent exchange.

Three states, not two: self-refresh, joined-same-lineage, external replacement. Spend
for the first two, reset only for the third.

## What this round says about the plan

Nothing here argues the six targets are wrong or the scores are wrong — round 3
re-verified the index gate and raised no issue with `000`'s matrix or `001`'s evidence.
Every blocker is about the precision of a remedy. That is the correct thing for a third
round to be finding, and it is also the reason implementation has not started yet: four
of these five would have shipped as working code with passing tests.
