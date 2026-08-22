# 000 — Plan: open bug-issue and open-PR triage, 2026-08-05

## Objective

Give every currently-open bug-class issue and every currently-open pull request
exactly one disposition, backed by evidence that was checked today, and state for
each one whether a previous devlog unit already answered the question.

The second half is the point. This repository has run triage rounds on 2026-07-21,
07-22, 07-23, 07-24, 07-25, 07-27, 07-28, 08-02, 08-03, 08-04, and 08-05. Several
of the items still open have been investigated two or three times. Re-deriving a
verdict that `devlog/_fin/` already recorded is the failure mode this unit exists
to prevent, and the inverse — a devlog that says "fixed" for something still open —
is a drift signal worth surfacing on its own.

## Frozen surface

| Fact | Value |
|------|-------|
| Snapshot taken | 2026-08-05T13:33:08Z, **superseded** by the re-freeze at 13:59:09Z |
| `origin/dev` | `aaa71967a` (authoritative; the first freeze at `8949c4940` is superseded — see `002`) |
| Working branch | `dev` (clean) |
| Open issues | 39 |
| Open issues, bug-class | 17 (16 from the `bug`/`provider-compatibility` label query + unlabeled defect-shaped #1045) |
| Open pull requests | 25 |

"Bug-class" is defined as: carries the `bug` label, or carries
`provider-compatibility`, or carries no label at all **and** describes a defect.
The `and` matters. Three issues are unlabeled (#1049, #1048, #1045); only #1045
is a defect. #1048 and #1049 are work items of the
`260804_codex_write_substrate` unit, and counting another unit's plan as backlog
would corrupt the accounting in both directions. See `002` for the exact query.

## Method

Read-only throughout. No issue is closed, no PR is merged, retargeted, or
commented on, and no label is edited. This unit produces verdicts and a
recommended action queue; executing that queue is a separate authorization.

Three evidence classes are admissible:

1. **Ancestry.** A claim that something is already fixed on `dev` requires
   `git merge-base --is-ancestor <sha> origin/dev`. A remembered "that landed" is
   not evidence — this rule exists because the 08-04 round found devlog claims of
   landed work that had only landed on a stack branch.
2. **Source anchor.** `path:line`. Code anchors were read at `8949c4940`; the
   five commits `aaa71967a` adds do not touch those paths, so the anchors hold at
   the authoritative base. Distances and CI state are recorded at `aaa71967a`.
3. **Live GitHub read.** `gh` read-only queries for CI conclusion, mergeable
   state, review decision, and head ancestry.

Anything that resists all three is written down as `UNVERIFIED` with the reason,
not quietly upgraded to a guess.

## Work-phase map (dependency-ordered)

The order is forced by data dependency, not by how easy each phase looks.

```
WP1 docs-only roadmap
 └── freezes the surface + indexes prior art
      ├── WP2 issue verdicts        (needs: prior-art index, dev sha)
      └── WP3 PR verdicts           (needs: prior-art index, PR head ancestry)
           └── WP4 cross-links      (needs: BOTH verdict tables)
                └── WP5 action queue (needs: the cross-link matrix)
```

WP4 cannot start before WP2 and WP3 both close, because a duplicate/superseded
judgment compares a PR's actual scope against an issue's actual state; either half
alone produces the "the linked issue is fixed, so close the PR" error the 08-05
campaign explicitly banned (`devlog/_fin/260805_bug_stack_campaign/130_dispositions.md`).

| Phase | Deliverable | Closes when |
|-------|-------------|-------------|
| WP1 | `000`–`002` + pre-written `010`–`040` | every later doc exists at doc-level precision |
| WP2 | `010_issue_verdicts.md` | 17/17 bug-class issues have a disposition + anchor + prior-art pointer |
| WP3 | `020_pr_verdicts.md` | 25/25 open PRs have a disposition + CI/base evidence |
| WP4 | `030_cross_links.md` | every issue↔PR claim pair is resolved with an equivalence basis |
| WP5 | `040_action_queue.md` | queue is dependency-ordered and the UNVERIFIED ledger is complete |

## Disposition vocabulary

Fixed set; a verdict outside it is a documentation bug.

- `already-fixed-on-dev` — ancestry-proven, awaiting close.
- `real-open-defect` — reproduces or is structurally provable against `8949c4940`.
- `needs-reporter-info` — blocked on a capture, credential, or environment only the reporter has.
- `duplicate-of-#N` / `superseded-by-#N` — requires a semantic equivalence basis, never just a shared issue link.
- `stale-needs-author` — CI red, conflicting, or too far behind `dev` for the readiness gate.
- `ready-to-review` — green, mergeable, close enough to `dev` to merge as-is.
- `out-of-scope` — belongs upstream or to another surface.
- `blocked` — waits on a decision or a security review this unit cannot make.

## Scope boundary

**IN:** devlog documents under this unit; read-only inspection of the tree,
git history, and GitHub; local commits of these documents.

**OUT:** any change under `src/`, `gui/`, `scripts/`, `tests/`; `git push`; any
`gh` write (close, comment, label, merge, retarget, ready-for-review); release
actions. Security findings, if any surface, go to `.tmp/` per `AGENTS.md`, never
into this directory.

## Dispatch plan

Explorer subagents (`gpt-5.6-sol`, medium) run read-only lanes with disjoint item
slices. Every packet forbids writes and `gh` entirely, and requires verbatim
`path:line` anchors in the return so the main session can spot-check. The main
session owns every verdict; a subagent returns evidence, not dispositions.

Bound: 40 dispatches, 5 work-phases (WP1–WP5 as mapped above). If a sixth unit is
discovered mid-loop it is appended as a P-phase amendment with its own decade doc,
not smuggled into an existing phase.

## Base revisions during this unit

| Time | base | why it moved |
|------|------|--------------|
| 13:33:08Z | `8949c4940` | initial freeze |
| 13:49:12Z | `8949c4940` | #1010 pushed a new head; base unchanged |
| 13:59:09Z | `aaa71967a` | `dev` advanced five commits; **all 25 PR distances recomputed atomically** |

Recording this is not bookkeeping for its own sake. A triage table whose rows were
measured against different bases is not internally comparable, and the failure is
invisible unless the base is stated.
