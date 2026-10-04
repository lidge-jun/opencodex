# 261004 sidebar seven groups

The dashboard sidebar carried twelve rows, and four of them (Claude, Integrations,
Remote Link, Remote Workspace) all answered "how does a tool or machine reach this
proxy", while Usage, Logs & Debug and Storage are three views of what the proxy did.
This unit folds the sidebar into seven rows - Dashboard, Connect, Codex, Providers,
Models, Subagents, Usage & Logs - without changing a single page route. Grouped rows
show a small section switcher above the page so member pages stay one click away, and
every existing bookmark keeps opening the same page.

## Loop spec

- Loop archetype: satisfy-spec, single work-phase (wp1), HOTL under cxc-loop.
- Trigger: user request 2026-10-04 to reduce the sidebar to seven rows, put Connect
  directly below Dashboard, open Usage first inside Usage & Logs, run it on localhost,
  and finish a first browser QA pass before handing over.
- Goal: the seven-row sidebar with working group switchers, unchanged deep links,
  all locales translated, docs synced, gates green, and a first in-app-browser QA.
- Non-goals: server/runtime (src/) changes, page-internal behaviour, hash scheme
  changes or migrations, push/PR/merge/release/deploy, new dependencies.
- Verifier: see 010 "Verification". Focused gui tests + lint + lint:i18n + build, root
  typecheck + structure:check, then rendered checks in the in-app browser.
- Stop condition: all seven goalplan criteria carry fresh evidence, then report to the
  user for joint QA.
- Memory artifact: this unit (000 + 010), goalplan
  `.codexclaw/goalplans/opencodex-gui-7-1-qa-connect-codex-codex-usage-l/`, local
  commits on `codex/sidebar-seven-groups`.
- Expected terminal outcomes: DONE (all criteria met); NEEDS_HUMAN for taste calls
  (labels, default member of Connect) surfaced in the QA report; BLOCKED only if the
  local proxy/GUI cannot run.
- Escalation: anything needing push/PR, a src/ runtime change, or a hash migration goes
  back to the user. Two distinct failed subagents on one packet -> main reclaims.
- Resource bounds: local worktree only; no credentials beyond the local proxy's own
  admin token; no token/time budget was stated by the user.

## Architect consultation

- Handle: `01a10730-1637-7ba1-bb99-e069af29a599` (gpt-6.1-sol, V1 `multi_agent_v1`,
  logical architect via `CXC-ROLE: architect`). Proposal D1-D9 received 2026-10-04.
- D1 module boundaries: ACCEPT, AMEND - no `page-labels.ts` extraction; `PAGE_TKEY`
  stays in App.tsx because nothing outside App reads it and App has no size cap.
- D2 immutable group contract: ACCEPT (ids, order, members, first member = default).
- D3 derive activity, keep hashes: ACCEPT.
- D4 switcher as named `<nav>` + buttons + `aria-current="page"`: ACCEPT, AMEND -
  every button stays in normal Tab order (design-system segmented guidance), and
  Left/Right/Home/End additionally move focus; no roving tabindex.
- D5 keep member headings/controls: ACCEPT.
- D6 Startup ungrouped, unavailable workspace keeps Connect active: ACCEPT.
- D7 scoped pill CSS: ACCEPT, AMEND - styles.css has 2 lines of ratchet headroom
  (2956/2958), so the CSS lives in a new `gui/src/styles/section-switcher.css`
  imported by the component.
- D8 tests import the group contract instead of regex over App.tsx: ACCEPT.
- D9 docs: ACCEPT (web-dashboard guide, claude-code guide + translations, design-system
  components.md, structure owner docs).
- Reflection: see 010 "Reflection record".

## Work-phase map

| id | title | doc |
|----|-------|-----|
| wp1 | seven-group sidebar, switcher, i18n, docs, tests, localhost QA | 010_phase1_sidebar_groups.md |
| wp2 | Claude inside Connect, Remote Link as the last row | 020_phase2_claude_embedded_remote_row.md |
| wp3 | QA follow-ups outside the loop: Claude Desktop split out, Claude Account / Settings / Code sub-tabs removed, master switch moved to the end of General | recorded in 030 |
| wl1 | refine (dead code, comments), rebase on dev, PR, exact-head CI, squash merge | 030_refine_and_land_outcome.md |

The final shape is described in 030; 010 and 020 are the history of how it got there.
