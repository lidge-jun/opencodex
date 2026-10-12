# WP1: shared document scroll ownership

Dependency: existing shell in gui/src/styles.css, App.tsx and app-titlebar.css. No new types, enums or enforcement layer.

1. MODIFY gui/src/styles.css: change only body overflow-x from hidden to clip. Keep html horizontal guard, html/body/root heights, sidebar sticky/100dvh and main sizing. Add a short rationale for avoiding a second vertical scroller. Do not alter page padding. In the existing max-width:760px media block, add html:has(.sidebar.open) { overflow-y: hidden; } so the production drawer also locks the document scroller. Class removal restores the normal root overflow automatically; keep App effect and cleanup unchanged.
2. NEW gui/tests/shared-scroll-browser.ts: reuse the standalone isolated Chromium/CDP pattern from sidebar-version-browser.ts. Read both entry CSS and lazy App CSS in production order (titlebar, collapsed-sidebar and mobile Combos rules are in App CSS); record their hashes; render representative Codex/Claude account content with an absolute descendant outside a positioned ancestor to drive outer overflow. Test short/long content, browser and desktop chrome, normal/collapsed rail, desktop/tablet/mobile widths, themes, and final-control reachability. Scroll body and window successively; fail on blank beyond app or displaced desktop rail. Include mobile drawer lock/restore and Combos bounds mandatory. Write only ignored artifacts; expose deliberate old-CSS baseline mode or run against a baseline build for red proof.
3. MODIFY gui/tests/viewport-scroll-caps.test.ts: extend the existing effective-declaration guards for body clipping and mobile root lock; this default-CI source check complements rendered tests. MODIFY gui/package.json: add test:shared-scroll script for the standalone browser regression. It is explicit execution, not part of bun test tests discovery.
4. MODIFY owning structure GUI/layout documentation: state normal pages use document scrolling and clipping must not create a body scroller. Review dashboard/desktop owners; no provider/API doc changes.
5. MODIFY unit 090_summary.md at completion and move unit to _fin. Publish reviewed screenshot through pr-assets and open normal dev PR with full template.

## Acceptance activation

- Long Codex and Claude account content: two downward scroll gestures (or equivalent body+document scrolling) end with sidebar top approximately 0 and bottom viewport height; no blank tail beyond app. Toggle old body hidden on/off restores/removes defect.
- Short content: no vertical overflow introduced; normal bottom whitespace is not a failure.
- Browser/desktop chrome and both themes: no titlebar displacement or rail discontinuity.
- 1280/1024/768 wide views and 390/320 mobile: horizontal clipping retained, final control reachable. Fixed drawer remains viewport-bound; drive the actual App drawer effect, confirm wheel/touch document lock and restoration with stable content viewport position and restored document position after close; test Escape, navigation dismissal and resize past 760px. Recheck actual Codex and Claude routes after the patch.
- Combos: existing explicit viewport scroller remains within its available height; no outer blank tail.
- GUI suite/lint/build, root typecheck, structure gate and required current-head CI succeed. Standalone browser regression is run explicitly. Do not represent emulated desktop classes as packaged WKWebView execution.

Test implementation is delegated to a Sol worker owning only gui/tests/shared-scroll-browser.ts, gui/tests/viewport-scroll-caps.test.ts and gui/package.json after A passes. Main owns CSS, docs, browser diagnosis, commits, PR and merge. Independent Sol reviewer owns read-only A and separate fresh final review.
