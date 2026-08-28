# 040 — close-out: one visible answer, and what was never a code defect

Terminal outcome: **DONE** for the duplicate answer. **NOOP (stale process)** for
the non-termination half. Merged to `dev` as `69031f6aa` via PR #2835.

## What the user reported

After #2819 merged, a Kiro turn still (a) printed the final answer twice and
(b) seemed to keep going after answering.

## What was actually true

Two different causes wearing one bug report.

**(a) The duplicate answer was real and live on `dev`.** Kiro emits answer-shaped
prose and then calls the private completion tool in the SAME inference. The
adapter released the prose as `commentary` and the completion answer as
`final_answer`; `src/bridge.ts` closes the commentary message on the phase
change, so the client rendered two assistant messages with near-identical text.
The repository's own suite asserted this as intended behaviour in three places,
so it was verified-present rather than hypothesised.

**(b) The non-termination half was mostly a stale process.** Measured, not
assumed:

| host | version | process age | verdict |
|------|---------|-------------|---------|
| local (the reporting proxy) | 2.35.0 from the checkout | started 22:12:11 | predates `b0740840d`, `d9d26552f`, `68eaf45d8` |
| `suji` | 2.24.2 installed binary | 10.9 days uptime | predates the entire unit |
| `macmini-cf` | checkout at `d7a82a8fc` | no proxy running | current source, not serving |

`68eaf45d8` is the commit that stops the terminal boundary from depending on the
client echoing `phase`. A proxy started before it never contained the finished
fix. Live `/v1/responses` probes against current source returned exactly one
`final_answer` with `end_turn: true` for plain, tool-available, and
tool-result-round-trip turns. No code change was warranted for this half; the
remedy is a restart, which is left to the operator.

## The fix

`consumeSupersededByCompletion` in `src/adapters/kiro.ts`: a valid completion
answer supersedes prose staged during the same inference, so that collection is
consumed rather than released — redundant `text_delta` dropped, every non-text
event kept, retention released either way. Applied to `deferred` in `required`
mode and `fallbackEvents` in `text_fallback`.

## What the audit changed

The plan in `020` said to consume at BOTH readers — the inner flush and the
outer drain at `:996-1001`. An independent reviewer returned **FAIL** and was
right: that outer drain is also the leftover flush for early terminal returns,
so teaching it to discard text would hide the only commentary a *failed* turn
ever produces. Trading a cosmetic duplicate for a silent failure is a worse bug.

Corrected: the inner site is the only consumer, and it splices, so the outer
drain finds nothing on the completion path and keeps its full behaviour on every
failure path. Re-verified by the same reviewer: **pass**. Recorded in `021`.

## Evidence

- `bun test` on the merged tree `ab21fa526`: 194 pass / 0 fail across the three
  Kiro suites plus `release-version-line`, receipt `dirty=false exitCode=0`.
- Full `bun run test`, `bun run typecheck`, `bun run privacy:scan` green on the
  PR head `0dc87045`.
- Both new assertions driven RED before being accepted: the protocol-level one
  failed with `Received length: 2` (the user's exact symptom, two assistant
  messages), the adapter one with the extra commentary event present.

## One thing worth recording about CI

PR #2835 showed `test 2/4` and `macos` red. Neither was this change:
`tests/release-version-line.test.ts` failed because `dev`'s `package.json` said
`2.35.0` while `v2.36.0-preview.20260829` was already published. Proven by
running that test on a pristine `origin/dev` worktree with none of this branch's
changes present — it failed there too. It blocked every PR targeting `dev` and
was separately repaired by PR #2836, which has since landed.

