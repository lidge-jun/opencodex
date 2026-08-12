# 000 — Stacked PR CI: scope and evidence

Unit: `260804_stacked_pr_ci`
Class: C3 (two workflow-surface defects, cross-cutting, needs durable audit)

## The defect, in one sentence

A stacked child pull request — one whose base is another **open** PR's head
branch — runs no test CI at all, and gets no type label.

## Evidence

`AGENTS.md` calls stacked child PRs an intentional review workflow:

> Stacked child pull requests that target another **open** PR's head branch are
> an intentional review workflow, not an alternate integration line.

`enforce-pr-target.yml` implements that intent: it detects a stacked base by
listing open PRs and matching `other.head.ref === pr.base.ref`, then skips the
wrong-base gate. So the repository deliberately supports this shape.

Observed on the #951–#955 stack (checked 2026-08-04, `gh api
repos/lidge-jun/opencodex/commits/<head>/check-runs`):

| PR | base | check-runs present |
| --- | --- | --- |
| #952 | `codex/bug-stack-plan` | `enforce-target`, `label`, `react-doctor` |
| #953 | `codex/908-long-context-pricing` | `enforce-target`, `label`, `react-doctor` |
| #954 | `codex/carry-contributor-bugfixes` | `enforce-target`, `label`, `react-doctor` |
| #955 | `codex/545-classifier-thinking-disabled` | `enforce-target`, `label`, `react-doctor` |

No `ci`, no `gates`, no `test 1/4`–`test 4/4`. The stack carried 24 changed
files under `src/` and 748 added lines with **zero** CI verification history.

Labels on all four: empty.

## Root cause 1 — the `ci.yml` branch filter

`.github/workflows/ci.yml`:

```yaml
on:
  pull_request:
    branches: [main, dev]
    paths: [...]
```

GitHub evaluates `branches:` against the PR's **base** ref. A stacked child's
base is `codex/bug-stack-plan`, which is neither `main` nor `dev`, so the
workflow is never queued. The other PR workflows have no `branches:` filter
(`enforce-pr-target.yml`, `pr-labeler.yml`, `react-doctor.yml`), which is
exactly why those three checks appear and the test jobs do not.

The filter is not wrong on its own — it exists to keep CI off unrelated base
branches. It is wrong that it has no exception for the one alternate base shape
the repository explicitly supports.

### The fix, after audit

The first draft narrowed the filter to `[main, dev, "codex/**"]`. The audit
killed it: open PR head refs are `codex/` (14) **and** `fix/` (4), `feat/` (3),
`agent/` (3), `split/`, `ingw/`. Any of those can become a stacked base, and a
contributor stack is the case that most needs CI. An allowlist cannot express
"base is another open PR's head".

So the filter goes, and `paths:` — untouched — remains the scope gate. That is
already this repository's other pattern: `issue-quality-tests.yml` runs
`pull_request` with `paths:` and no `branches:`. Details in `010`.

## Root cause 2 — the labeler's title contract

`.github/scripts/pr-labeler.cjs` → `detectTypeLabelFromTitle()` recognises two
forms:

1. conventional commit — `^([a-zA-Z]+)(\([^)]*\))?!?\s*:`
2. sentence-case fallback — `^([A-Za-z]+)\s+\S`

Verified locally against the real stack titles:

```
planTypeLabelSync({title: "stack 1/5: triage the open issue surface..."})
  -> { skip: true, reason: "no-prefix" }
```

`stack 1/5:` fails the conventional regex (the `1/5` sits between the word and
the colon) and is then caught by the sentence-case fallback, which extracts
`stack`. `PREFIX_TO_LABEL` has no `stack` key, so the lookup returns `null` and
the sync skips. The `label` check still reports success — a skip is not a
failure — which is why this stayed invisible.

This is **not** a stacked-PR bug. It is a title-vocabulary bug that the stack
happened to expose: any PR titled with an unrecognised prefix word is silently
unlabeled. The stack shape and the label gap are independent defects that share
one symptom report.

## Non-goals

- Merging #952–#955. The user owns that; this unit never touches those PRs.
- Changing `src/` runtime code.
- Promotion to `main`/`preview`, releases, tags.

## Promotion caveat that must reach the docs

`pr-labeler.yml` and `enforce-pr-target.yml` run on `pull_request_target`, which
GitHub always loads from the repository **default branch** (`main`). Landing a
labeler change on `dev` does not change live behavior until it is promoted. The
labeler file already carries this comment; the contributor docs do not say it.
`ci.yml` runs on `pull_request` and is read from the PR's merge ref, so the CI
trigger fix takes effect as soon as it is on the base branch being targeted.

## Work-phase map (dependency-ordered)

| Phase | Doc | Depends on |
| --- | --- | --- |
| 1 | `010_ci_trigger.md` | — |
| 2 | `020_labeler_and_docs.md` | 010 (shares the test file) |

Phase 2 touches `tests/ci-workflows.test.ts` after phase 1 has added its block,
so it must run second to avoid re-resolving the same region twice.
