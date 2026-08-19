# 090 — #1527 abort-teardown slice

Branch: `fix/cursor-abort-teardown` off `fix/tray-registry-encoding`.
Commit: `346eaa80d`. PR: **#2118** → #2117 → #2116 → `dev`.

## The plan pointed at the wrong line, and the ablation is what caught it

`000` said the fix site was the abort listener calling
`failAndClear("Cursor request was aborted")` at `live-transport.ts:1157`. That
reads correctly and is wrong.

Patching `failAndClear` left **all ten existing tests passing**. That is the
signal: a change to the actual failure path could not have been invisible. The
injected failure never reaches that helper — the `open()` seam's `fail` callback
at `:627` writes a local `failure` variable, and the throw happens later inside
`run()` at `:651` and `:661`.

Without the ablation this would have shipped as a green no-op. It is the same
lesson the campaign already recorded twice, arriving a third time in a new
costume: **a passing suite after a change proves nothing until you have seen
that suite fail.**

## The second correction: unconditional was too wide

First working version returned on `emittedTerminal` alone. That broke an
existing contract test:

> "a cancel after a terminal was already emitted does not add a second one" —
> asserts the transport **still throws** the raw cancel.

That test is deliberate. The adapter's benign check (`cursor.ts:183`) swallows a
raw cancel one layer up, so the transport throwing it is how provenance stays
intact without a second terminal reaching the bridge.

Narrowed to `emittedTerminal && isCursorAbortError(failure)`. Both halves carry
weight:

| Condition | Without it |
|---|---|
| `emittedTerminal` | a mid-turn abort would be swallowed — nothing delivered, caller never told |
| `isCursorAbortError` | every post-terminal fault would change shape for the adapter |

## Why an abort was not already covered

`isCursorBenignCancelError` deliberately excludes aborts — a mid-turn abort *is*
a real failure. And `expectedClose` is set only by `cancelCursorRun()`, so an
ordinary completion never qualified. A completed turn torn down afterwards fell
through both guards and was reported `turn-failed` with `expectedClose: false`.

## Verification

```
bun test cursor-cancel-provenance + cursor-eof-terminal
         + cursor-adapter + cursor-errors        46 pass / 0 fail
bun x tsc --noEmit                               exit 0
```

Ablation: removing both guards gives `7 pass / 1 fail` — exactly the new
post-terminal-abort test, nothing else.

## Scope

This is one of five residual parts of #1527 after #2054. The other four —
`kimi-k3` collapse at 79-95k, the `claude-fable-5` 429 asymmetry, full-replay on
first turn/restart/compaction, and request-shape parity — are acceptance work
that cannot start until #2054 lands, and the 429 half may be unprovable while
Connect hides `cache_read_tokens`. Hence `Refs`, not `Closes`.
