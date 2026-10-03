# Scroll repair verification

The shared shell now has one document scroller. Body horizontal clipping no longer creates a second vertical scrollport; the mobile drawer locks the document while open. The runtime delta is two CSS rules, with no settings/API changes.

The actual Codex and Claude pages reproduced the blank tail after exhausting body scrolling and then scrolling the document. Changing only body overflow removed the gap; restoring the previous rule restored it. A native WKWebView fixture independently reproduced the same mechanism, including the effect of escaped screen-reader-only descendants. Padding and background painting were not the primary cause.

## Evidence

- GUI suite: 2,756 passed, 0 failed across 316 files; root typecheck, GUI lint and production build passed.
- Actual account routes: 20/20 combinations passed across 1280, 1024, 768, 390 and 320 widths, browser and desktop user-agent mounts.
- Actual mobile drawer: wheel/touch lock plus Escape, navigation and resize dismissal passed; vertical anchor stayed in place through open/close.
- Built-CSS standalone regression: old bundle 34/62 failures; patched bundle 0/62. Entry and lazy App CSS are loaded in production order and hashed. It covers themes, short/long content, collapsed navigation, mobile drawer lock/restore and synthetic Combos containment.
- Native macOS WKWebView: 16 observations passed with hidden/clip/hidden reversal. Probe window/process were closed.
- Independent final Sol review: PASS, no blocking findings. Plan review also passed after requiring the lazy App stylesheet in the browser harness.

Raw geometry and screenshots stay in ignored scratch; the PR uses only synthetic, non-account screenshots on pr-assets. The source guard runs under ordinary GUI tests; the rendered regression is explicitly invoked with test:shared-scroll.

## Limits and integration

Packaged Tauri installation, older WebKit and zoom are not verified. Real mobile Combos keeps its existing natural page layout; synthetic containment does not prove that real page is viewport-sized. The broad root runtime suite is deferred to hosted CI because this is a shared-CSS repair; the full GUI suite and direct renderer checks ran locally. Required current-head CI and the merge outcome are recorded in the PR and goal ledger before task completion. No release, deployment or app installation is part of this change.
