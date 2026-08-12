# 014 — WP8: closure against the released state

`020` and `030` triaged against `dc4dd45b0` **before** anything was published,
and concluded zero closable. That conclusion was correct then and stale now,
for two reasons: the shipped RC carries 41 more commits, and an issue whose
only blocker was "fixed on `dev`, not yet released" becomes genuinely resolved
the moment the fix is on npm. So the sweep was re-run from scratch against
`9c051342d` / `2.12.0` rather than inherited.

## Result

| | Count |
|---|---|
| Open issues examined | 68 |
| **Closed** | **2** |
| Not closable | 66 |
| Open PRs examined | 22 |
| Superseded (closable) | **0** |
| Stale (left open) | 3 |
| Viable (left open) | 19 |

## Closed

**#1366** — imported local CLI credential with invalid `expires_at` adopted and
never refreshed. Fixed by #1369 (`831a120ea`, merged `e8ce2b93d`).

**#1383** — Command Code 502 `Tool result is missing for tool call`. Fixed by
#1411: `aca275265` pairs calls with results and synthesizes an explicit
missing-result error, and `fc1c729ec` buffers image carriers until tool results
close — a second path to the same 502.

Both were verified twice, independently of the triage agent's claim:

```
$ git merge-base --is-ancestor 831a120ea 9c051342d   # exit 0
$ git merge-base --is-ancestor fc1c729ec 9c051342d   # exit 0
$ git tag --contains 831a120ea | grep -x v2.12.0     # v2.12.0
$ git tag --contains fc1c729ec | grep -x v2.12.0     # v2.12.0
```

The tag check is the one that matters for a closure comment: ancestry proves
the fix is in the RC, but only the tag proves it reached the version users can
install. Each closing comment cites the PR, the commits, and 2.12.0.

## Why only two

The 66 remaining issues fall into a few honest buckets: the fix exists only in
an open or draft PR (#1417→#1418, #1415→#1424, #1354→#1407, #1148→#1397,
#1076→#1357, #657→#1410), the feature was never implemented, or the report
still needs a reproduction from the author. None of those becomes closable
because a release happened.

Three near-misses were checked specifically and rejected:

- **#1302** — 2.12.0 does contain a hang mitigation (`183741b82`), but the
  broader cross-file Linux hang reproduced *after* it. Partial fix, still open.
- **#822 / #657** — #1396 bounds reset-credit lookup responses; neither auto
  redemption nor recovery is implemented. Bounding a parse is not the feature.
- **#1299** — #1010 ships configurable cost overlays, not manufacturer-rate
  gateway aliases.

## Why zero PRs closed

Supersession was tested by looking for each PR's defining file or behavior in
the released tree. For #1161, #1008, #811, #1397, #1394, #1361, #1357, #1164,
#1422, and #1410 the defining path is simply absent from `9c051342d`, so no
supersession claim survives.

Three PRs (#1161, #1008, #811) are genuinely stale — old conflicting heads with
no recent author activity — but stale is not superseded, and closing
contributor work for being old is a maintainer judgment this train has no
authorization to make. They stay open.

## Standing correction to `090`

`090_outcome.md` records this unit's terminal outcome as `BLOCKED` + `NOOP`.
That was true when the security gate returned BLOCK. It is superseded by
`013` (release published) and this file (2 issues closed). The current terminal
outcome is `DONE`.
