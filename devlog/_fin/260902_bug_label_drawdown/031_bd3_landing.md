# 031 — bd3 Batch C landing record: maintainer-owned changes-requested

All three landed. `CHANGES_REQUESTED` turned out to mean three different things.

| Original | Rebase PR | Merge SHA | What the review state actually was |
|---|---|---|---|
| #3112 native-main claim | #3183 | `fecb77a91386a4b99c2524b8df9f91d0dcadaee8` | already fixed on branch |
| #3109 combo compact failover | #3184 | `afd5b4630dc59f891c4497174dd21b53ed24b400` | already fixed on branch |
| #3003 quota prime throttle | #3185 | `fe766e129441180c6fefcdc45b9e5609b2e2c326` | **genuinely open — fixed here** |

All three proven ancestors of `origin/dev`. All three rebased without conflicts.

## The lesson: read the thread against the current head, not the badge

Every one of these read `CHANGES_REQUESTED` on the board. Two were stale — the reviewer's
finding had been fixed by a later commit on the same branch, so the thread stayed open while
the defect did not.

- **#3112 P2** asked that claim waiting honor the refresh abort signal.
  `src/codex/main-account.ts` already passed `{ waitMs: 30_000, signal }` with
  `AbortSignal.any([dependencies.signal, refreshTimeout])` — delivered by "abort contended
  native-main refresh claims", two commits after the reviewed one.
- **#3109 P1** asked that `ocx1` be decoded after account-gated combo failover. The branch
  already keyed that decision on the **returned prefix** rather than the pre-failover child,
  plus a second fix rejecting empty ciphertext where an empty `ocx1:` envelope decodes to
  `""` rather than `null`.

Closing either as "changes requested, contributor's move" would have stalled a landed fix.

## #3003 was the real one

CodeRabbit was right: the prune of removed-account markers sat **after** the
provider-eligibility early return, so a removal during a disabled window never reached it,
and restoring the same id inside `POOL_CACHE_TTL` read the stale failure as current.

Fixed on the carry, not deferred. The existing test removed an account with the provider
**enabled**, which is exactly why this survived review — the disabled-window case now exists
and was verified red-green: moving the prune back turns it red (21/1), restoring it returns
green (22/0).

## Count

Bug-labelled items: **16 → 14** (5 PRs + 9 issues).

## Scope discipline on #2999

030_phase3.md originally said #3112 "closes bug issue #2999. Two items for one merge."
The A-gate audit disproved that and the correction held through execution: #2999 describes
**two** races, and #3112 is explicitly only the lock-scope half — serializing two
`OPENCODEX_HOME`s against one `CODEX_HOME`. The publication/overwrite race is still carried
by the existing refuse-rather-than-overwrite check.

So #3112's carry PR states that boundary in its own body and #2999 stays open. Closing it
by association would have been the cheap way to make the count drop by one; it would also
have buried a live race behind a green checkmark.

The publication half is now Batch F work with its scope already written down.

## Remaining after Batch C

5 bug PRs, all contributor-owned (Batch D): #3164 #3144 #3138 #3121, plus whatever the
recount shows.
9 bug issues (Batches E and F): #3155 #3152 #3150 #3141 #3136 #2999 #2813 #1527 #1419.
