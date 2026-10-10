# grok-4.6 co-design report (verbatim)

Produced by: aside exec --permission full-access -m opencodex/xai/grok-4.6, 2026-09-12.
Session 5NwmGQtOxFLx50YI. Answers the R1/R2/R3 design brief in 10_context.md.

Pick **A**. Do not auto-switch the selected tab.

The current surface is a browse catalog, not a command palette: tabs are pricing/ownership buckets (`accounts` / `free` / `paid`), search currently filters only the active bucket and is wiped on tab click, and Accounts rows are login rows rather than presets. Unified search has to leave that browse model intact when the query is empty, and replace it with a result list when it is not.

**Why not B.** Chrome Settings and JetBrains Settings do count-badges-plus-auto-jump because their tabs are sibling pages of the same object. Here a jump from Free to Paid on `"cursor"` (or from Free to Accounts on `"openai"`) changes the row *kind*: a preset-select button becomes a login row with Log in / Add account. That is the VS Code Extensions-view failure mode (Marketplace vs Installed vs Updates) if search were allowed to steal the selected tab. Keyboard users who Arrow-Right across tabs then type will also lose their place. Zero-match on the active tab plus a silent jump hides the empty state they just caused. Scroll position cannot be restored honestly because the destination list is a different dataset.

**Why not C.** "Other tabs" as a trailing section is Linear/Slack quick-switcher residue: those UIs have one result list and no tablist. Here it keeps `aria-selected` on a tab whose rows are no longer what is on screen, so a screen reader announces "Free, selected" over a Paid Cursor row. It also buries the actual hit under a possibly empty active-tab block. That is the current bug with extra chrome.

**A, with one hard rule the candidate text left soft:** while `query.trim()` is non-empty, the tab strip is no longer a tablist. It becomes in-list jump chips (Raycast category chips, GitHub Marketplace "Filters" counts, Chrome Settings left-nav counts). The selected browse tab is frozen in React state and not visually selected. Clearing the query restores that tab, its scroll container to top, and the Accounts hint / custom-provider footer that belong to it. Do not restore scroll-into-the-old-offset; the list was replaced.

Precedence that actually maps:

- VS Code Extensions: search is global; the Marketplace/Installed/Updates tabs do not jump under you. Results are one list with section headers (`INSTALLED`, `RECOMMENDED`). That is A.
- Chrome / macOS / JetBrains Settings: search replaces the page with a grouped result list; the previous pane is remembered. Chrome's left nav turns into jump targets with counts. That is A.
- Raycast / Linear / Slack switcher: no tabs, one ranked list. Use their ranking, not their chrome.
- GitHub Marketplace category tabs: a query keeps the category as a filter. That is B, and it is wrong here because Accounts is not a category of the same row type.

**Tab strip during search**

- Empty query: keep `role="tablist"` / `role="tab"` / `aria-selected` / `aria-controls` pointing at the rows container. Current markup is already a tablist with no `aria-controls` and no `id` on the panel; add those in this change. Tab click still switches bucket. Stop clearing the query on tab click; that is what makes today's search feel broken.
- Non-empty query: drop `role="tablist"` from the strip. Each control becomes `role="button"` (or a link) with `aria-controls` on the matching group heading. No `aria-selected`. A `0` count is `disabled` and not focusable. Clicking a non-zero chip `scrollIntoView`s that `<h4>` inside `.provider-catalog-rows`; it does not set `tier`. Visual: remove `.active` underline; show `Free 3` / `Paid 1` / `Local 2` / `Accounts 0`.
- Live region: one `aria-live="polite"` node, `aria-atomic="true"`, text like `7 providers across Free, Paid, Local`. Do not retarget it on chip click. On zero matches: `No providers match “cursor”` in the list, live region says the same, tab chips all disabled.
- Accounts in search: include login rows that match on `label` / `id`. Render them under an Accounts group *as account rows*, not as preset-select buttons. If a preset and a login row share an id (`openai`), show the login row in Accounts and omit the preset from other groups. The Accounts hint string stays hidden in search mode; it is browse copy.
- Footer: hide "Provider not listed?" during search. Custom-add is a browse escape hatch, not a search hit.
- Focus: search input stays focused while typing. Chip click moves focus to the group heading (`tabIndex={-1}` then `.focus()`). Escape in the input clears the query if non-empty, else closes the dialog (existing dialog Escape). Do not put ArrowDown from the input onto chips; put it onto the first result row, like Raycast / VS Code.

**Search fields and ranking**

Keep label + id as the only default haystack. That comment in `filterPresets` ("never adapter/baseUrl") is load-bearing: `openai-chat` is the adapter on Ollama, vLLM, LM Studio, Groq, Cerebras, PackyCode. Searching `"openai"` would dump half the catalog. Base-url host is worse (`localhost` hits every local row; `api` hits most paid rows). Note-body match is how you get the 1157-char Muse Code note or the 663-char Cursor note lighting up on `"sandbox"` / `"key"` / `"login"`.

Do add three explicit aliases, not substring-in-note:

1. Exact adapter match only when the query equals the adapter id (`cursor`, `ollama-native`), not when it is a prefix of `openai-chat`.
2. Local-runtime aliases: `ollama`, `vllm`, `lm studio`, `lmstudio`, `localhost` map to the Local group via `isLocalProvider`, not via haystack.
3. Highlight the matched span on label/id only.

