# Dashboard alignment carry

Depends on integrated runtime for final presentation; independent PR, class C2. Carry #3697 head 4c7d6a5e07a29f7ef833019304c11343b94d102f, preserving Co-authored-by: Robin Bially <7304732+RobinBially@users.noreply.github.com>. #3689 authless-default change is outside this train.

## Exact change map
- MODIFY gui/src/styles-dashboard-workspace.css: shared label/control columns, --dash-controls-width around 26rem, container-based collapse, full-width delegation/sync rows.
- MODIFY gui/src/styles.css: consistent status card alignment and responsive version badge behavior.
- MODIFY gui/src/pages/dashboard-overview-head.tsx and dashboard-overview-sections.tsx: carry original layout classes only; preserve all handlers, state and new controls from current dev.
- MODIFY gui/src/App.tsx: sidebar/mobile version width yields to product name and retains full-value hover.
- MODIFY gui/tests/mobile-topbar-layout.test.ts: version flex-shrink and stable small-layout contract.
- MODIFY docs-site/src/content/docs/guides/web-dashboard.md; ADD original screenshot docs/pr-assets/dashboard-settings-aligned.jpg only as supplied by source PR, mark its source/version clearly. Capture updated screenshot if final rendered content differs.

Before: uneven columns, two-up tool cards squeeze controls, version text can take product space. After: wide single label/control grid; narrow stacks preserve reading order and 320px selector fit. No visible strings added; any necessary additions require all locale modules.

## Acceptance / verifier
Remote GUI lint/stylelint, GUI tests and Vite build from ci.yml; verify rendered wide/narrow state using existing browser tooling with CI-built/static artifact when available (no local suite/build). Inspect original screenshot at exact source SHA and do not claim it proves later changed content. New screenshots must show final UI, with no account info. Regression test alone is not visual proof; independently inspect UI screenshot and CSS breakpoints.

## Limits
No authless setting, quota semantics or model management expansion. Preserve current state labels and accessibility. P rechecks any intervening same-file changes before carrying.

