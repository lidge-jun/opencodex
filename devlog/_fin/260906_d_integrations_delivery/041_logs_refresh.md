# Logs cycle P refresh

Current stack parent: Cursor #3707 at6005ea8017dc7d113bba0d8dcef061d4f677c60f, including the parent index repair and current dev. Original #3625 remains4f79746b4cedffeb61700113977cd72adf25c51f; its four SB Yoon-authored mailbox patches are retained in scratch. The first patch dry-run applies on this tree. Apply all four during B, preserving every authored commit, then add only the 040 amendments.

B coordination confirms3659 implementation has not started; its original scope overlaps nine locales, not styles.css. D owns logs.* keys and scoped.logs-* rules; B will carry both sets when its work starts. No whole-file overwrite of locale dictionaries.

## Design read and ownership

Existing dense diagnostic dashboard, existing colors/fonts/native selects and table. Primary workflow is immediate local filtering of already-loaded rows; reset restores defaults. Distinguish an empty ring, no matches, cold network failure, and stale refresh error. No URL-persistence feature, wizard, new icon library or redesign is introduced. Those are outside the adopted original contract.

Main applies original commits and owns Git/CI/stack, QA fixture and screenshot capture. After A, an inherited implementation worker owns only gui/src/pages/{Logs.tsx,logs-filter-bar.tsx,logs-filter.ts,logs-surface-keydown.ts}, gui/src/styles.css and the four existing/new Logs test files named in040. A separate document worker owns eight web-dashboard guides and structure05. Main preserves original locale commits and resolves any local-key conflicts.

## Browser verification construction

Use an ignored .tmp fixture that mounts the real Logs component with the real LanguageProvider and stylesheet. Logs accepts apiBase and consumes only settings/logs for the Logs tab, so a Vite middleware serves canonical synthetic LogEntry arrays and settings under an isolated same-origin /__qa/ path. No real proxy/account data or port10100 is used. Vite performs bundling only; no local test/typecheck/build script is executed. The fixture selects locale/theme and dataset from its own query parameters through normal React/DOM initialization. Browser interaction uses the native in-app browser tooling and actual controls; do not inspect private browser stores.

Capture component behavior with the source branch at its final UI commit: composition/reset/exact model, no matches/empty, keyboard radio navigation, desktop/mobile containment. Use stable synthetic timestamps away from range boundaries; deterministic timer/rollover behavior remains remote-test evidence. Publish sanitized screenshots under the existing docs-site/public/screenshots convention with immutable commit URLs in the PR. Record head/URL/viewport/locale/theme/scenario for each actual image.

Remote validation uses project Bun1.4 and explicit Node22.22 in a private macmini checkout: complete suite/typecheck, GUI lint/i18n/build, docs build. Hosted CI remains recorded separately and required at final integration. No local application suites/typecheck.

## Audit amendment: production layout constraints

The preview must use the actual stylesheet's `.app` → `.main` → `.main-inner` structure, not mount Logs at full viewport width. Include a `.sidebar` rail occupying the production232px desktop grid column, and the production `.mobile-topbar`/off-canvas sidebar arrangement at the existing breakpoint. The base main-inner max-width980px is overridden to1200px by `.main-inner:has(.logs-page)`; preserve that actual cascade and32px/36px/64px desktop padding, plus22px/18px/48px mobile padding, remain untouched. Render an inert representative navigation rail using existing classes; only Logs functionality is under test. No fixture CSS may widen the main container or shrink these paddings.

Before each containment capture, inspect rendered `.app`, `.main`, `.main-inner`, toolbar and table-wrapper rectangles at the requested viewport. The toolbar must fit the actual content box; the table's deliberate horizontal scroller is checked separately. This folds audit blocker1 and prevents falsely passing a wide standalone preview.

## Tooling preparation

Local GUI dependencies may be installed exactly from the committed lockfile with lifecycle scripts disabled, solely to run the Vite preview. This runs no local application test/typecheck/build script. All suite, lint, typecheck and production-build gates remain remote.
