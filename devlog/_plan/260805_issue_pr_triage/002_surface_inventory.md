# 002 — Frozen surface inventory

**Authoritative base: `origin/dev` = `aaa71967a`, re-frozen 2026-08-05T13:59:09Z.**

The first freeze (13:33:08Z, `8949c4940`) was superseded twice within half an
hour: #1010 pushed a new head, then `dev` itself advanced five commits. Both were
caught by the audit gate, not by this document, which is the honest way to record
it. Every distance below is measured against `aaa71967a` in one atomic pass — a
table with mixed bases is worse than a stale one, because the rows stop being
comparable to each other.

Verdicts elsewhere in this unit that cite code state remain valid at `8949c4940`;
`aaa71967a` adds five commits and does not touch the paths those verdicts anchor.

## Open pull requests (25)

`behind` counts commits on `origin/dev` not in the PR head; `ahead` counts the
PR's own commits. The readiness gate in `AGENTS.md` requires a head on the latest
`dev` or at most 10 commits behind, so the `behind` column is a gate result, not
trivia.

All distances below computed in one pass:

Reproducibility loop, pinned to the declared base, no ref writes. Run with
`bash`, not `zsh` — the scalar list relies on word splitting:

```bash
cd /Users/jun/Developer/new/700_projects/opencodex
BASE=aaa71967a
PRS="1019 1018 1010 1056 1047 1039 870 1036 1008 1002 947 812 985 983 978 569 999 997 937 936 872 557 581 811 715"
for pr in $PRS; do
  head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  echo "$pr $(git rev-parse --short=9 "$head") behind=$(git rev-list --count "$head".."$BASE") ahead=$(git rev-list --count "$BASE".."$head")"
done
```

For a **live refresh** against a moved `dev` — a different question from
reproducing this table — use the read-only compare API instead:

```bash
for pr in $PRS; do
  head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  gh api "repos/lidge-jun/opencodex/compare/dev...$head" \
    --jq "\"$pr ahead=\(.ahead_by) behind=\(.behind_by)\""
done
```

The two answer different questions and must not be conflated: the first
reproduces this document, the second replaces it.

| PR | draft | mergeable | checks | behind | ahead | files | author | head |
|---:|---|---|---|---:|---:|---:|---|---|
| 1019 | draft | MERGEABLE | **hygiene fail** | 7 | 47 | 100 | chrisae9 | `dd2cd6d9f` |
| 1018 | ready | MERGEABLE | ok | 9 | 15 | 23 | Wibias | `b3dae43b6` |
| 1010 | ready | MERGEABLE | **hygiene fail** | 10 | 8 | 21 | harryzhou2000 | `0e37a89d8` |
| 1056 | draft | MERGEABLE | ok | 12 | 1 | 46 | WZBbiao | `3a7cc03ee` |
| 1047 | ready | MERGEABLE | ok | 201 | 2 | 2 | baileyh8 | `18784cdea` |
| 1039 | draft | MERGEABLE | ok | 253 | 1 | 11 | luvs01 | `199382912` |
| 870 | ready | MERGEABLE | ok | 278 | 2 | 19 | olddonkey | `59d551c0a` |
| 1036 | draft | MERGEABLE | ok | 297 | 4 | 7 | ZachDreamZ | `a35115c39` |
| 1008 | ready | MERGEABLE | ok | 331 | 4 | 22 | lidge-jun | `b0d5417d8` |
| 1002 | ready | MERGEABLE | ok | 331 | 4 | 31 | hanjianjun | `eb017e087` |
| 947 | ready | **CONFLICTING** | ok | 331 | 2 | 14 | WZBbiao | `015ca8fcd` |
| 812 | draft | MERGEABLE | ok (CHANGES_REQUESTED) | 388 | 3 | 19 | theQuert | `a1dcde8cb` |
| 985 | draft | MERGEABLE | ok | 428 | 3 | 11 | DevMello | `db284da38` |
| 983 | ready | MERGEABLE | ok | 436 | 3 | 2 | DevMello | `1ad2be010` |
| 978 | ready | MERGEABLE | ok | 474 | 1 | 2 | DevMello | `753ffdc37` |
| 569 | draft | **CONFLICTING** | **enforce-target fail** | 478 | 6 | 20 | diegocantarero | `15613e672` |
| 999 | draft | MERGEABLE | ok | 497 | 1 | 5 | Yuxin-Qiao | `d849dc631` |
| 997 | ready | MERGEABLE | ok | 497 | 1 | 1 | Yuxin-Qiao | `4b6532bdd` |
| 937 | draft | MERGEABLE | ok | 620 | 1 | 16 | olddonkey | `d717f77e7` |
| 936 | draft | **CONFLICTING** | **label fail** | 620 | 4 | 31 | lidge-jun | `727722cba` |
| 872 | draft | MERGEABLE | **label fail** | 620 | 2 | 16 | olddonkey | `fc7222f78` |
| 557 | ready | MERGEABLE | **4 legs fail** | 869 | 18 | 24 | lidge-jun | `c297dba30` |
| 581 | draft | **CONFLICTING** | ok (CHANGES_REQUESTED) | 935 | 13 | 74 | letr1n1ty | `e1cf92fa5` |
| 811 | draft | **CONFLICTING** | **5 legs fail** | 1271 | 8 | 100 | Ingwannu | `faee6a650` |
| 715 | draft | **CONFLICTING** | ok | 1519 | 42 | 62 | XertroV | `cfe0f4d3c` |

### What the drift proved

Between 13:33 and 13:59, #1010 pushed `50cc14787` → `0e37a89d8` and `dev`
advanced five commits. Heads and ahead-counts were otherwise stable; only the
behind-counts moved, and they moved for all 25 rows at once because the base
moved. That is the useful lesson: a freshness verdict is a statement about a
*pair*, so it has to name its base or it decays silently.

