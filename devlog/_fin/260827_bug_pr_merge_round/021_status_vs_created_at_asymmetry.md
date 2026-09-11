# The status/created_at split is narrower than it first looked

The L3 pick for #2639 rests on a distinction: `status` is safe to backfill,
`created_at` is not, because `created_at` breaks the byte-exact combo passthrough
assertion. The reviewer auditing the cherry-pick asked the obvious follow-up — does
`status` violate the same contract? — and the honest answer is **yes, it can**.

## Evidence

`tests/server-combo-failover-e2e.test.ts` builds its backup body with
`responsesSuccess()` (line 216), which already sets `status: "completed"` on both the
response and the message item. So the byte-exact assertion never exercises the
`status` backfill — it passes because the field is already present.

Remove that one field from the fixture and the same assertion fails on this branch:

```
$ cd /tmp/ocx-statusprobe   # fixture with the item's status: "completed" deleted
$ bun test ./tests/server-combo-failover-e2e.test.ts -t 'exact backup response'
(fail) ... returns the exact backup response
  + "status": "completed",     # injected into a body relayed verbatim
```

And it passes with dev's version of the backfill file restored:

```
$ git checkout 2feffbdc3 -- src/server/responses/responses-field-backfill.ts
$ bun test ./tests/server-combo-failover-e2e.test.ts -t 'exact backup response'
 1 pass, 0 fail
```

So the difference between the two halves is NOT that one mutates passthrough bodies
and the other does not. Both do. `src/server/responses/core.ts:4145` runs
`backfillResponsesFieldsJson` on the bounded-JSON answer, and line 3937 installs the
SSE rewrite, on the passthrough path as well as the translated one.

## What the difference actually is

`created_at` fires on EVERY response body that lacks the field, and a relay that omits
`created_at` is common. `status` fires only on a `message` item that lacks `status`,
which is rarer and is a genuine spec violation upstream — `OutputMessage.status` is
required, while a missing `created_at` is a Response-level omission the same decoders
complain about. The blast radius differs by roughly an order of magnitude, and the
existing test suite happens to sit on the safe side of the `status` case and the
unsafe side of the `created_at` case.

That is a defensible reason to take one and hold the other, but it is a difference of
DEGREE, not of kind, and 002 overstated it as a clean line. Corrected here.

## Consequence

The open question in 002 — whether the backfill should be scoped to the translated
path so a verbatim relay stays verbatim — now applies to `status` too, not only to
`created_at`. Whoever resolves it should resolve both together. That is a follow-up
for its own PABCD cycle, not something to bolt onto this cherry-pick: it changes
behavior for every Responses provider, and the right answer probably involves the
passthrough path opting out of field backfill entirely.

Recorded rather than fixed here because this lane's contract is "take the correct
part of a partially-right PR", and the `status` backfill IS what #2639 got right.
