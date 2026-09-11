# 050 — wp5: distinguish a history-only stop failure from a real one (#3008)

Score 71/80. Branch: `codex/3008-stop-taxonomy`, based on `dev`. One PABCD cycle.

## The defect

`src/update/index.ts:250-267` aborts the update when
`stop.status !== 0 || readPid() || readRuntimePort()`. `handleStop()` sets a non-zero
status after history restoration (`src/cli/index.ts:739-748`) — that is, after the
proxy and service have already come down cleanly. So a failed Codex-history cleanup
is indistinguishable from a proxy that refused to die, and the update aborts with the
service already stopped: no listener, no PID, old package still installed.

The consequence is visible in the code itself: the history warning at
`src/update/index.ts:269-275` is unreachable. Someone wrote the correct handling for
this case and the guard above it never lets control reach it.

## Why PR #3040 is the wrong fix

It proceeds for every non-zero *or signal-killed* stop whenever PID and runtime files
are absent (PR-head `src/update/index.ts:42-47`), then reports the proxy stopped
without probing the captured endpoint (`:279-296`). It also folds `status: null` into
"nothing to warn about".

That inverts the safety property. The comment at `src/update/index.ts:245-250` exists
because replacing package files under a live proxy leaves it dynamic-importing a mix
of old and new modules. Absent PID and runtime files are weak evidence of death — they
are exactly what a crashed-but-still-listening or externally-supervised proxy looks
like. "Proceed unless we can see a proxy" trades a false abort for a corrupted
runtime, which is the worse direction.

The fix is not to widen the proceed condition. It is to stop discarding the
information that distinguishes the cases.

## What changes

1. **A stop outcome carried on the wire, not in the type system** —
   `src/update/stop-contract.ts` defines the vocabulary, but the representation has to
   be a dedicated exit code (or a machine-readable receipt file) because the value
   crosses a subprocess boundary. See the amendment below.
2. **`src/cli/index.ts`** — `restoreSharedClientStateAfterStop()` reports Codex-history
   failures separately from other teardown failures. `handleStop()` emits the
   history-only result *only* when service and proxy shutdown both succeeded and no
   other cleanup step failed.
3. **`src/update/index.ts`** — proceed for status `0` or the history-only result, and
   only after PID/runtime checks *and* an identity probe against `capturedListen`.
   Abort for ordinary non-zero and for `status: null`. The warning at `:269-275`
   becomes reachable on the reported path.
4. **`bin/ocx.mjs`** — the second updater. See the amendment below.

### Amendment after audit round 1 (`002`, blocker 1): there are two updaters

The first draft fixed the Bun updater only. Dashboard npm updates run through
`bin/ocx.mjs`, dispatched at `src/update/job.ts:428`, and that launcher carries its own
independent guard which still aborts on any non-zero stop (`bin/ocx.mjs:346`). Since
#3008 is reported from the dashboard, the original plan could have gone fully green
while the reported path stayed broken — the exact false-completion shape this train's
receipts exist to prevent.

Two consequences:

- **The contract needs a runtime representation.** A TypeScript union does not survive
  `spawnSync`. `handleStop()` must signal the history-only outcome with a dedicated
  exit code, and both consumers must decode that same code. Choosing a distinct code
  (rather than parsing stdout) keeps `bin/ocx.mjs` free of a TypeScript import it
  cannot have.

  `handleStop()` sets `process.exitCode = 1` and nothing else
  (`src/cli/index.ts:747`), and the launcher mirrors the child's code verbatim
  (`bin/ocx.mjs:659-663`), so a distinct value propagates without further plumbing.
  Assert in a test that `handleStop` still *returns* rather than exiting inline,
  because `restart` and the tray coordinator depend on that (comment at `:745-746`).

  **The occupied set is larger than `src/cli/index.ts` suggests** (audit `004`,
  blocker 4). The process exit is supplied by `dispatchCommand` (`:989`), and its own
  contracts already return `2` (`src/cli/dispatch.ts:193`, `:265`, `:598`, `:675`),
  `4` (`:277`) and `64` (`:560`). Round 2 checked only `index.ts` and concluded the
  low codes were free; they are not. Choosing `2` would have made a history-only stop
  indistinguishable from a config conflict, and `bin/ocx.mjs` would have propagated the
  confusion faithfully.

  Reserve **`79`** — outside `{0, 1, 2, 4, 64, 130}`, above the `sysexits` block
  (64-78), below `128 + signal`, and unused across `src/cli/`, `bin/ocx.mjs` and
  `src/update/`. Define it once as a named constant in a plain-ESM module that both the
  TypeScript updater and plain-Node `bin/ocx.mjs` can import, and test that the exact
  value survives the `spawnSync` round trip in both lanes.

  Round 3 proposed `70` on the claim that it sat outside `sysexits`. Audit round 4
  (`005`, blocker 4) corrected that: `sysexits.h` runs 64-78 and `70` is
  `EX_SOFTWARE`. Nothing in this repository would have collided, but a code whose
  justification is false is a code the next audit re-opens.
- **Both lanes are in scope for this phase.** Fixing one and leaving the other is not a
  smaller version of this fix; it is a fix that does not close the issue.

The correction from the nit list also applies: the warning at `src/update/index.ts:269-275`
is unreachable on the reported failed-history path, not globally. A skipped history
outcome can still produce overall stop success while a manifest remains
(`src/codex/inject.ts:1652`), so "history restore incomplete" and "history restore
failed" are different states and only the second one is this issue.

`status: null` means the stop child was killed by a signal without producing an exit
code. It carries no information about whether teardown completed, so it aborts.

## Regressions

In `tests/update-stop-first.test.ts`, which already owns the stop-ordering surface, and
the same matrix exercised against the npm launcher rather than only against the
classifier (audit `003`):

| case | expected |
| --- | --- |
| history-only result, no live proxy | proceed, with the warning printed |
| generic status `1`, no PID/runtime records | abort |
| `status: null` | abort |
| any live identity, PID, or runtime record | abort, regardless of status |

Row 1 is RED against `dev` (currently aborts). Row 2 is RED against PR #3040 (which
proceeds) — quote both reds in the receipt, because a test suite that is only red
against `dev` would not prove this phase avoids #3040's failure mode.

Per blocker 1, a test that calls the classifier directly proves nothing about either
updater consuming it. At least one case must drive the real `bin/ocx.mjs` path with a
stubbed `stop` that exits with the history-only code, asserting the update proceeds;
and one must drive it with a generic non-zero exit, asserting it aborts. Those two are
the assertions that would have caught the original single-lane plan.

## Verification

Focused: `bun test tests/update-stop-first.test.ts tests/update-job.test.ts tests/update-transactional.test.ts tests/cli-dispatch.test.ts`.
(`tests/update.test.ts` and `tests/update-stop-classification.test.ts` named in earlier
drafts do not exist — blocker 8 and audit `003`.)
Suite, typecheck and privacy scan on `ssh lidge`.

## Close-out

`Closes #3008`. Comment on PR #3040 naming the fail-open case rather than closing it
silently; the author found a real defect and only the remedy is wrong.
