# 030 refine and land

## Why

wp1 and wp2 shipped the grouped sidebar; four follow-up rounds of user QA on 2026-10-04/05
then reshaped the Claude surface (commits a1ba861c55, 4bd7d12b8a, 807d142355, e7880636c1).
The user asked to refine the branch and merge it into dev. This doc is the plan for that
landing cycle (work-phase wl1) and, after merge, the unit's terminal record.
LOOP-CONTINUITY: the previous D concluded "group rows + switcher, no hash migration"; the
follow-ups kept both and only changed Claude's shape, so the landing keeps them too.

## Final behaviour being landed

- Sidebar, eight rows: Dashboard, Connect, Codex, Providers, Models, Subagents,
  Usage & Logs, Remote Link (`gui/src/nav-groups.ts`). Usage & Logs and Remote Link carry
  the pill section switcher; Connect has none.
- Connect is the Integrations page titled Connect. Its strip: Overview, API keys, Codex,
  Claude, Claude Desktop, Grok Build, then the file clients.
- Claude has no sub-tabs: it renders the Claude Code settings directly. The master
  "Claude connection" switch (`claudeCode.enabled`, default on, same setting as the
  overview card) is the last row of General and commits immediately.
- Claude Desktop is its own Connect tab at `#claude/desktop`.
- Redirects: `#claude/account` -> `#providers?provider=anthropic&tab=accounts`;
  `#claude/settings` -> `#claude/code`; legacy `#integrations/claude[/desktop]` unchanged.

## Loop spec

Archetype satisfy-spec, single cycle wl1. Goal: branch refined, rebased on origin/dev,
gates green, PR to dev with screenshots on pr-assets, exact-head CI green, squash-merged.
Non-goals: src runtime changes, new features, unrelated cleanup (e.g. `.claude-tabs`,
unused before this branch). Verifier: below. Stop: merge visible on dev. Memory: this unit
+ goalplan wl1. Outcomes: DONE / BLOCKED (CI failing for reasons outside this diff, or
permission) / NEEDS_HUMAN (not expected: GUI + docs only, no auth/workflow/release files).
Escalation: a required check failing for this diff -> fix and re-push; unrelated flake ->
rerun once, then report.

## Architect consultation

Handle `01a107a2-663d-7472-8d1b-7e8fef7dcb12` (gpt-6.1-sol). R1.1 remove Providers'
scoped interface - ACCEPT. R1.2 remove five dead catalog keys - ACCEPT. R1.3 no further
CSS/helper removal, fix canonicalHashPath comment - ACCEPT. R2.1 three overlapping files,
App.tsx conflict on icons import and NAV block; keep grouped nav + upstream ThemeSwitch -
ACCEPT (merge-tree confirmed the App.tsx conflict). R2.2 styles.css 2952/2958 after union,
stale "seven rows" comments - ACCEPT. R3.1 this doc - ACCEPT. R3.2 move to _fin after
landing - AMEND: move inside this PR, because a post-merge move needs a second PR; the PR
is the terminal action and its description records the merge.

## File change map

1. MODIFY `gui/src/pages/Providers.tsx`: drop `ScopedProviderLogin`, `scopeProvider`,
   `scopeEmpty`, `poolConfig` derivation, the scoped quota shortcut, `scopedConfigured` /
   `scopedSections` / `scopedItem` and the scoped render arm; headers and boot rail
   unconditional; the Codex pool hook becomes `useCodexAccountPool(apiBase)` with its
   default enablement instead of the scope-dependent condition; remove imports left unused
   (typecheck + oxlint are the oracle).
2. MODIFY 11 catalogs: delete `claude.interceptRunning`, `claude.interceptStopped`,
   `claude.stateOn`, `claude.stateOff`, `nav.integrations` (and any allowlist entry).
3. MODIFY comments: `gui/src/nav-groups.ts` header ("seven" -> rows by the table),
   `gui/src/App.tsx` sidebar comment, `gui/src/app-routing.ts` canonicalHashPath doc.
