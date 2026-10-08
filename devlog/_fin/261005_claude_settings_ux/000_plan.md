# 261005 Claude settings UX

The Connect > Claude tab shows Claude Code settings behind a second, inner sidebar
(General, Get started, Background helper model, Model interception, Available models).
With the app sidebar beside it, the page carries two rails, and every setting is one
extra click away. The Claude Desktop tab leads with four Claude family lanes (Opus,
Fable, Sonnet, Haiku), which is an implementation detail of how Desktop's model list is
written; most users only want to pick the model Desktop opens with and the model it uses
for light background work.

The user approved two designs on 2026-10-05 from the visual drafts in
`~/.codex/visualizations/2026/10/04/01a10726-.../`:

- **A** for Claude Code: one vertical page, no inner rail, a single sticky save bar,
  the Claude connection master switch kept last.
- **D1** for Claude Desktop: a Models card with Default model and Quick task model, a
  compact model list with role badges, and the family lanes moved under a collapsed
  Advanced disclosure.

## Loop spec

- Archetype: satisfy-spec, HOTL under cxc-loop, four work-phases.
- Goal: both designs implemented in the GUI, all locales translated, docs synced,
  gates green, PR merged to `dev` with exact-head CI.
- Non-goals: backend or management API changes, the Desktop profile wire contract
  (`src/claude/desktop-profile.ts`, `anthropicFamilyTier`), sidebar/navigation,
  1P picker semantics, release or promotion.
- Verifier: focused gui tests, `bun run lint`, `lint:i18n`, `build` in `gui/`; root
  `typecheck`, `structure:check`, `privacy:scan`, test suite per AGENTS.md; in-app
  browser render of both tabs against a local QA proxy.
- Stop condition: goalplan criteria c-1..c-5 carry fresh evidence.
- Resource bounds: this worktree, the local QA proxy's own admin token, GitHub PR/CI on
  the opencodex repository (merge authorized by the user). No stated token budget.
- Delegation: gpt-6.1-sol subagents for architect, audit, locale translation and review,
  each with a non-overlapping file scope and no git branch operations.

## Work-phase map

| WP | Doc | Outcome | Depends on |
|----|-----|---------|------------|
| wp0 | this file + 010/020/030 | diff-level roadmap | - |
| wp1 | [010](./010_phase1_claude_code_single_page.md) | Claude Code single page (A) | wp0 |
| wp2 | [020](./020_phase2_desktop_model_roles.md) | Claude Desktop model roles (D1) | wp1 |
| wp3 | [030](./030_phase3_land.md) | gates, PR, CI, squash merge | wp2 |

## Architect consultation

- Handle `01a1080c-7273-7923-aa76-632d14af55f8` (gpt-6.1-sol, architect, read-only), 2026-10-05.
- D1 vertical flow order: ACCEPT.
- D2 explicit accepted baseline: ACCEPT. `fetchCode` also runs directly after the 1P toggle,
  so resource data alone cannot be the dirty baseline. ClaudeCode keeps one combined draft
  `{ state, rows }` plus an accepted baseline; a read replaces the draft only when it is clean,
  otherwise it refreshes server-owned fields and keeps the editable ones (010).
- D3 canonical comparison (sorted, trimmed modelMap; sidecars via `serializeSidecarOverride`;
  raw row text so blank/incomplete rows still count as a change): ACCEPT.
- D4 omit `enabled` from the ordinary Save body: ACCEPT. Verified the PUT handler only writes
  `enabled` when present (`src/server/management/agent-settings-routes.ts`), so a stale Save
  can no longer undo an immediate connection toggle.
- D5 save bar (Save enabled when clean, disabled while saving; Revert disabled when clean;
  labelled region; separate polite status node): ACCEPT.
- D6 Desktop wording: PARTIAL. The user approved the labels "Default model" and "Quick task
  model", so they stay. The descriptions name the mechanism instead of promising Desktop
  behavior: Default model is listed first and sent as the Opus tier; Quick task model answers
  Desktop's Haiku-tier requests.
- D7 atomic move-and-default, mutual exclusion, "Not set" only when Haiku has no
  assignment: ACCEPT.
- D8 lanes stay mounted inside a closed `<details>`; summary carries warnings: ACCEPT.
- D9 tests for draft/read race and select invariants: ACCEPT.

## Outcome (2026-10-05)

Implemented as planned. Claude Code settings render as one page with a sticky Save bar;
Save no longer sends `enabled`, and a successful Save becomes the baseline before its
refresh (`gui/src/pages/claude-code-save.ts`). Claude Desktop leads with Default model and
Quick task model (`gui/src/pages/claude-desktop-roles.ts`), a compact model list, and the
family lanes under a folded Advanced disclosure; the profile wire contract is unchanged.
Reviews: architect, auditor and two code reviewers (gpt-6.1-sol); findings folded
(save-acknowledgement races, import/export with an empty catalog, stale guide navigation).
Verification: `gui` full tests 2889 pass, lint, lint:i18n, build; root typecheck,
structure:check, privacy:scan, full `bun run test`; docs-site build; in-app browser QA of both
tabs. What did not change: the subtitle on the Desktop tab still speaks of model families,
and the Quick task label rests on the Haiku tier mapping rather than observed Desktop behavior.

### Review hardening (PR #6596)

Maintainer review (Ingwannu), CodeRabbit, Codex and a gpt-6.1-sol adversarial reviewer drove the
Claude Code save path through seven rounds of ordering bugs, each reproduced as a mounted test in
`gui/tests/claudecode-save-bar.test.tsx` that fails on the previous head. The resulting rules:

- A per-cache-key write epoch, shared by every mount, marks reads that a write overtook as
  `superseded`; they never reach a draft or the session cache.
- Each mount folds new shared resource reads into its own draft during render, so a refresh
  started by another (even unmounted) page reaches the page on screen.
- Immediate switch results and Save confirmations are published per cache key; every mounted page
  merges them, and the session copy is the shared record of confirmed server state.
- A successful Save writes the normalized saved copy to the cache and baseline at once, and while
  a Save is out (`savePending`) no read replaces the draft wholesale.
