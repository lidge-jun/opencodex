# 010 — Phase 1: PR #988 design review, small fixes, merge

## Goal

Land the only CI-clean bug PR (#988, Wibias: GUI providers quota/auth, Claude
pool toggle, combos/models layout, dev session bootstrap) after verifying it
against the repo's GUI design system. Fix only small deviations; no redesign.

## Review protocol (B of this phase)

This document is the review protocol; the concrete file-by-file verdicts and
any correction diff are appended here at this phase's own cycle P after the
actual PR diff is read, making 010 the complete record before its B starts.

## PR head under review

Head `3fc1eb52e25982606189219a3c0a6ced4352b1f3`, 24 files:

- Session bootstrap: `gui/src/api.ts`, `gui/vite.config.ts`,
  `src/server/gui-static.ts`, `src/server/index.ts`,
  `gui/tests/api-auth-memory.test.ts`, `tests/server-management-auth.test.ts`
- Provider auth surfaces: `gui/src/components/provider-workspace/*`
  (`ProviderAuthPanel`, `ProviderOverview`, `ProviderOverviewDashboard`,
  `ProviderDetails`, `ProviderCapacityQuota`,
  `AnthropicAccountPoolSettings`), `gui/src/components/CodexAccountPool.tsx`,
  `tests/provider-workspace-auth.test.ts`,
  `gui/tests/codex-account-pool-controller.test.ts`
- Loading/layout: `gui/src/pages/Combos.tsx`, `gui/src/pages/Models.tsx`,
  `gui/tests/page-loading-contract.test.tsx`
- Presentation: `gui/src/components/combo-workspace-add-modal.tsx`,
  `gui/src/components/combo-workspace-detail-panel.tsx`,
  `gui/src/styles-combos-workspace.css`,
  `gui/src/styles-dashboard-workspace.css`,
  `gui/src/styles-models-workspace.css`,
  `gui/src/styles/provider-overview-dashboard.css`

Server-side files (`gui-static.ts`, `index.ts`) get the same security read as
the GUI: the `/opencodex-session` bootstrap must keep origin-bound session
minting and must not weaken packaged-build auth.

1. Fetch the PR head into a local branch (`codex/review-pr988`) from
   `origin/dev` — never commit on top of the detached other-unit HEAD.
2. Read the full diff (`gh pr diff 988`).
3. Check against the design contract:
   - tokens: new spacing/typography uses existing CSS custom properties and
     the shared token files, no one-off magic values where a token exists;
   - UX states: loading/empty/error states keep their meaning
     (UX-STATE-01) — the removed "Loading combos..." line must be replaced by
     the documented `aria-busy` contract, not by silence;
   - accessibility: the pool toggle is a real switch control with
     `aria-pressed`/`role=switch`; capacity-warning contrast claim (WCAG AA)
     holds in both themes;
   - emoji ban: no emoji as UI visual elements;
   - the `/opencodex-session` dev bootstrap does not weaken the session
     contract for packaged builds (server-side change in
     `src/server/gui-static.ts` / `src/server/index.ts` gets the same read as
     the GUI files).
4. Verify: `bun run typecheck`, `bun run lint:gui`, `bun run build:gui`,
   focused GUI tests (`cd gui && bun test tests`), plus
   `bun test tests/provider-workspace-auth.test.ts tests/server-management-auth.test.ts`.
   Full `bun run test` on `ssh lidge` if any non-GUI file was touched by a
   fix.
5. If deviations are found: apply the smallest correction on the PR branch
   (author's fork permitting) or carry a follow-up commit on top of the merge.
6. Merge: `gh pr merge 988 --repo lidge-jun/opencodex --merge` (user
   authorized). Confirm the merge commit on `origin/dev`.

## Scope boundary

- IN: the 24 files in the PR diff, corrections within their existing lines.
- OUT: any redesign, token system changes, new components, other providers'
  pages, the CodeRabbit docstring-coverage warning (repo has no docstring
  convention; not a blocker).

## Accept criteria

- Review verdict recorded here with file:line citations for any fix applied.
- All gates in step 4 pass; evidence pasted into the phase record.
- `gh pr view 988 --json state` shows `MERGED`; `origin/dev` contains the
  merge commit.

## Review verdict (main + Franklin sol-medium independent pass)

Security design: PASS. `/opencodex-session` responds only when
`issueGuiSession` succeeds (`src/server/index.ts:995-1004`); issuance
requires GET, local mode, allowed origin, loopback Host
(`src/server/management-auth.ts:213-237`); session use rechecks origin +
CSRF (`management-auth.ts:287-300`); bootstrap docs are no-store,
frame-denied, attribute-escaped (`src/server/gui-static.ts:59-105`).
`changeOrigin:false` keeps the Vite origin across bootstrap + `/api`
(`gui/vite.config.ts:19-27`); the client holds credentials in memory,
same-origin only (`gui/src/api.ts:28-35,81-87,108-120,145-156`).
Emoji ban: PASS. Contrast: PASS with margin after the fix (`--amber` =
6.26:1 light, 9.65:1 dark, better than the PR's hardcoded pair).

Corrections applied as commit `e2d8ca430` on the PR branch
(maintainerCanModify, pushed after full pre-push gates):

1. a11y FAIL (merge-blocking): silent revalidation was announced by
   `aria-busy` alone — no live region. Added an sr-only
   `role="status" aria-live="polite" aria-atomic="true"` span carrying
   `common.loading` inside the Combos shell body
   (`gui/src/pages/Combos.tsx`) and the Models combos pending strut
   (`gui/src/pages/Models.tsx`), matching the `DataSurfaceStatus` contract
   (`gui/src/components/data-surface.tsx:64-89`).
   `gui/tests/page-loading-contract.test.tsx` now asserts the
   role/live/sr-only/text contract, not just the attribute flip.
2. Claude pool toggle accessible name was state-only ("On"/"Off") — now the
   stable `anthropicPool.title`; `aria-pressed` carries state
   (`gui/src/components/provider-workspace/AnthropicAccountPoolSettings.tsx`).
3. Token bypasses: warning hex pair → `var(--amber)`
   (`gui/src/styles/provider-overview-dashboard.css`); `72ch` →
   `var(--prose-measure)`, stale status-strip comment rewritten
   (`gui/src/styles-combos-workspace.css`); `48px` → `var(--space-12)`
   (`gui/src/styles-models-workspace.css`).

Left as-is (not merge-blocking): inline `8px`/`fontSize: 12` in the combo
forms (pre-existing file-local pattern); extra rendered-toggle and live
cross-origin negative tests (unit-level origin/CSRF negatives already cover
the gate; follow-up candidate).

## Gate evidence (pre-push, local)

- `bun run typecheck` — 0 errors
- `bun run lint:gui` — pass
- `bun run build:gui` — pass
- `cd gui && bun test tests` — 584 pass / 0 fail
- `bun test tests/provider-workspace-auth.test.ts tests/server-management-auth.test.ts`
  — 35 pass / 0 fail
- Pre-push hook (typecheck + lint + full `bun run test` + privacy:scan +
  doctor) — passed, push exit 0