Two facts stand out before any per-PR judgment.

**Only three PRs are inside the freshness gate.** Against `aaa71967a`: #1019 (7),
#1018 (9), #1010 (10). #1056 fell out of the gate during this session — it was 7
behind at the first freeze and is 12 behind now, without its author doing
anything. The other 21 range from 201 to 1519 commits behind. For a contributor PR
that is not a style complaint — it is the literal condition `enforce-target`
checks before it will move a PR out of draft.

**Six PRs are conflicting.** #947, #936, #811, #715, #581, #569. Whatever their
merit, none can land without the author rebasing, so their verdicts are bounded by
that regardless of what the diff contains.

Failing checks, resolved to the exact check name:

| PR | failing check | conclusion |
|---:|---|---|
| 1019 | `hygiene` | FAILURE |
| 1010 | `hygiene` | FAILURE |
| 936 | `label` | CANCELLED |
| 872 | `label` | CANCELLED |
| 569 | `enforce-target` | FAILURE |
| 811 | 5 platform legs | FAILURE |
| 557 | 4 legs (`react-doctor`, ubuntu, windows, macos) | FAILURE |

## Open issues (39 total, 17 bug-class)

Bug-class = `bug` label, or `provider-compatibility`, or unlabeled **and**
defect-shaped. The label query returns 16:

```console
$ gh issue list --state open --limit 100 --json number,labels \
    --jq '[.[]|select((.labels|map(.name)|any(.=="bug")) or (.labels|map(.name)|any(.=="provider-compatibility")))|.number]|sort'
[92,241,417,418,540,796,904,919,994,1017,1024,1043,1046,1057,1059,1061]

$ gh issue list --state open --limit 100 --json number,labels \
    --jq '[.[]|select((.labels|length)==0)|.number]'
[1049,1048,1045]
```

Of the three unlabeled issues, only **#1045** is defect-shaped ("flaky: drain
timer asserts an exact 60000"). **#1048** and **#1049** are maintainer-filed work
items belonging to the `260804_codex_write_substrate` unit — WP13 acceptance and a
substrate adoption task. Counting them as defects would inflate the backlog with
another unit's plan, so they are excluded here and accounted for separately.

**16 + #1045 = 17 bug-class issues.**

| Issue | labels | title |
|---:|---|---|
| 1061 | bug, platform | macOS CI: native-profile process-exit phase test fails or hangs on release-train runs |
| 1059 | bug, platform | Windows test suite: ~207 failures, leg is dispatch-only until green |
| 1057 | provider-compatibility, provider | Align DeepSeek reasoning levels with official low/high/max ladder |
| 1046 | bug, account-pool, catalog, service | Service restart rewrites the Codex catalog without handling stale app-servers |
| 1045 | *(none)* | flaky: system-restart drain timer asserts an exact 60000 against an absolute deadline |
| 1043 | bug, provider | Proxy forwards image_url parts to text-only zen models → 400 |
| 1024 | bug | post-#956 vision sidecar gaps on nemotron/mimo/kimi probes |
| 1017 | bug | Cursor adapter consistently emits invalid Codex apply_patch payloads |
| 994 | bug, streaming | The request couldn't be completed. |
| 919 | bug, enhancement, proxy, streaming, tools | Mid-stream OpenAI socket resets can break Codex account affinity |
| 904 | bug, needs-info | U+FFFD corruption when Kimi/Opus writes Korean files |
| 796 | bug, provider-compatibility, needs-info, provider, tools | Volcengine Ark (Kimi-K3) 400 MissingParameter |
| 540 | provider-compatibility, roadmap, provider, account-pool, catalog, tools | WordPress Studio Code as a WordPress.com OAuth provider |
| 418 | bug, upstream-tracking, needs-info, provider, tools | V2 custom-parent to custom-child delegation still fails on 2.7.39 |
| 417 | bug, upstream-tracking, cli | Korean realtime voice transcript renders U+FFFD |
| 241 | bug, upstream-tracking, catalog | Routed models loaded by app-server but missing from Desktop picker |
| 92 | bug, upstream-tracking, tools | V2 cross-provider sub-agent loses NEW_TASK body in encrypted_content |

### Accounting

```
39 open issues
 = 17 bug-class            (verdicts in 010)
 +  2 other-unit work items (#1048, #1049 — owned by 260804_codex_write_substrate)
 + 20 enhancement/roadmap   (listed below, no defect verdict)
```

The 20 frozen enhancement/roadmap issues, named so the accounting is checkable
rather than asserted: #1060, #1058, #974, #823, #822, #821, #820, #809, #755,
#695, #657, #572, #561, #415, #414, #386, #201, #178, #177, #95.

**Two issues arrived after the freeze** and are recorded
but not counted: **#1062** ("[Feature Request] Account Pooling, Auto-Failover &
Aggregate", first seen 13:49Z) and **#1063** (account-pool enhancement, first seen
13:59Z during the audit). Both are enhancements, so neither changes the bug-class
set; the live count is 41 open issues against the frozen 39. A moving surface is
the normal condition — the fix is to name the boundary, not to pretend the
snapshot is still live.

## Label composition (all 39 open issues)

```
19 enhancement   14 tools        14 bug          12 account-pool
11 provider       9 roadmap       7 platform      7 catalog
 5 upstream-tracking  5 needs-info  4 proxy        3 streaming
 3 provider-compatibility  3 (unlabeled)  2 maintainer-sponsored
 2 gui  1 service  1 install  1 cli
```

`upstream-tracking` on 5 items and `needs-info` on 5 matter for the action queue:
those ten are, by their own labels, not actionable by this repository alone.
