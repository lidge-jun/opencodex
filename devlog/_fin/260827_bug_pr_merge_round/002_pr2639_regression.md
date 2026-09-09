# #2639 — status/created_at backfill: real defect, real regression

Head: `aa385f9746` (branch `fix/responses-backfill-status-and-created-at`, author bet4it).
Diff: `src/server/responses/responses-field-backfill.ts` +114/-15, plus 343 lines of new
tests. It compiles clean, and its own suite passes (37/37).

## The defect is real

Strict Responses decoders require `status` on `OutputMessage` and `created_at: u64` on
the response object. An upstream relay that omits either makes such a client fail with
`missing field`. The PR backfills both, infers the message status from the event type,
and maps response-level `failed`/`cancelled` to `incomplete` rather than `completed` —
that last choice is right, since claiming `completed` would let a client treat a
truncated message as whole.

## The regression is also real, and it is caused by this PR

```
$ cd /tmp/ocx-tc-2639 && bun test ./tests/server-combo-failover-e2e.test.ts
(fail) server combo failover 030 activation matrix > cross-adapter chat 503 to Responses 200
       returns the exact backup response
 73 pass, 1 fail
```

On clean dev the same file is 74 pass / 0 fail, so this is not a pre-existing flake.

The diff of the failing assertion:

```
  {
+   "created_at": 1787801315,
    "id": "resp-m2",
```

`tests/server-combo-failover-e2e.test.ts:1323` asserts the proxy returns the backup
provider's JSON **exactly** (`expect(await response.json()).toEqual(exact)`). The
`created_at` backfill injects a field the upstream never sent, so a passthrough body is
no longer byte-identical.

This is a genuine contract conflict, not a stale test. The combo-failover contract says
a passthrough backup response is returned unchanged; the backfill says a response
missing `created_at` gets one. Both cannot hold for the same body.

## Resolution direction

The `status` half is uncontroversial and stays. For `created_at`, the backfill must not
apply to a passthrough body that is being relayed verbatim — scope it to the
translated/bridged path, or make the combo passthrough exempt. Deciding which of the two
contracts yields is a maintainer call and belongs in the lane doc, not here.

## Lane

**L3 — cherry-pick.** Take the `status` backfill and its tests; hold `created_at` until
the passthrough-exactness conflict is resolved, then land it as its own change with the
combo test updated deliberately.
