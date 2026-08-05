# 040 — WP5: action queue and unverified ledger

> **Status: EXECUTED.** Sections above `# Queue (executed)` are the phase spec as
> it stood when WP5 ran; the queue, ledger, and accounting at the bottom are the
> result.

## What this phase must produce

1. A recommended action queue, ordered by dependency.
2. A complete `UNVERIFIED` ledger.
3. The surface accounting that shows nothing was dropped.

## Ordering rule

Dependency, never effort. An action goes after another when it *cannot* be done
first — not when it is bigger. Concretely, the expected dependency spine:

```
CI health (#1061, #1059)
  └── gates confidence in every other verdict, because a red suite
      makes "tests pass" meaningless as evidence for anything below
       ├── defect fixes with no external dependency (#1043, #1045, #1046, #1017, #1057)
       │     └── PR reviews that touch the same subsystems
       └── reporter-blocked items (#904, #796, #418, #994) — parallel, not blocked by CI
```

Each queue entry names its blocking predecessor explicitly, or states `no blocker`.

## Authorization boundary

Every entry is labeled with the authority it needs:

- `autonomous` — a code change inside normal contribution rules.
- `needs-user` — closing an issue, commenting on a contributor's PR, merging,
  retargeting, or anything that writes to GitHub.
- `needs-second-maintainer` — the security-review class (#936, #557).

This unit produces none of the writes. The queue is a recommendation; executing
any `needs-user` entry requires the user to say so.

## Unverified ledger format

```
| item | what could not be verified | why | what would verify it |
```

Expected residents, based on what this session structurally cannot reach:

- #796 — live Volcengine Ark credential.
- #904, #418, #994 — reporter captures.
- #1059 — a Windows runner.
- #1061 — a macOS release-train CI run.

Naming these as UNVERIFIED is the point. A triage that quietly upgrades
"I read the code and it looks right" into "verified" is worse than one that
admits the gap.

## Self-modification map

| File | Action | Content |
|------|--------|---------|
| `040_action_queue.md` | MODIFY (done) | appended `# Queue (executed)`, `## Unverified ledger`, `## Accounting` |
| any other file | — | none |

## Exact queue-item ledger

The queue is built from the closed verdict tables, not re-derived. Its source
rows are:

```
from 010 (real-open-defect):     1061 1059 1057 1046 1043 1024
from 010 (already-fixed-on-dev): 1045
from 010 (needs-reporter-info):  1017 904 796 994 418
from 010 (out-of-scope):         919 540 417 241 92
from 020 (every disposition):    all 25 open PRs
from 030 (pair resolutions):     1036/1017, 1056+999/241, 1047+1002/1024, 1043+1024
```

#1017 sits in `needs-reporter-info`, not `real-open-defect`: its lane returned the
stronger verdict and the audit gate rejected it. 6 + 1 + 5 + 5 = 17.

Every queue entry names its source row. An entry with no source row in `010`,
`020`, or `030` is a scope escape and must be removed.

## Executable commands

Runnable as-is; used to confirm the queue's preconditions at execution time.

```bash
cd /Users/jun/Developer/new/700_projects/opencodex
# 1. did anything in the frozen surface close or merge since the freeze?
gh issue list --state open --limit 100 --json number --jq '[.[].number]|sort|@json'
gh pr list  --state open --limit 100 --json number --jq '[.[].number]|sort|@json'

# 2. re-confirm the one closable issue before recommending a close
git merge-base --is-ancestor 4177345021 origin/dev && echo "1045 fix ANCESTOR"
bun test tests/system-restart.test.ts

# 3. re-confirm both drift-candidate ancestries
for sha in eeef7a32a d3abf4345; do
  git merge-base --is-ancestor $sha origin/dev && echo "$sha ANCESTOR" || echo "$sha NOT_ANCESTOR"
done
```

## Queue entry shape

```
| # | action | source row | blocking predecessor | authority |
```

## Surface accounting (the exact identity to reproduce)

```
39 open issues (frozen 2026-08-05T13:33:08Z)
 = 17 bug-class             -> 17 verdict rows in 010
 +  2 other-unit work items -> #1048, #1049, owned by 260804_codex_write_substrate
 + 20 enhancement/roadmap   -> #1060 #1058 #974 #823 #822 #821 #820 #809 #755
                               #695 #657 #572 #561 #415 #414 #386 #201 #178
                               #177 #95
post-freeze arrival: #1062 (recorded, not counted)

25 open PRs = 25 verdict rows in 020
```

Any discrepancy is a bug in this unit, not a rounding difference.

## Accept criteria

- Every queue entry has a blocking predecessor or `no blocker`.
- Every queue entry has an authority label.
- The unverified ledger names a concrete verification path for each row.
- The accounting table balances.

---

# Queue (executed)

Nothing here has been executed against GitHub — this unit holds no close,
comment, merge, or label authority, and every `needs-user` row waits on an
explicit instruction.

A predecessor appears only when the action is **impossible** without it. Judgment
about what to do first lives in the advisory column, where it cannot masquerade as
a constraint.

| # | action | source row | blocking predecessor | priority (advisory) | authority |
|--:|---|---|---|---|---|
| 1 | Close #1045 as fixed, citing `4177345021` (ancestor) and `bun test tests/system-restart.test.ts` → 24 pass | `010` #1045 | no blocker | high — free, fully proven | needs-user |
| 2 | Fix #1061's harness: bound the `restart.exited` await with a deadline + kill fallback, and make `waitFor()` prove parseable JSON rather than file existence | `010` #1061 | no blocker | high — a 30-minute hang blocks release trains | autonomous |
| 3 | Triage #1059 into its five failure families as separate work items; correct the "~207" figure to "at least 113, count aborted by a Bun panic" | `010` #1059 | no blocker | medium — easier to read once entry 2 lands, but not gated on it | autonomous, needs a Windows runner |
| 4 | Classify `opencode-zen` models in the registry — one change closing #1043 and the reproducible half of #1024 | `030` #1043/#1024 | no blocker | high — one change, two issues | autonomous |
| 5 | Correct the DeepSeek effort ladder (`src/providers/registry.ts:349,353,1185`) and the two tests that currently lock the wrong ladder | `010` #1057 | no blocker | high | autonomous |
| 6 | Call `afterCatalogWriteHandleAppServers()` on the startup sync path for #1046 | `010` #1046 | no blocker | high | autonomous |
| 7 | Review #1018 — the only PR that is green, mergeable, and inside the freshness gate | `020` #1018 | no blocker | high — the only reviewable PR on the board | needs-user |
| 8 | Ask the five reporters for the captures that unblock #904, #796, #994, #418, #1017 | `010` ×5 | no blocker | high — five verdicts move on reporter evidence alone | needs-user |
| 9 | Route #936 and #557 to the second-maintainer security review they have been waiting on since 07-27 | `020` #936, #557 | no blocker | high — never a technical blocker, only an unassigned one | needs-second-maintainer |
| 10 | Give the 21 out-of-gate PRs a single honest rebase-or-close message; for #715 specifically, decide between re-authoring and closing rather than asking for a fifth rebase | `020` ×21 | no blocker | medium | needs-user |

### No entry has a hard predecessor, and saying so took three audit rounds

Earlier drafts blocked entry 3 on entry 2, entry 7 on platform work, and entry 10
on review capacity. The audit rejected all three, correctly. Windows triage does
not become *impossible* while the macOS leg hangs — it becomes harder to read, and
"harder to read" is a priority, not a dependency. The same applies to the others.

`PHASE-SPLIT-01` forbids ordering by effort or payoff, and the subtler version of
that violation is what happened here: a real judgment about sequencing got written
into the dependency column because that column carries more authority. The column
split is the fix, and the judgment survives intact below.

**Advisory, not blocking.** Asking twenty-one contributors to rebase into a queue
where one PR is currently reviewable produces twenty-one rebased PRs and the same
bottleneck. The behind-counts are a symptom of merge latency, not contributor
neglect. And a repository whose macOS leg can hang for thirty minutes and whose
Windows leg is dispatch-only should treat every green check as weaker evidence
than it looks — which is why entries 2 and 3 are near the top even though nothing
formally waits on them.

## Unverified ledger

| item | what could not be verified | why | what would verify it |
|---|---|---|---|
| #1017 | that the Cursor adapter corrupts a valid payload | the anchors prove the tool boundary exists, not that it mangles input; the lane over-called this and the audit caught it | the reporter's malformed wire capture, or a regression test driving the path |
| #1059 | the "~207 failures" figure and whether the families share a cause | the cited run aborted on a Bun internal panic after 113 counted failures | a full Windows shard run to completion |
| #1061 | that the hang reproduces | one local macOS run passed 2/2; the failure is load-dependent | a macOS release-train CI run |
| #796 | that the Ark 400 is gone in practice | needs a live Volcengine Ark credential | a reporter or maintainer run against Ark |
| #904 | that the U+FFFD corruption is gone | the surrogate fix landed but the original capture was never provided | the reporter's failing capture |
| #994 | which provider/model path produces it | the report does not name them | reporter's provider/model + wire capture |
| #418 | that V2 custom-parent delegation still fails | the latest same-run trace does not reproduce | reporter's current trace on a current build |
| #1024 (`TR` half) | Kimi behavior through `TR` | `TR` is not a built-in registry provider | the reporter's provider configuration |
| every PR diff | semantic correctness of 25 contributor diffs | this unit judged structure, CI, and freshness — not code review | per-PR review, which is entry 7 and entry 10 work |

Nine rows. That is roughly a third of the surface, and stating it plainly is the
point: a triage that reported seventeen confident verdicts would be less useful
than one that reports eight solid ones and names what the other nine are waiting
on.

## Accounting

```
39 open issues (frozen 2026-08-05T13:33:08Z)
 = 17 bug-class             -> 17 verdict rows in 010
 +  2 other-unit work items -> #1048, #1049 (260804_codex_write_substrate)
 + 20 enhancement/roadmap   -> #1060 #1058 #974 #823 #822 #821 #820 #809 #755
                               #695 #657 #572 #561 #415 #414 #386 #201 #178
                               #177 #95
post-freeze arrivals: #1062, #1063 (recorded, not counted)

25 open PRs -> 25 verdict rows in 020
```

Balances: 17 + 2 + 20 = 39. ✔

Live drift observed during this unit, recorded rather than chased: `origin/dev`
advanced `8949c4940` → `aaa71967a`; #1010's head moved once; #1019's head moved to
`ea310c859` (0 behind / 50 ahead, `hygiene` still failing) during the final audit.
The tables are anchored to declared base and head shas, so they stay auditable
even as the surface moves.

## Terminal outcome

`DONE` for the triage objective; the recommended actions are a queue, not a
completed program. Every `needs-user` and `needs-second-maintainer` entry is
blocked on authority this unit deliberately does not hold.
