# wp2 — the three recovery-widening pull requests

Each is reviewed against one question, and each ends with its own exact-head evidence. They are
not chained.

## #4800 — transient 5xx replay for key-auth `openai-responses`

The change is two lines in `src/providers/key-failover.ts`: `transientRetryPolicyFor` stops
refusing the `openai-responses` adapter.

The question is containment. `transientRetryOn5xx` is opt-in and absent by default, and the
auth-mode gate that follows the adapter gate is the fail-closed half — explicit `key` or the
documented omitted default, never OAuth, forward or local. What still has to be established is
that the `openai-responses` transport replays the same bytes it sent, that nothing in it carries
per-attempt server state, and that a stream which already emitted bytes is not a replay candidate.

The user-facing documentation for `transientRetryOn5xx` names the eligible adapter. Eight locales
carry it under `docs-site/src/content/docs/**/reference/configuration/providers.md`, and the PR as
surveyed updates none of them. A behaviour widening whose documentation still says the old scope
is a docs-sync gap, not a nit.

## #4817 — zero-output bare SSE errors may advance a combo

The change classifies a top-level `{"type":"error"}` frame arriving before any output as terminal
evidence, and lets unknown, rate-limit and server-class failures advance to the next declared
target while explicit client errors stay committed.

The question is boundary stability. A combo may only move while *nothing* has been committed to
the client, so the verdict has to be a function of the decoded event stream and not of how the
bytes were split. Three things decide it: that `createSseInspector` reassembles frames before the
payload callback sees them, that the new early return in `onParsedPayload` latches the first
verdict rather than letting a later frame overwrite it, and that `outputCommitted` is still set by
anything that reached the client.

The failure mode to rule out is the one this unit calls a blocker: a frame arriving after a tool
call has already executed upstream, or after output was committed, being reclassified as
retryable and replayed against a different provider.

## #4824 — a single-target combo may retry after its cooldown

The change lets `executeComboResponses` re-pick when the combo declares exactly one target and
`waitForCooldownMs` is positive, by repeating `pickWithWait` without the `exclude` set that made
the first call return nothing.

**Termination is settled.** Three independent bounds hold, and they are not restatements of one
another.

- *Locally*, the new branch requires `comboTargetsDispatched <= 1`, and the dispatch that follows
  makes it `2`. The branch cannot fire twice.
- *By budget*, `comboExecutionBudgetPolicy(1)` yields `maxAlternateTargetSends: 1`. The retry is
  the first non-initial dispatch, so it is admitted; a second would be refused by
  `reserveDispatch` in `src/lib/request-execution-budget.ts`. The per-target clamp is unaffected:
  `combo.targets.length - 1 - comboTargetsDispatched` goes to `-1` and `comboTargetSendBudget`
  clamps it with `Math.max(0, ...)`.
- *By wait*, `pickComboTargetWithWait` returns `null` outright when the earliest expiry exceeds
  `waitForCooldownMs`, so the sleep is never longer than the configured ceiling, which
  `src/combos/types.ts` validates to at most `600000`.

**Cancellation is observed.** The wrapper passes `options.abortSignal` through, and
`pickComboTargetWithWait` returns `null` both when the sleep rejects and when the signal is already
aborted on wake; the caller then answers with the client-cancelled response.

**Default behaviour does not move.** `COMBO_DEFAULT_WAIT_FOR_COOLDOWN_MS` is `0`, so a combo that
never configured a wait keeps failing on its first failure exactly as before. That is what the
third test in the PR pins.

**No committed-output replay.** The branch sits on the failure path, which is only reached after a
non-2xx that the combo classifier already decided to hop on. A streamed attempt that committed
output returns before this point.

The residual question is narrower than termination: whether repeating the same target is the right
answer for every status the classifier calls a hop, given that the retry re-sends the identical
turn to the identical provider.
