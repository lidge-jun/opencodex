# 015 — Co-design with xai/grok-4.6, and what we took from it

Full report: `evidence/grok-4.6-codesign.md` (verbatim). Run:
`aside exec --permission full-access -m opencodex/xai/grok-4.6`, session `5NwmGQtOxFLx50YI`,
2026-09-12. It read the real files (`ProviderCatalog.tsx`, `provider-presets.ts`,
`catalog.ts`, `kind.ts`, `provider-catalog.css`, the i18n tables and
`tests/gui/provider-workspace-data.test.ts`) before answering.

Worth noting because it changes how much weight the verdict carries: mid-run the
model's scratch reasoning picked **B** (tabs keep filtering, auto-switch to the first
tab with matches). Its final answer reverses that and argues against its own earlier
pick. The reversal is the useful part, so the reasoning is reproduced below rather
than just the conclusion.

## Accepted

**R1 = option A: search mode replaces browse mode.** While `query.trim()` is non-empty
the list shows every match across all tiers, grouped with headings, and the selected
tab is frozen rather than moved. The argument that settled it: a jump from Free to
Accounts on `"openai"` does not just change which rows are listed, it changes the
*kind* of row — a preset-select button becomes a login row with Log in / Add account
buttons. Auto-switching between those is the VS Code Extensions-view
Marketplace/Installed/Updates failure. And scroll position cannot be restored honestly
across a jump because the destination is a different dataset.

**The tab strip stops being a tablist during search.** Empty query: real tablist,
`aria-selected`, `aria-controls` on the rows container (which needs an `id` it does not
have today). Non-empty query: the same controls become jump chips —
`role="button"`, no `aria-selected`, a count each, `disabled` at zero, and a click
scrolls to that group heading instead of setting `tier`. This is the honest answer to
"how does the tab move": it does not move, it becomes an index.

**Stop clearing the query on tab click.** `setQuery("")` inside the tab `onClick` is
the existing bug that makes the current search feel broken.

**Keep the haystack at label + id.** The `filterPresets` comment ("never
adapter/baseUrl") is load-bearing: `openai-chat` is the adapter on Ollama, vLLM,
LM Studio, Groq, Cerebras and PackyCode, so matching adapters would dump half the
catalog on `"openai"`; `localhost` would hit every local row. Widen only through
explicit rules — an **exact** adapter-id equality match, and local-runtime aliases
(`ollama`, `vllm`, `lmstudio`, `lm studio`, `localhost`) resolved through
`isLocalProvider` rather than substring matching.

**Ranking inside a group, never across groups:** exact id/label, then label prefix,
then the existing sponsor pin, then usage rank, then label. Global re-ranking would let
a paid sponsor sit above free NVIDIA on `"nim"`, which reads as an ad slot. Group order
Accounts → Free → Local → Paid.

**Accounts rows participate in search**, rendered as account rows under an Accounts
group. When a login row and a preset share an id (`openai`), the login row wins and the
preset is omitted. The Accounts hint and the "provider not listed?" footer are browse
copy and hide during search.

**R3 = catalog-only fourth bucket.** `providerTier` stays three-way; `bucketPresets`
peels local out after classification via `isLocalProvider`; `CatalogTier` becomes
four-way and stops being an alias of `ProviderTier`. The blast radius of the
alternative is concrete: `sortWorkspaceItems` rank tables, `buildProviderWorkspace`
ready-item tiers, `ProviderSortMode`, `AddProviderModal.initialTier`, every
`modal.tab.*` string, `tests/gui/provider-workspace-data.test.ts`, and the workspace
`freeCount` would silently stop counting Ollama — a product change nobody asked for.
Tab order Accounts · Free · Local · Paid; default stays Free.

## Rejected, with reasons

**R2: grok says inline disclosure (`aria-expanded` + `aria-controls`, a sibling region
under the row), explicitly "not a popup and not a stacked modal". We are shipping the
popup anyway.** Two reasons outrank the advice. First, the user asked for one in
plain words — "클릭하면 팝업에서 보이기" — and an explicit instruction beats a
consultant's preference. Second, grok's own objection does not survive contact with
this container: `.provider-catalog-rows` is `max-height: 360px; overflow-y: auto`, so
expanding a 1157-character note *inline* pushes every row below it out of view and
drops the reader's place in the exact list they were scanning. Its nested-dialog
objection is also weaker than it looks here, because `AddProviderModal` already stacks
a second `role="dialog"` overlay — `OAuthTosWarningModal` — as a sibling, so the
pattern is established, reviewed and working in this file.

What we keep from the advice: the two-line clamp is CSS, the reveal control is a nested
`<button type="button">` with `stopPropagation` so it never selects the provider, the
control only renders when the note actually overflows, and the full note never goes
into `title` (not keyboard reachable, and far too long for a tooltip).

**Escape ordering** follows grok: note popup first, then a non-empty query, then the
dialog. `AddProviderModal` already guards its Escape handler with `oauthTosPending`;
the note popup joins that guard.

## Failure modes adopted as test targets

Its five are taken as-is and are restated per work-phase in `020`/`030`/`040`. The
sharpest one is #5: a tab/chip interaction during an in-flight Accounts login must not
unmount the row that owns the paste field and `LoginHint`.
