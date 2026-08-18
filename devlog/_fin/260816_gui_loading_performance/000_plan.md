# GUI loading resilience + performance campaign — plan

Date: 2026-08-16. Session: 01a00a59-96db-72a0-a12d-c8b9639e5607 (cxc-loop HOTL,
goalplan slug: opencodex-gui-dashboard-performance-campaign-fix).

## Objective

1. Kill the "infinite loading" wedge: any tab can sit on a skeleton forever until F5,
   then re-wedge later. Root-caused below with live fault-injection evidence.
2. Per-tab performance: fewer timers, fewer redundant requests, no unbounded fetches.
3. Hidden tab ≈ zero cost: every poll/timer in the dashboard pauses while
   `document.visibilityState === "hidden"` and resumes (with one make-up refresh) on
   visible. Only explicit opt-outs keep running (restart-reconnect detection).

## Constraints

- Worktree: /Users/jun/.codex/worktrees/f9b0/opencodex (detached at origin/dev tip
  b81314cd2 when started). Branches: codex/gui-* stack, PRs target dev / parent branch.
- The user's running ocx (port 10100) is never touched. All live verification runs
  against a sandboxed instance (OPENCODEX_HOME=/tmp/ocx-gui-perf/home, port 10199)
  behind a Vite dev server (port 5199, OPENCODEX_PROXY_TARGET).
- Commits/pushes use --no-verify (user-authorized). Push + PR + admin merge
  pre-authorized by the user for this campaign. Merges bottom-up via
  `gh pr merge --merge --match-head-commit <sha>`.
- Full suite runs on ssh lidge only (bun test --isolate tests); local gates are
  focused gui tests, `cd gui && bun run build`, `bun run typecheck` at PR boundaries.
- gui/AGENTS.md: no new hardcoded UI strings without i18n keys; no new dependency for
  behavior the stack can provide; gui/dist is generated.

## Root cause (evidence: 001_repro_evidence.md)

H1 — client-resource fetch path has no deadline. A hung request leaves
`refreshing:true` (cold keys also `loading:true`) forever: poll ticks skip while
`inflight` is set (client-resource.ts:212), the visibility make-up fetch skips too
(:192), and only manual refresh/unmount aborts (:214, :327). Measured: a stalled
/api/settings produced ZERO retries over 12s+ while its 5s poll tick fired.

H2 — the 401 re-bootstrap is an abort-proof, page-lifetime, app-wide chokepoint.
`resolveTokenAfter401` shares one `resolutionInFlight` promise (api.ts:165-189) that
awaits `reBootstrapSessionToken` → `rawFetch("/opencodex-session")` with no timeout
and no caller signal (api.ts:108-123). Loopback sessions expire every 5 minutes
(api.ts:101-107 design comment), so the wedge re-arms periodically. Measured: with the
bootstrap stalled and the server otherwise healthy, /api/* traffic dropped to ZERO for
40s+ while /healthz kept polling; cold tabs showed permanent skeletons (screenshot
archived in 001). Bonus finding: a non-polled store caught mid-wedge (Storage) never
recovered even after the network healed — nothing ever refires its request.

H5 (secondary) — raw `setInterval` pollers outside client-resource
(Debug 1s, ProviderSettings 2s, CodexAuth 30s, CodexAccountPickerSetting 30s,
DefaultModeRequestUserInputSetting 30s, Models loadV2 10s, useCodexAccountPool) have
no visibility handling, mostly no in-flight guard and no timeout. They keep firing in
hidden tabs and can stack hung requests.

Performance baseline (measured, CDP Network domain, 31s on Dashboard, idle sandbox):
48 API requests — 9 endpoints polled at ~5s cadence each plus /healthz x6. Full
per-tab inventory: 002_polling_inventory.md.

## Work-phase map (dependency-ordered, PHASE-SPLIT-01; stack plan DEV-STACK-01)

| WP | Decade doc | Layer (branch) | Proves on its own |
|----|-----------|----------------|-------------------|
| 1 | 010_phase1_resource_deadline.md | codex/gui-resource-deadline (base dev) | bounded fetch + wedge recovery in client-resource; tests |
| 2 | 020_phase2_auth_unwedge.md | codex/gui-auth-unwedge (base WP1) | 401/re-bootstrap can no longer pin the page; tests |
| 3 | 030_phase3_hidden_pause.md | codex/gui-hidden-pause (base WP2) | hidden tab ≈ zero fetch/timer activity; tests + measurement |
| 4 | 040_phase4_poll_consolidation.md | codex/gui-poll-consolidation (base WP3) | shared tick scheduler + re-activation revalidation; request-count delta |

Dependency rationale: WP1 is the data-path foundation every later layer's tests rely
on; WP2 touches only api.ts but its abort-threading composes with WP1's new signals;
WP3 builds the visibility ticker on the settled WP1 semantics; WP4 reshapes polling
on top of WP3's visibility-aware scheduler. Lower layers are mergeable alone: each
ships its own tests and stands green at its own tip.

Non-goals: server-side endpoint merging, gui/dist edits, release/version changes,
touching the running instance, redesigning page-level UX beyond error/loading states
that already exist in data-surface.

## Verifiers (all run at least once before each C>D)

- `cd gui && bun test tests/client-resource-poll.test.tsx tests/<new>.tsx` (focused)
- `cd gui && bun run build` (tsc -b && vite build — browser/bundler gate)
- `bun run typecheck` (root, at PR boundary)
- `cd gui && bun run lint` (oxlint, at PR boundary)
- Browser: in-app browser against localhost:5199 with CDP fault injection
  (repeat of 001 scenarios must now recover without reload)
- Remote: ssh lidge 'cd ~/Developer/opencodex && git fetch && git checkout <merged dev>
  && bun test --isolate tests' before final DONE claim.

## Expected terminal outcomes

DONE = all four PRs merged into dev, lidge isolated suite green, browser repro
scenarios recover without reload, hidden-tab request rate ≈ 0. BLOCKED/NEEDS_HUMAN
reported with evidence if any gate cannot run.
