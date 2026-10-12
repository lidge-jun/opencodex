# 190 — release readiness for 2.27.0

Written before promotion so the decision is on the record with its evidence,
not reconstructed afterwards.

## What is ready

`dev` at `525274485`. Full suite on `ssh lidge`: **13,532 pass / 15 skip /
0 fail** across 855 files. Cross-platform CI green on the promotion head.
Version reconciled to **2.27.0** (`dev` had been trailing `main` and npm at
2.24.2 because the 2.25.0 and 2.26.0 bumps merged only to `main`).

Shipped in this range and closed: #2107, #2114, #2108.

## The Windows gate, stated honestly

The objective asked for a green Windows leg before promotion. It is **not
fully green**, and the distinction that matters is which failures belong to
this release.

**Fixed — all caused by this range or by the workflow:**

| Defect | Before | After |
|---|---|---|
| Log Guard `unsafe_path` | 22 | **0** |
| Bun 5s default on the Windows shards | 3 | **0** |
| PowerShell identity-lookup budget | 4 | **0** |
| WP13 teardown cascade | 6 | 3 |
| shard 3/4 | failure | **success** |

**Remaining — tracked as [#2152](https://github.com/lidge-jun/opencodex/issues/2152), zero commits in `main..dev` for every file involved:**

- WP13 composed acceptance (3): real-server startup cost on a contended runner.
  These have never passed on Windows — the run originally cited as the
  "before" comparison had shard 4/4 **cancelled**.
- npm cache preflight (3): symlink fixtures an unprivileged Windows user cannot
  build. Neighbouring cases already skip for this reason.
- shard 2: a Bun runtime panic, not a test result.

## The finding that justifies the whole detour

**Log Guard (#1729) is new in `main...dev` and had never worked on Windows.**
Every mutation refused with `unsafe_path`. Promoting on my first reading —
"the Windows leg was already red, so it is not ours" — would have shipped a
feature broken on one of three platforms.

That reading was half right and I stated it as if it were whole: the leg *was*
red beforehand, and a feature that landed on `dev` two days earlier is *still
in the release*. Those are different claims.

## Recommendation

Promote. The state is materially safer than when this started, and the residual
red is identified, evidenced, and tracked rather than unknown.

What a reviewer should weigh against that: the Windows leg cannot currently
reach green without work that is out of this release's scope, so promoting
means accepting #2152 as a known issue rather than a blocker. If that trade is
unacceptable, #2152 is the prerequisite and it is a test-harness project, not a
product fix.

## Release mechanics

Canonical path only — `bun run release <version>` or the `release.yml`
dispatch with the exact head SHA, never a direct `npm publish`.
`assertChannelVersionMovesForward` checks the candidate against the live
registry at dispatch time, which is the only place that comparison is real.

Not done until verified: exact-head CI, the release workflow run, the git tag,
the GitHub release, and the npm registry version.

