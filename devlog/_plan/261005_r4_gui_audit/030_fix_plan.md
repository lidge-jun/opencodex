# 030 — wp2 fix plan (diff level)

Two PRs to `dev`, independent of each other.

## PR A — `codex/r4-gui-audit` (GUI)

F1 `gui/src/styles/sidebar-zoom.css` (desktop layout block, `@media (min-width: 761px)`):
keep the nav as the scroll area in normal windows, but floor it so it can never collapse
below about three rows, and let the sidebar itself scroll when brand + three rows + foot
do not fit:

```css
@media (min-width: 761px) {
  .sidebar { overflow-y: auto; }
  .sidebar nav { flex: 1 1 auto; min-height: 7.5rem; overflow-y: auto; padding: 4px; margin: -4px; }
}
```
Update the comment above the block. Check collapsed rail and drawer are unaffected.
Audit residuals folded: the sidebar only scrolls as a whole in short windows
(`max-height` media query), with `scroll-padding-top` so a focused row is not hidden
under the fixed macOS title strip (`gui/src/components/app-titlebar.css:38`); the
language dropdown (`portal={false}`, `gui/src/App.tsx:493`) is rendered open in a
short window to confirm it is not clipped.

F2 `gui/src/pages/claude-code-sections.tsx` sidecar rows: replace the inline styles
(`alignItems`, `flex: 1`, `display:flex; gap:8`, `minWidth: 210`) with a
`claudecode-sidecar-row` class; rules go into `gui/src/styles-claudecode-workspace.css`:

```css
.claudecode-sidecar-row { flex-wrap: wrap; align-items: flex-start; }
.claudecode-sidecar-row .setting-copy { flex: 1 1 16rem; }
.claudecode-sidecar-row .setting-controls { display: flex; flex-wrap: wrap; gap: var(--space-2); flex: 0 1 auto; min-width: 0; max-width: 100%; }
.claudecode-sidecar-row .setting-controls .input { flex: 1 1 13rem; min-width: 0; }
```
The copy keeps a 16rem basis, so when copy and controls do not fit on one line the
controls wrap below the copy instead of crushing it; inside, the model input wraps under
the backend select and fills the width.

F3 + F4 `gui/src/pages/ClaudeCode.tsx` and `gui/src/styles-claudecode-workspace.css`:
a failed Save reports in the Save bar, where the user clicked. New state `saveError`
(string). `save()` clears it on start and on success; on failure it sets it (same
message as today) instead of the page-top status. `revert()` clears it. The bar renders
`<span className="ccw-savebar-error" role="alert">` as its first child when set; the
`.ccw-savebar-state` span keeps its current text so existing selectors hold. CSS:
`.ccw-savebar-error { flex: 1 1 100%; color: var(--red); font-size: var(--text-label); }`
and `.ccw-savebar-state { flex: 1 1 auto; }` so the status wraps to its own line instead
of sliding under Revert. No new locale keys.

F5 `gui/src/pages/logs-tab-keydown.ts`: `readTabFromHash` compares
`canonicalHashPath(window.location.hash)` (from `../app-routing`) with `logs/debug`.
Add the legacy cases (`#debug`, `#debug/legacy` → debug) to the existing
`readTabFromHash` test in `gui/tests/logs-tab-keydown.test.ts` (no new test file).

Gates: `bun run typecheck`, `bun run lint:gui`, `bun run build:gui`,
`bun scripts/file-size-ratchet.ts`, `bun run privacy:scan`; before/after renders of
F1–F5 from the sandbox. Hosted CI and a full-matrix dispatch at the exact head.

## PR B — `codex/r4-docs-sync` (docs-site), built in a /tmp worktree

D1 `docs-site/src/content/docs/guides/integrations.md:86`, `:286` and the seven
translations: DSH 0.1.7+ owns the `[id=llm-pi-ai].config.providers.opencodex` row of
`$DSH_HOME/profiles/desktop/cordis.patch.yml`; `llm-pi-ai.providers.opencodex` in
`settings.yaml` is the fallback when no Desktop profile exists.
D2 visible navigation reads **Connect** (and **Connect → API Keys**) in
`guides/integrations.md:6`, `:117`, `:252`, `:452`, `:612`, `:748` (Integrations → Hermes,
Integrations → Factory Droid, …), `guides/web-dashboard.md:264` and translations,
keeping "integrations" as the feature name and the hashes unchanged.
D3 `guides/claude-code.md:921` GUI list in the current section order; the seven
translations gain the one-page / dirty / Revert / Save explanation and the rule that the
connection switch applies immediately and Save never changes it.
Gates: `bun run privacy:scan`, docs build if the docs workspace builds offline.
