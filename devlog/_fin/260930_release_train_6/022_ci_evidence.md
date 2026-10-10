# wp2 — CI and gate evidence (retrospective audit)

Checked on 2026-09-30 against live GitHub with `.tmp/rt6/verify-ci.sh` (merged head carries a completed successful `ci` check run and all four test shards succeeded) and `.tmp/rt6/verify-ledger.sh` (PR merged, merge commit an ancestor of `origin/dev`). Both scripts exited 0.

```
ok #6230 head 613cc84c64 ci=success shards=4/4
ok #6236 head 6a208d5680 ci=success shards=4/4
ok #6248 head 6d23d5eeb0 ci=success shards=4/4
ok #6235 head 071fc1d4a5 ci=success shards=4/4
ok #6249 head 229beb6a71 ci=success shards=4/4
ok #6161 head 14b6769958 ci=success shards=4/4
ok #6247 head 22728b9e3f ci=success shards=4/4
ok #6255 head 2f7737756b ci=success shards=4/4
ok #6258 head 3488c24389 ci=success shards=4/4
ok #6204 head b8d06623be ci=success shards=4/4
ok #6207 head 50b3237514 ci=success shards=4/4
ok #6200 head 6d7db760cd ci=success shards=4/4
ok #6203 head 5398f07ad0 ci=success shards=4/4
```

Merge order: 6230 18:12, 6236 18:12, 6248 18:27, 6235 18:29, 6249 18:45, 6161 19:00, 6247 19:12, 6255 19:33, 6258 19:54, 6204 20:03, 6207 20:36, 6200 20:40, 6203 20:56 (UTC, 2026-09-29).

Other gates, confirmed by an independent reviewer at A:

- Co-author trailers are present in the squash commits of all four carries (#6248, #6247, #6255, #6258).
- No selected PR was merged over an outstanding CHANGES_REQUESTED from a maintainer (@lidge-jun, @Ingwannu).
- Every security-sensitive item has a final APPROVE-SECURITY verdict in scratch review notes (.tmp/rt6/sec*.md); the #6204 merge-resolution interaction with #6255 has its own targeted review (see 021).
- Deviations (early merging during wp1, two order reversals, a post-merge `enforce-target` re-run, merging over a contributor reviewer's standing CHANGES_REQUESTED after fixes) are recorded in 021.

Co-author trailers in the carry squash commits (`git log -1 --format=%B <sha> | grep -i '^co-authored-by'`):

```
cbf5faaf33 Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>
48470c3e29 Co-authored-by: cshyang <cshyang.chng@gmail.com>
99878c3569 Co-authored-by: Vadym O <bolein95@gmail.com>
be218ba688 Co-authored-by: lcBreathe <165003424+lcBreathe@users.noreply.github.com>
```
