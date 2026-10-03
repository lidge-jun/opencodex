# Release and merge record — scope

Status: DONE — historical record of published work.

This record adapts [luvs01/opencodex#699](https://github.com/luvs01/opencodex/pull/699)
by Devin AI, with corrections checked against canonical upstream git history,
GitHub pull requests, release objects, tags and Actions runs. The source is fixed
at [`c61a849ace9c62e5441a091f4372de10210a212e`](https://github.com/luvs01/opencodex/commit/c61a849ace9c62e5441a091f4372de10210a212e);
its two documentation commits are
[`e626e1a816f7872614eb4a0264ba4b22ba3bb10a`](https://github.com/luvs01/opencodex/commit/e626e1a816f7872614eb4a0264ba4b22ba3bb10a)
and that source head.

## Fixed boundaries

- Landing window: first-parent range
  `592c5cfc043cd5b69e8aea0f12b9a0644cc50612..b4616be1e4db9e7178fd28cb19d4c2269abc2ba7`.
  The left endpoint is excluded; the right endpoint is included and landed
  on 2026-10-02 at 16:55 UTC.
- Release publication cutoff: 2026-10-02 18:42 UTC, including the stable
  2.76.0 release published at 18:42:21 UTC. The 2.73.0 and 2.74.0 release rounds
  precede the landing window and are included as release context.
- [Releases](010_releases.md): four rounds, eight tags, ten Release runs
  (eight successes and two failures).
- [Landings](020_landings.md): 81 first-parent commits, partitioned into
  68 entries recorded here, 11 landings covered by six existing documentation
  units, and two release dev-opens. These categories are disjoint.

## Method and limits

The landing PR is the final PR number in each upstream first-parent commit
subject, cross-checked against its merged PR's `merge_commit_sha` and `dev`
base. Earlier PR numbers in a subject can identify carried work rather than
another landing. Each row links both the canonical PR and its landing commit.
Descriptions summarize published commit subjects; they are not new audits of
the underlying changes.

Counts are reproducible with `git rev-list --first-parent --count A..B`.
Release content ranges have separate boundaries from the landing inventory;
they must not be added to the 81-landings total. Publication times come from
GitHub release objects; release SHAs agree with the fetched tags and successful
workflow heads. A tag's date suffix is not its UTC publication date.

This is a closed historical record under [the devlog policy](../../README.md),
consistent with the merged records [#6250](https://github.com/lidge-jun/opencodex/pull/6250)
and [#6031](https://github.com/lidge-jun/opencodex/pull/6031). It does not close or move the other units
listed in the landing inventory, some of which still live under `_plan/`.

Per-PR head/author/CI scorecards, merge-time CI verdicts, coordinator or
administrator causality, and moving fork-tip comparisons are outside this
record. Later check results do not establish what was known at merge time.
Successful release or candidate CI is not proof of every individual PR's
merge-time checks. No npm registry state, dist-tag or npm `gitHead` claim is made.
