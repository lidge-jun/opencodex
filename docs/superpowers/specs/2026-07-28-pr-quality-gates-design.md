# PR quality gates (ancestry + description) — Design

**Date:** 2026-07-28  
**Status:** Approved (brainstorm)  
**Related:** #631 (wrong-base enforcer), #644 (motivating bad PR), `AGENTS.md` / `MAINTAINERS.md` branch table  
**Branch base for implementation:** tip of #631 (`fix/enforce-pr-target-draft-fallback`) or `dev` after #631 merges

## Problem

`enforce-pr-target` only rejects wrong **base** refs (`main`, etc.). It does not catch:

1. **Wrong ancestry** — head branched from `main` (or another release tip) while targeting `dev` / `dev2-go`, so the PR diff dumps already-released or unrelated commits into the integration branch (seen on #644: 0 behind `main`, 44 behind `dev`).
2. **Empty or low-quality descriptions** — blank bodies, comment-only bodies (e.g. only CodeRabbit release notes), placeholder-only text, literal `\n` escapes instead of real newlines, or thin bodies that lack a minimum “what/why” structure (option 2 from brainstorm).

Wrong-base UX already drafts the PR, comments, and `setFailed`s the required check. New gates should reuse that pattern without overloading the `[WRONG BRANCH]` title prefix.

## Goals

- Fail the required `enforce-target` check when ancestry or description is unacceptable.
- Convert ready PRs to draft (soft-fail GraphQL, same as #631) and leave a single bot comment listing **all** open violations.
- Clear draft/comment/`setFailed` only when every gate passes (including after `synchronize` / body edits).
- Keep `pull_request_target` safe: **no checkout of PR head**; GitHub compare/API only; pure validators unit-tested offline.
- Escape hatch for maintainers with repo `push` so intentional release / promotion work is not blocked by the ancestry heuristic.

## Non-goals

- Rejecting local machine paths (`E:\…`), “tests not run” admissions, or forcing a fixed PR template (deferred).
- Auto-retargeting or auto-rebasing contributor branches.
- Retitling with `[WRONG BRANCH]` for ancestry/description (prefix stays wrong-**base** only).
- Blocking Dependabot / GitHub App bots beyond what the existing workflow already does (document any bot skips if added).

## Approach

**Extend the existing enforcer (Approach A):** extract pure checks into `.github/scripts/pr-quality.cjs`, orchestrate from `enforce-pr-target.yml` (or a thin shared runner), reuse draft/comment/`setFailed` state machine.

Rejected alternatives: soft gate only (B — weaker); separate workflow (C — duplicated draft/comment machinery).

## Gate composition

Evaluate in order; collect **all** failures before mutating:

1. **Wrong base** (existing) — `base ∉ {dev, dev2-go}`
2. **Wrong ancestry** (new) — when base is allowed
3. **Bad description** (new) — always when base is allowed (and optionally also when base is wrong, so authors fix body while retargeting; **default: run description whenever we have a PR body**, independent of ancestry)

If any failure is active:

- Upsert one bot comment (existing marker family, extended state) listing every open issue.
- Draft the PR if ready (soft-fail).
- `core.setFailed` with a concise summary (required check red).

If previously active and now all clear: restore ready only if bot drafted; update comment to success; do not leave `setFailed`.

## Wrong ancestry

### Inputs (API only)

For `base ∈ {dev, dev2-go}` and head SHA `H`:

- `GET /repos/{owner}/{repo}/compare/main...{H}` → `{ ahead_by, behind_by }`
- `GET /repos/{owner}/{repo}/compare/{base}...{H}` → `{ ahead_by, behind_by }`

No `actions/checkout` of the PR head.

### Rule

Flag **wrong ancestry** when:

```text
behind_main === 0
AND behind_base >= ANCESTRY_BEHIND_THRESHOLD   # default 20
```

This matches #644 (`behind_main = 0`, `behind_dev = 44`).

Optional refinement (not required for v1): also require `ahead_main <= ahead_base` so a long-lived fork that somehow sits on `main` tip but is not dumping main-only commits is less likely to false-positive. Prefer shipping the two-clause rule first with tests against recorded compare fixtures.

### Escape hatch

Skip the ancestry gate when the PR author has **push** permission on the base repository (`GET /repos/{owner}/{repo}/collaborators/{login}/permission` → `admin` | `maintain` | `write`). Contributors / fork authors without push remain gated.

Do **not** skip description quality for maintainers (empty/bad bodies remain rejected).

### Threshold

`ANCESTRY_BEHIND_THRESHOLD = 20` constant in the script. Document in comment why (tolerant of slightly stale `dev` forks; catches “branched from current main”).

## Description quality (option 2)

### Normalize body

1. Strip HTML comments (`<!-- … -->`), including CodeRabbit release-notes blocks.
2. Trim; treat placeholder-only whole body / lines like issue-quality (`N/A`, `TODO`, `No response`, …) as empty.
3. Detect **escaped newlines**: if the cleaned body contains few or no real `\n` characters but contains the two-character sequence `\` + `n` (or `\` + `r` + `\` + `n`) as a dominant separator, classify as **malformed** (fail). #644’s API body showed literal `\n` sequences.

### Accept when (after normalize)

**Substantial structured content**, either:

- **Structured path:** ≥ 2 markdown sections (h2–h4) whose cleaned text is each ≥ 40 characters, **or**
- **Unstructured path:** cleaned body length ≥ 120 characters **and** at least 2 bullets and/or paragraph breaks (real newlines separating non-empty blocks).

### Reject when

| Condition | Code / message key |
| --- | --- |
| Empty after strip | `empty` |
| Placeholder-only | `placeholder` |
| Escaped-newline malformed | `escaped_newlines` |
| Not substantial by either path | `thin` |

Reuse helpers from `issue-quality.cjs` where practical (placeholder / section richness), or duplicate minimal copies to avoid coupling PR and issue workflows if import paths are awkward in Actions. Prefer shared tiny helpers over drift.

## Workflow / UX

### Triggers

Extend `pull_request_target` types with **`synchronize`** so a rebase onto `dev` re-evaluates ancestry and can clear the failure. Keep: `opened`, `reopened`, `edited`, `ready_for_review`.

### Comment shape

Single bot comment (existing `<!-- wrong-branch-enforcer -->` marker **or** rename to a neutral `<!-- pr-quality-enforcer -->` with migration: accept either marker when finding the comment). Body sections:

- Wrong target branch (existing copy)
- Wrong branch ancestry (rebase onto current `base`; do not open from `main`)
- Pull request description (what failed + what “good enough” means)

Hidden JSON state extended with flags such as `ancestryFailed`, `descriptionFailed`, plus existing `autoDraftedByBot` / `titlePrefixedByBot` / `active`.

Title prefix `[WRONG BRANCH]` remains **only** for wrong base.

### Permissions

Unchanged from #631: `contents: write` + `pull-requests: write` for draft GraphQL; still no untrusted checkout.

## Testing

| Layer | Coverage |
| --- | --- |
| `.github/scripts/pr-quality.test.cjs` | Pure rules: #644-like compare fixture fails ancestry; behind_main>0 passes; maintainer skip N/A at pure layer; empty / comment-only / escaped `\n` / thin / good structured / good unstructured bodies |
| `enforce-pr-target.test.cjs` / harness | Workflow wires `synchronize`; calls quality module; `setFailed` when ancestry or description fails; soft-fail draft still; no checkout |
| `tests/ci-workflows.test.ts` | Permissions + trigger types stay in sync |

Offline fixtures only — no live GitHub in unit tests.

## Docs / policy

- Short note in contributing docs (docs-site) when user-facing: PRs must target `dev`, be based on current `dev` (not `main`), and include a real description.
- `AGENTS.md` / `MAINTAINERS.md` already define branch targets; add one sentence that CI rejects main-based ancestry and empty/thin PR bodies once shipped.
- Reminder: `pull_request_target` only picks up workflow changes after promotion to the **default branch** (and typically `dev` for fork PR path consistency) — same ops note as #631.

## Security

- No execution of PR head code.
- Compare API uses base-repo token; head SHA is attacker-influenced only as an opaque ref for compare (GitHub-side). Do not interpolate head ref into shell.
- Collaborator permission lookup is read-only; failure of that API should **fail closed for ancestry** (treat as non-maintainer) or soft-skip with warning — choose **fail closed** (apply ancestry gate) to avoid accidental bypass.

## Rollout

1. Land #631 if not already merged.
2. Implement this design on a follow-up branch from #631 tip / `dev`.
3. After merge + default-branch promotion, verify on a synthetic fork PR (main-based head → `dev`, empty body) that draft + red check appear, then fix body + rebase and confirm clear.

## Open constants (locked for v1)

| Name | Value |
| --- | --- |
| `ANCESTRY_BEHIND_THRESHOLD` | `20` |
| Min section length | `40` |
| Min rich sections | `2` |
| Unstructured min length | `120` |
| Unstructured min blocks | `2` |
| Release compare ref | `main` |
