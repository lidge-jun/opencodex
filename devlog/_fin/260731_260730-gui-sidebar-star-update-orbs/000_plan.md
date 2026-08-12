# 000 — 260730-gui-sidebar-star-update-orbs: Plan

> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## Objective

Rework the GUI sidebar footer so the GitHub entry carries two circular satellite
controls (star, update), and fix two dashboard surfaces the user flagged from the
running GUI at `http://localhost:10100/#dashboard`:

1. The startup-health chip ("재부팅 후 Codex 모델 연결이 끊길 수 있습니다") only
   converged after the user clicked something. Evidence: the dashboard chip poll
   discards the server's `diagnosticStale` marker
   (`gui/src/pages/dashboard-core-poll.ts:97-113` before this work) and polls at
   30s (`gui/src/pages/use-dashboard-data.ts:181-186`), while the server answers
   the first request from a stale-while-revalidate fallback
   (`src/server/startup-health-cache.ts:130-135`). The Startup page already
   re-asks after 2s when stale (`gui/src/pages/Startup.tsx:186-190`); the chip
   never did, so it sat on the placeholder for up to 30s.
2. The maintenance panel spends a full row on "모델 동기화 / 업데이트 확인", which
   duplicates the new sidebar update control.

Plus a copy pass: the sub-agent delegation panel's three controls are described in
jargon the user could not parse ("이거 너무 어려워").

## Loop-spec

- Loop archetype: verifier-defined (typecheck/test/lint/build + rendered browser proof).
- Write scope: `src/github/`, `src/update/badge.ts`,
  `src/server/management/sidebar-routes.ts`, `src/server/management-api.ts`,
  `gui/src/{App.tsx,icons.tsx,styles.css,app-routing.ts,use-app-route-state.ts,startup-health-ui.ts}`,
  `gui/src/components/sidebar-github-row.tsx`, `gui/src/pages/dashboard-*`,
  `gui/src/i18n/*.ts`, `tests/`.
- Out of scope: pushing, releasing, docs-site rewrites, credential-storage changes,
  and holding a GitHub token inside opencodex (starring stays on the user's `gh`).
- Budget: local checks only; no remote CI runs.

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | `010_sidebar_orbs.md` | Sidebar star + always-visible update orb, backend star/badge APIs, regression tests | — |
| wp2 | `020_startup_health_sync.md` | Chip converges on its own after a stale answer | — |
| wp3 | `030_panel_copy.md` | Maintenance-panel dedupe + plain-Korean delegation copy across 6 locales | wp1 |
| wp4 | `040_verification.md` | Full gates + rendered browser proof | wp1-wp3 |

## Accept criteria

- c1: the update orb is present even with no update available, and clicking it runs a
  check and offers install/cancel.
- c2: an available update renders the orb in the accent (blue) state; the star orb
  reflects starred / not-starred / gh-unauthenticated.
- c3: after a stale startup-health answer the chip re-asks within seconds.
- c4: delegation copy is plain Korean and all six locales carry the keys.
- c5: `bun run typecheck`, `bun run test`, and `cd gui && bun run lint && bun run
  lint:i18n && bun run build` pass, plus a browser screenshot of the sidebar.
