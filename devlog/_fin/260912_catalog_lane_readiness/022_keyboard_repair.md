# Keyboard repair plan

Previous D locked the docs-only roadmap; source reconciliation now establishes one new defect. The original owner merged #4331 at 9a37813593514c2d90b1ebac129c4541fd2a9af4; its reviewed source tip a154645d76e98af199fd79aff8c8d393afaf30ab passed hosted CI 34672274572. This task rebased only its own unpushed roadmap commit onto that dev tip. Parent was notified of the new distinct defect; original task scope readback shows only tab overflow, description disclosure and popup focus repairs.

Class C1 behavioral patch plus existing-test coverage; no new abstraction, type, field, token, endpoint, UI copy or dependency. Do-nothing would retain a broken keyboard path; configuration cannot change the selector; reuse the existing handler and test mount. Product diff is confined to the existing selector.

MODIFY gui/src/components/provider-catalog/ProviderCatalog.tsx:207: before querySelector("button, a[href]"); after querySelector("button:not(:disabled), a[href]"). CSS :disabled also excludes a disabled fieldset descendant, while preserving actionable anchors.

MODIFY gui/tests/provider-catalog-search.test.tsx: append behavior tests using current mount/type/search helpers. Busy openai Codex row (logged out, onAccountLogin supplied), query nvidia: disabled account button is first in DOM, ArrowDown must focus NVIDIA preset and prevent default. Same busy account with unmatched query and no other actionable row: focus stays on search and default remains untouched. Empty results: same no-op. A normal preset-only query checks normal first-result focus. All tests dispatch a bubbling/cancelable KeyboardEvent from the focused input inside act. No sleep helper or exported test-only production function.

MODIFY structure/gui-and-management-api.md Add provider row: ArrowDown focuses first enabled result action; no available action leaves input focus unchanged. MODIFY docs-site/src/content/docs/guides/web-dashboard.md Add provider row with the same keyboard behavior, translated pages must not contradict (they currently say nothing about this shortcut).

Verification: git diff --check for patch formatting ONLY, independent source audit, GitHub-hosted Cross-platform CI at the exact published head. No local test/build/typecheck/install. Read hosted preview artifact from that run if GUI evidence requires it; serve artifact in scratch without product build, no live proxy mutation. No original branch/PR mutation, merge or auto-merge. Existing author commits stay in ancestry. Follow-up ordinary PR targets dev because original chain is now merged.
