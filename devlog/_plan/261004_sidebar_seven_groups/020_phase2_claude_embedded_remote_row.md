# 020 phase 2 - Claude inside Connect, Remote as the last row

Superseded by 030_refine_and_land_outcome.md for the shipped shape (Claude Desktop as its
own Connect tab; Claude without sub-tabs). Kept as the record of the second cycle.

## Why

wp1 (D at a690c2a9da) shipped seven rows with Connect = switcher over Claude,
Integrations, Remote Link, Remote Workspace. After the first QA the user asked:
"claude는 연결에 내장으로 remote는 별도 탭으로 빼자 가장 하단에". So Connect opens the
Integrations page with Claude as one of its own tabs, and Remote becomes the eighth and
last sidebar row. LOOP-CONTINUITY: wp1 concluded "group rows + switcher, no hash
change"; wp2 keeps both principles and only changes membership and Claude's host.

## Loop spec

Archetype satisfy-spec; trigger = user steering above; goal = 8 rows, Claude embedded,
Remote last; non-goals = hash migration, src/ runtime, page internals beyond Claude's
embedded head and Account polling gate, push/PR; verifier = focused gui tests + lint +
lint:i18n + build + typecheck + structure:check + in-app browser re-check; stop = wp2
criteria (c-8..c-11) carry evidence; memory = this doc + goalplan wp2; outcomes DONE /
NEEDS_HUMAN for taste; escalation as 000. Bounds unchanged.

## Architect consultation

Handle `01a10745-e31b-7c91-ba42-b5ec6b6cd4e6` (gpt-6.1-sol, fresh context), E1-E8:
E1 keep Page "claude" + all #claude/* hashes - ACCEPT. E2 NavGroup.embedded - ACCEPT.
E3 one Integrations slot for integrations|claude, boundary key claude->integrations,
PAGE_TKEY.integrations -> nav.connect, heading nav.connect - ACCEPT. E4 TABS claude after
codex, hash "claude", Claude rendered embedded in the latched panel, not a FILE_CLIENT -
ACCEPT. E5 keep both listeners; Claude only reacts to claude-family hashes - ACCEPT.
E6 Account's Providers mounts only while active - ACCEPT. E7 embedded drops page-head,
inner strip gets a compact filled style - ACCEPT. E8 tests - ACCEPT.

## File change map

- MODIFY gui/src/nav-groups.ts: `NavGroup.embedded?: readonly Page[]`; connect =
  `{ pages: ["integrations"], embedded: ["claude"] }`; append
  `{ id: "remote", tkey: "nav.remote", Icon: IconMonitor, pages: ["remote", "remote-workspace"] }`;
  `NavGroupId` gains "remote"; `groupForPage` checks pages and embedded;
  `visibleGroupPages` unchanged (pages only). Header comment updated.
- MODIFY gui/src/App.tsx: drop the Claude import and `{page === "claude" && <Claude .../>}`;
  integrations slot renders for `page === "integrations" || page === "claude"`;
  `const shellPage = page === "claude" ? "integrations" : page` used for ErrorBoundary
  key and pageName; `PAGE_TKEY.integrations = "nav.connect"`.
- MODIFY gui/src/pages/integrations/integration-tabs.ts: union + TABS entry
  `{ id: "claude", hash: "claude", labelKey: "nav.claude" }` after codex.
- MODIFY gui/src/pages/Integrations.tsx: `readIntegrationTab` maps raw "claude" or
  "claude/..." to "claude"; heading `t("nav.connect")`; claude panel renders
  `<Claude apiBase={apiBase} active={active} embedded />`; tabMark for claude uses
  INTEGRATION_MARKS.claude (already there).
- MODIFY gui/src/pages/Claude.tsx: prop `embedded`: section class adds
  `claude-page--embedded`, page-head omitted; hash sync ignores non-claude hashes;
  Account Providers renders only when `active && tab === "account"`.
- MODIFY gui/src/styles/claude-page.css: compact filled inner tabs under
  `.claude-page--embedded .page-tabs` (no underline, pill fill on active).
- Tests: sidebar-rows (8 groups, connect embedded claude, remote last),
  dashboard-tabs unchanged (connect 2nd, codex 3rd), i18n-language-switch NAV_TKEYS +
  nav.remote with en/zh-TW/zh/fr labels, section-switcher test's availability case
  moves to the remote group, integrations-tab-coverage routability via
  `resolveAppHashChange(hash).replaceTo === null`, claude-page: embedded renders no
  page-head h2 + Providers not mounted when inactive; integrations-routing: #claude/code
  resolves to page claude and readIntegrationTab-equivalent picks the claude tab (via
  Integrations render test if feasible, else covered in browser).