Ranking inside a group, then group order Accounts → Free → Local → Paid:

1. Exact id or exact label, case-insensitive.
2. Label prefix (Chrome/Raycast "starts with").
3. Sponsor pin, Main before Standard, then alphabetical among sponsors. Same contract as `pinSponsors`; usage rank must not bury a paid sponsor when the query is `"orca"`.
4. Usage rank, then label.

Do not globally re-rank across groups. A paid sponsor sitting above Free NVIDIA on `"nim"` is how you get the "search is an ad slot" complaint. Sponsors already have a badge and a pin *inside* their group.

**R2: clamp + disclosure, not a nested dialog**

The row is a `<button class="list-row">` that selects the provider. A 2-line CSS clamp (`-webkit-line-clamp: 2` on `.list-row .sub`, already `min-width: 0`) is the default. Full text is a disclosure, not a popup and not a stacked modal.

- Pattern: `aria-expanded` + `aria-controls` on a nested `<button type="button">` labelled `More` / `Show full note`, with `stopPropagation`. The expanded region is a sibling under the row, `id` tied to `aria-controls`, not `role="dialog"`. Clicking More does not call `onSelectPreset`.
- Why not popover: the catalog list is `max-height: 360px; overflow-y: auto`. An anchored popover either clips or portals out of the dialog's focus trap. `@floating-ui` in a modal is more code than the note is worth.
- Why not a nested modal: `AddProviderModal` is already `role="dialog" aria-modal="true"`. A second dialog means nested inert/focus-trap (the OAuth TOS warning already does this once). A 900-character note is not a new task.
- Why not inline expand of the whole row button: expanding inside the select button makes the click target's height jump and fires selection when the user was reading. Split the targets.
- Truncate only when the note exceeds ~2 lines (roughly 120 characters, or `scrollHeight > clientHeight`). Short notes (`"Local — key usually blank"`) stay fully visible with no More control.
- Do not put the full note in `title`. Title is not keyboard accessible and the Cursor/Muse notes are longer than any tooltip.

**R3: catalog-only fourth bucket. Do not touch `providerTier`.**

`ProviderTier` is documented as a three-way pricing/ownership tag from the 2026-07-17 interview: accounts (canonical OpenAI forward) wins over free, else paid. `isFreeProvider` intentionally returns true for `authMode === "local"` and loopback URLs so the workspace Free/Paid filter and `free-paid` sort keep treating Ollama as free. `ProviderRail` already splits that further with `isLocalProvider` from `kind.ts` (`authMode === "local" || hasLoopbackBaseUrl`). The add-provider tabs over-collapsed that distinction; the rail did not.

So:

- Add `isLocalCatalogPreset(preset)` in `provider-presets.ts` that delegates to `isLocalProvider(presetTierInput(preset))`.
- Change `bucketPresets` to return `{ accounts, free, paid, local }`. Local is peeled out *after* `presetTier`, before the free push. `presetTier()` itself stays three-way. Tests that assert `presetTier(ollama) === "free"` stay green.
- Catalog tab type (`CatalogTier`) becomes four-way and is *not* `ProviderTier`. Today's alias is the bug.
- Workspace `isFreeProvider`, rail suffix, `sortWorkspaceItems`, badges: unchanged. Local rows keep the amber Local badge they already have; they do not grow a Free badge.
- Blast radius if you instead add `"local"` to `ProviderTier`: `sortWorkspaceItems` rank tables, `buildProviderWorkspace` ready-item `tier`, `ProviderSortMode` `"free-paid"` / `"accounts-first"`, `AddProviderModal` `initialTier`, every i18n `modal.tab.*`, and `tests/gui/provider-workspace-data.test.ts`. Local Ollama would also drop out of the workspace Free count (`ProviderWorkspaceShell` `freeCount`), which is a product change nobody asked for.

Default tab remains Free. Local is the fourth tab, after Free, before Paid: Accounts · Free · Local · Paid. That matches how people think ("is it logged-in, is it free cloud, is it my machine, is it billed").

**Failure modes to test**

1. Query `"openai"` on the Free tab: results group is Accounts (login row) only, or Accounts plus any preset whose *label/id* contains openai, never every `openai-chat` adapter. Clearing the query returns to Free, not Accounts. Live region does not say "Free, selected".
2. Query `"cursor"` with Free active and zero Free hits: no auto-jump, Paid group visible with the Cursor row, Free chip disabled at `0`, browse `tier` still `"free"`. ArrowDown from the input lands on Cursor, not on a chip.
3. Query `"local"` / `"ollama"` / `"localhost"`: Local group contains ollama/vllm/lm-studio; Free no longer lists them. `presetTier(ollama)` remains `"free"` in unit tests. Workspace Free count unchanged.
4. Note clamp: Cursor (~663) and Muse Code CLI (~1157) rows stay ~2 lines. Clicking More expands in-row and does not select the preset. Clicking the row body still selects. Escape closes the disclosure first if open, then clears search, then closes the dialog. No second `role="dialog"`.
5. Accounts + search + in-flight login: a matching Accounts row still renders `LoginHint` / paste field. Switching a jump-chip to Paid and back does not unmount that row's local paste state. A zero-match query does not destroy `busyProvider`. Tab click with a non-empty query does not clear the query (today's `setQuery("")` is the regression).
