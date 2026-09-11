# wp3 — promotion pull requests and merges

Both promotions are on their channels.

| Channel | PR | Merge SHA | Version |
|---|---|---|---|
| `preview` | [#4010](https://github.com/lidge-jun/opencodex/pull/4010) | `c71474e83c92be1f39e9d8c1fe0743307ce93387` | 2.48.0-preview.20260908 |
| `main` | [#4011](https://github.com/lidge-jun/opencodex/pull/4011) | `9a27e86992d7a014e0aa92c046199b9fac148201` | 2.48.0 |

Candidate `7797586a8899c673eab48886a490e85b480c6d72` is an ancestor of both branches, verified with `git merge-base --is-ancestor` against freshly fetched refs. `git diff 7797586a8 origin/main` is empty: the main tree is byte-identical to the candidate, since the candidate already carried 2.48.0. The preview tree differs only in the channel version line.

## Gate outcomes

`enforce-target` failed on both, as expected and as documented in the PR bodies. Its allowed bases contain only `dev` and its one coded exception is a stacked child, so a release promotion cannot pass it. Both PRs were opened as drafts by that gate and were marked ready before the authorized admin merge. The failure is recorded as a failure; no check, protection, or target was altered.

Every other check passed on both heads.

## Flakes encountered, and why they are flakes

`macos 1/2` on #4011 hung twice inside `tests/clients/client-connect.test.ts` after "connect transaction and offline disconnect > an unavailable config coordinator refuses before issuing any hub key", producing "killed 1 dangling process" and then a 20-minute job timeout. The same tree passed `macos 1/2` in candidate run 34206043085 and on #4010, and passed on the third attempt. Combined with the earlier `windows 3/6` timeout, both failures were child-process lifecycle timing on cold runners, in files outside the release delta.

## Post-merge gates

Preview `c71474e83`: Cross-platform CI success, Service lifecycle success.

Main `9a27e8699`: Service lifecycle success, React Doctor success, Docs deploy success; Cross-platform CI observed in progress at the time of writing and must be green before the stable publish.


## Merge verification commands

```
git merge-base --is-ancestor 7797586a8 origin/preview  # YES
git merge-base --is-ancestor 7797586a8 origin/main     # YES
git diff --stat 7797586a8 origin/main                   # empty
```