- gui/tests/integrations-routing.test.ts:133 asserted `<Claude apiBase={sharedBase}` in
  App; it moves to Integrations.tsx: `<Claude apiBase={apiBase} active={active} embedded />`
  and App passes the same sharedBase to Integrations for both pages.
- gui/tests/claudecode-layout.test.ts:18 asserts `<Claude apiBase={sharedBase} />` in App;
  it becomes an assertion on Integrations.tsx hosting `<Claude` with `embedded`.
- gui/tests/sidebar-rows.test.ts:66 pins `key={page}`; it becomes `key={shellPage}` with
  the explanation that Claude and Integrations share one shell.
- Cold legacy links (`#integrations/claude`, `#integrations/claude/desktop`): the route
  hook replaces the hash passively after both components have read it. Fix at the
  readers: `readIntegrationTab` and `readClaudeTab` (claude-tab.ts) first resolve the raw
  hash through `resolveAppHashChange(raw).replaceTo ?? raw` (pure, app-routing.ts), then
  read it. The Claude-family branch runs before the exact `TABS.find`. Unit tests:
  `readClaudeTab("#integrations/claude/desktop")` is "desktop",
  `readClaudeTab("#integrations/claude")` is "code", and the browser cold-loads both.
- i18n-language-switch French array appends "Lien distant" (nav.remote).
- Docs: web-dashboard paragraph (8 rows, Claude tab inside Connect, Remote last),
  design-system components.md bullets, structure/dashboard-and-usage.md sentence.
  claude-code.md "under Connect" stays correct.

## Acceptance (activation)

c-8 eight rows in order (DOM + unit). c-9 Connect opens #integrations; Claude tab
inside the strip; #claude/code deep link lights Connect and selects the Claude tab and
its Code sub-tab. Shell persistence is checked as two separate facts: (a) DOM identity -
tag the `.integrations-page` element in the browser, switch Keys -> Claude -> Keys, the
same element is still connected; (b) a draft - type into a field on one tab, switch to
Claude and back, the value is still there. History/keyboard: Back/Forward across
Keys <-> Claude <-> Claude/Settings restore hash, outer selection and inner selection;
Arrow/Home/End in the outer strip and in Claude's inner strip move selection and focus
within their own strip only. c-10 Remote
row opens #remote; Workspace hidden on standalone (activation: standalone runtime) and
present when available (unit). c-11 gates + browser re-check incl. hidden-Claude
Account not polling: on #integrations/keys after visiting Claude, no request to the
provider roster endpoint in the browser network log/dev logs (or unit test on
Claude active=false).

## Reflection record

- Rev 1 to the same handle: MISALIGNED, E1-E7 aligned, E8 gaps: (1) the App Claude
  source assertion in integrations-routing.test.ts:133 - FOLDED; (2) shell persistence
  conflated focus with drafts - FOLDED as separate DOM-identity and draft checks;
  (3) nested history + keyboard checks - FOLDED into c-9.

## Audit record

- Reviewer 01a1074a-9601-7090-99c9-098dcfc8fa86 (sol, fresh) on rev2: FAIL, 3 blockers -
  (1) cold legacy #integrations/claude[/desktop] would land on Overview/default sub-tab -
  FOLDED (readers resolve through resolveAppHashChange + unit tests + browser cold load);
  (2) claudecode-layout.test.ts:18 App assertion - FOLDED; (3) sidebar-rows key={page}
  pin - FOLDED. Notes: invariants safe, ordering of claude branch, shared boundary error
  persistence accepted (retry button recovers), French "Lien distant", polling check
  visits Account first - all adopted.

## D summary

Shipped at 6d8073ef1a on codex/sidebar-seven-groups (local, not pushed). The sidebar
has eight rows ending with Remote Link; Connect is the Integrations page titled Connect
with Claude as a tab after Codex, and Claude's sub-tabs render as filled chips. Every
#claude/* link, including cold and warm legacy #integrations/claude[/desktop], lands on
Connect > Claude > the right sub-tab. Evidence: receipt + QA verdicts under
.codexclaw/evidence/<session>/ (w2-s1..s5), full gui suite 2867 pass.

What did not improve or stays open: the Integrations strip is now 23 tabs across three
lines, so Claude is easy to find only because it sits fourth; the Codex row's page still
titles itself "Codex 인증" under the "Codex" row; the remote-link focus test flaked once
in a full run (passed alone 3x and in the rerun). The direction would be wrong if users
mainly reach Claude through the sidebar and find the extra tab click slower than the
old dedicated row - that is the first thing to ask in joint QA.