4. MODIFY devlog: 000 phase map gains wp3 (Claude follow-ups) and wl1; 010/020 get a
   "superseded by 030" line; this doc. The unit stays in `devlog/_plan/` in this PR:
   its terminal outcome (the merge) cannot be recorded inside the commit being merged.
   The move to `devlog/_fin/` belongs to the next devlog-touching change after landing.
5. Rebase onto origin/dev; resolve App.tsx (keep NAV_GROUPS imports/usage, take upstream's
   icon set minus nav icons and its ThemeSwitch), sidebar-rows.test.ts, components.md.

## Verification (run in C)

- `bun run typecheck`; `bun run test` (full); `cd gui && bun test tests && bun run lint && bun run lint:i18n && bun run build`;
  `bun run structure:check`; `bun run privacy:scan`; `git diff --check`.
- Rendered smoke on the rebased build at 18990: eight rows, Connect strip, Claude without
  sub-tabs with the switch last in General, Providers page still renders (scoped removal).
- `gh pr checks <n>` on the exact head; merge with `gh pr merge --squash`; confirm
  `origin/dev` contains the squash commit.

## PR and merge procedure

- Re-fetch origin/dev right before rebasing (the reviewer saw it move to dabaed4840) and
  again right before merging; if dev moved and the branch is no longer current, rebase,
  re-run the affected gates, push, and wait for the new head's CI.
- Description uses the template headings Summary, Verification, Checklist. Verification
  lists exact commands and counts, plus a rendered image embed of the GUI screenshots stored
  on the `pr-assets` branch and linked by commit SHA, in the form pr-quality.cjs accepts;
  nothing image-like is committed to this branch.
- Maintainer integration record (MAINTAINERS.md:65): actor lidge-jun, current repo
  permission ADMIN (gh repo view viewerPermission), decision to integrate into dev without
  a second maintainer approval, exact-head SHA with its green check list, and a statement
  that there are no outstanding maintainer change requests (checked with
  `gh pr view --json reviews,reviewDecision` before merging).
- Required checks: inspect the `ci` aggregate's requested jobs and `enforce-target` on the
  exact head; a check missing, skipped-when-required, cancelled or on an older head is not
  evidence. Merge pinned to that head with `gh pr merge --squash --match-head-commit <sha>`.
- No Co-authored-by trailer: all commits are this session's own work.

## Outcome

Recorded in the PR before merge, so it can only state what is true at commit time:

- Branch head and base: the rebased head SHA and the origin/dev SHA it sits on.
- Commands and results: each verifier above with exit status and pass/fail counts. The
  2867/2860-pass figures in 010/020 are historical runs on earlier heads.
- Screenshots: pr-assets commit SHA and file names linked from the PR.
- PR URL and the exact-head CI result at the time of writing.
- Landing status: "validated locally, pending integration". The merge itself is evidenced
  by the PR's merge record (merge commit on dev), not by this file, because this file is
  part of the commit being merged.

## Reflection record

Same architect handle, rev 1: MISALIGNED with three doc gaps, no redesign. (1) explicit
Codex pool hook enablement - FOLDED into map item 1. (2) outcome recording contract -
FOLDED as explicit fields above. (3) truthful timing of an in-PR _fin move - FOLDED:
the file states "pending integration"; the PR merge record carries the landing evidence.

## Audit record

Reviewer `01a107a8-607d-7382-bb99-96d9395e233c` (sol, fresh), rev2: NEAR-PASS with two
blockers. (1) premature _fin move - FOLDED: unit stays in _plan for this PR. (2) PR/merge
procedure incomplete - FOLDED as the "PR and merge procedure" section (template headings,
maintainer record with ADMIN authority, objections check, exact-head pin, base revalidation).
Notes adopted: rendered image embed required by pr-quality.cjs; CI aggregate + enforce-target
are the evidence; origin/dev moved, re-fetch before rebase; Providers removal and five keys
confirmed safe by source inspection.
