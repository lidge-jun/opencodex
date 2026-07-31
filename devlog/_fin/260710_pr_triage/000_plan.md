# 260710 — Integrate PRs #80/#79/#77 + triage issue #78, then main→preview/dev sync

## Loop-spec
- Archetype: spec-satisfaction (merge gates are pass/fail).
- Trigger: user request 2026-07-10 — review new PRs + issue, integrate (bias to accept), ff-sync branches, push all.
- Goal: all three Wibias PRs merged into main (or blocker-justified rejection), issue #78 triaged with a comment, origin/{main,preview,dev} all at local main SHA.
- Non-goals: touching the user's uncommitted docs-site/gui WIP; rewriting pushed history; fixing issue #78 unless a reproducible repo bug is found.
- Verifier: `bun test ./tests/` (0 fail) + `bun x tsc --noEmit` (exit 0) per merge; gui typecheck/build for GUI PRs; `git rev-parse` SHA equality for sync.
- Stop: all criteria met (DONE) / external GitHub failure (BLOCKED) / product decision needed (NEEDS_HUMAN) / ~2h wall-clock (BUDGET_EXHAUSTED).
- Memory: this unit + `.codexclaw/goalplans/integrate-prs-80-79-77-with-per-pr-pabcd-gpt-5-6/`.
- Resource bounds: repo-local writes + gh API on lidge-jun/opencodex; no destructive git; reviewer subagents are read-only.

## Context (evidence)
- Branch state: origin/dev(47ce6564) ⊆ origin/preview(308787a4) ⊆ origin/main(78cb5950) ⊆ local main(4bb44740, +8 hardening commits unpushed). preview/dev contain nothing not in main — ff sync is safe.
- Working tree: user WIP dirty in docs-site/* (46 files), gui/src/icons.tsx, gui/src/pages/Dashboard.tsx, gui/src/pages/Models.tsx + 3 untracked. MUST survive untouched.
- PR #80: src/server/request-log.ts + tests/request-log.test.ts, +93/-1, CI green, MERGEABLE. No overlap with the 8 local hardening commits (verified: git log origin/main..main -- <pr files> is empty).
- PR #79: gui-only (App.tsx, i18n/de.ts NEW, i18n/index.tsx, formatUptime.ts, status-codes.ts, styles.css, ui.tsx), +448/-20, CI green.
- PR #77: gui/src/i18n/{en,ko,zh}.ts, gui/src/pages/Dashboard.tsx, src/update/index.ts, +48/-5, CI green. Two risks: (a) Dashboard.tsx collides with user WIP at pull-back — merge happens on GitHub, local pull must stash/merge carefully; (b) cross-PR fallout: #77 adds i18n keys to en/ko/zh but not de (de.ts born in #79) → follow-up commit adds de keys.
- Issue #78: opencode-go deepseek → provider 400 "Upstream request failed"; other opencode-go models fine; another user reports it works. Likely upstream/env; needs code-grounded triage of src provider request shaping.

## Work phases (dependency-ordered; one PABCD cycle each)
1. WP1 — PR #80 (server, lowest risk, no WIP overlap): A-gate sol review → push local main first → merge #80 (squash) → pull back → test+tsc.
2. WP2 — PR #79 (creates de.ts; must land before #77 so the de fallout is visible): sol review → merge → gui typecheck/build + tests.
3. WP3 — PR #77: sol review → merge → add missing de.ts keys follow-up → full gates; verify user WIP intact.
4. WP4 — Issue #78 triage: code-grounded verdict + comment on issue.
5. WP5 — Sync: push main; ff-only preview+dev to main; push both; rev-parse equality proof.

## Merge mechanism decision
`gh pr merge --squash` against main after pushing local main (so PR CI/mergeability is judged against the real tip). Cherry-pick is fallback if GitHub reports conflicts after the push. Local pull-backs use `git pull --ff-only` with the WIP left dirty (none of #80/#79 touch WIP files; #77's Dashboard.tsx change merges on the remote side, and pull-back is a tracked-file update — stash only if git refuses the checkout).

## Acceptance criteria
- c1/c2/c3: PR merged + gates green (see goalplan criteria).
- c4: issue comment posted with file:line evidence.
- c5: 4-way SHA equality + WIP intact.
