# Open questions on Muse subscription-usage emission

Research doc (000-range), split out of `050` because unresolved research must not sit
inside an implementation phase (LEXICO-SPLIT-01).

**None of these blocks wp5.** The parser is fail-soft by construction: a turn that emits
no event is normal, so every answer below only widens or narrows coverage. They are
recorded so a future contributor does not mistake partial coverage for a bug.

## Q1 — Does the Contributor tier emit the event?

Only `muse-spark-1.3` (standard) was observed on 2026-09-03. `muse-spark-1.3-contributor`
is a different billing tier and may or may not carry subscription windows.

Resolvable with one streaming turn against the contributor id, comparing the event list.

## Q2 — Does a pure pay-as-you-go account emit it?

The field is named `subscription`, which suggests it appears only for accounts holding a
Muse Code subscription. If so, an account without one shows no quota — correct behavior,
not a defect, but the GUI must not present the absence as an error.

Not resolvable on this machine: the only credential available belongs to a subscribed
account.

## Q3 — Does the translated path preserve the event? **ANSWERED: no.**

`src/adapters/openai-responses.ts` iterates `decodeServerSentEvents` and dispatches on
`payload.type` through a `switch` with no `response.subscription_usage` case, so a
translated turn drops it silently.

That is not a bug to fix in the adapter — it is the reason `050` observes on the
passthrough path and treats translated coverage as an explicit, documented gap rather
than discovering it during Build.
