# Dashboard alignment carry

Depends on integrated runtime for final presentation; independent PR, class C2. Carry #3697 head 49a9c79392babd9413831437d6ad71839737b148 (base cededd5ad1b8f8c437813c315c0705ace6c950c3), preserving Co-authored-by: Robin Bially <7304732+RobinBially@users.noreply.github.com>. #3689 authless-default change is outside this train.

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


## Hosted artifact verification

Main owns the eight-file attributed carry; handlers and visible copy remain unchanged. The existing `ci.yml` gates job uploads a preview after its GUI build when `changes.outputs.gui` is true. `actions/upload-artifact` v7.0.1 is pinned to `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`, verified against the official release and tag. The artifact contains only `gui/dist`, including generated `build-commit.txt` and `build-gui-tree.txt`, with `retention-days: 7` and `if-no-files-found: error`. Triggers, permissions, secrets, checkout behavior and release eligibility remain unchanged. This workflow surface makes the unit C4 and requires independent security review.

PR CI may build a merge ref, so compare the artifact's GUI tree with the reviewed head's `gui` tree before using its screenshots as final evidence. Serve the downloaded build with an isolated fixture API and inspect it at 1440, 1024, 768, 390 and 320 CSS pixels, including keyboard operation, focus and overflow. No local build, typecheck or repository test suite is run. Public screenshots contain synthetic data only. The original contributor screenshot is a reference, not final-head evidence.

Use manual dependent PRs after the owner's native-stack removal. CI and admin integration continue asynchronously without a local rebase. Hosted CI owns lint, typecheck, tests, build and privacy checks. The release goal remains open until publication proof is complete. There is no user-imposed token or cost cap; individual tooling runs are bounded at 30 minutes and waits at 60 seconds.
