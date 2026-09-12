# 016 — Audit corrections (independent review, grok-4.6 explorer)

A read-only reviewer audited the committed roadmap against the tree and returned
**NEAR-PASS**. Its blocking findings are folded in here and this doc overrides 015,
020, 030, 040 and 050 wherever they disagree.

## Blocking: the reveal control cannot be a nested button

A preset row is already `<button type="button" className="list-row">`
(`ProviderCatalog.tsx:151`). A `<button>` inside a `<button>` is invalid HTML and the
parser may hoist it out of the row, so `stopPropagation` never gets a chance to run.

Correction: wrap each preset row in
`<div className="provider-catalog-row-wrap">`, keep the row button as its first child,
and render the reveal control as the row button's **sibling** inside that wrapper —
never inside it. The wrapper is the flex item; the extra line appears only on rows
whose note overflows.

## Blocking: OAuthTosWarningModal is a native dialog, not a role=dialog div

015 and 030 described it wrongly. `OAuthTosWarningModal.tsx:35-45` opens a native
`<dialog>` with `showModal()` and handles Escape through the dialog `cancel` event;
`AddProviderModal.tsx:247` is the `div role="dialog"`. The difference matters: only
`showModal()` restores focus to the control that opened it.

Correction: the note popup copies the real `OAuthTosWarningModal` implementation —
native `<dialog>`, `showModal()` on mount, `onCancel` forwarding — and is rendered as
a fragment sibling from `AddProviderModal` (`AddProviderModal.tsx:328`), not from
`ProviderCatalog`, which sits inside `.modal-card` and cannot produce a sibling
without a portal. The open flag therefore lives in `AddProviderModal` state and
`ProviderCatalog` reports the request upward through a callback prop.

## Blocking: the Escape guard must be lifted

`AddProviderModal.tsx:127-132` listens on `window` and does not check
`defaultPrevented`, which is exactly why the `!oauthTosPending` guard exists. The note
popup joins it (`&& !noteOpen`), and R1's clear-the-query-on-Escape has to live in the
same handler: `query` is `ProviderCatalog` state, child effects register after the
parent, and the parent would close the whole dialog first.
`gui/tests/add-provider-modal-backdrop.test.tsx:147` still expects a bare Escape to
close an empty catalog, so the guard must be conditional, not unconditional.
`tests/gui/oauth-tos-warning.test.ts:62` source-scans for `!oauthTosPending`,
`showModal()` and `onCancel={handleCancel}`; those substrings must survive.

## Blocking: chip focus can destroy an in-flight login

040 focused the group heading on chip click. During an Accounts login that steals
focus from the paste field, and a query that does not match the busy provider unmounts
the row outright — `shouldShowLoginHint` cannot rescue a row that is not rendered.

Correction: a busy Accounts row (`busyProvider`) is pinned into the Accounts group
regardless of the query, and chip click scrolls without moving focus while a login is
in flight.

## Correction: bucketPresets types and peel order

`bucketPresets` is `Record<ProviderTier, CatalogPreset[]>` (`provider-presets.ts:77`)
and cannot grow a `local` key. `CatalogTier` moves into `provider-presets.ts` as the
four-way type and the return becomes `Record<CatalogTier, CatalogPreset[]>`;
`ProviderCatalog.tsx:29` stops redeclaring it. 015's claim that `CatalogTier` is an
alias of `ProviderTier` was wrong — it is a separate three-string redeclaration.

Peel order is accounts first, then local: otherwise a loopback-hosted canonical forward
provider would leave the Accounts tab.

`tests/gui/provider-workspace-data.test.ts:523` does not go red on its own — its
fixture is venice/openai/nvidia/groq, so adding `local: []` keeps it green and only
its name ("all three tiers") goes stale. The peel is locked by adding an ollama row to
that fixture and asserting `buckets.local` is `["ollama"]` while `buckets.free` stays
`["nvidia"]`. Line 518's `presetTier(ollama) === "free"` must keep passing untouched.

## Correction: do not widen filterPresets, and do not widen initialTier

`tests/gui/provider-workspace-data.test.ts:538` asserts `filterPresets` never matches
adapter or baseUrl. The exact-adapter and local-alias rules from 040 go into a **new**
search function; `filterPresets` keeps its contract for browse mode. Accounts rows are
`AccountLoginRow`, a different type built in `providers-page-utils.ts`, so they need
their own label/id filter.

`AddProviderIntent.tier` (`ProviderWorkspaceShell.tsx:42`) and
`AddProviderModal.initialTier` (line 40) stay three-way. Widening them would let
empty-state tiles pass `"local"` by accident. Known consequence: the empty-state
"browse free" tile (`ProviderWorkspaceShell.tsx:620`) opens Free, which no longer
contains Ollama. A Local entry point there is follow-up work, not part of this unit.

## Correction: clamp selector and note measurements

`.provider-catalog-rows .list-row .sub` also hits account rows
(`provider-catalog.css:58`). The clamp is scoped away from
`.provider-catalog-account-row`.

Real note lengths, from `src/providers/registry.ts`: `opencode-free` 1126 characters
(not ~900), `meta-muse` 1157, `cursor` 663. The short-note fixture is
`Local — key usually blank` with an em dash (`registry.ts:2102`).

## Correction: i18n is nine catalogs with parity gates

`modal.tab.paid` exists in en, de, fr, ko, zh, zh-TW, ru, ja, tr.
`gui/tests/i18n-locales.test.ts:35` requires an exact English key set and
`gui/tests/locale-parity.test.ts` fails a locale that leaves the English string in
place without an allowlist entry. Every new key — tab label, reveal control, popup
title and close, the live-region sentence, the group headings — needs a real
translation in all nine. `gui/AGENTS.md:12` forbids hardcoded UI text.

## Correction: test placement

No new file under `tests/` is needed. Pure tier and search assertions extend the
existing `tests/gui/provider-workspace-data.test.ts`, which avoids the
`scripts/test-layout/layout.json` + `tests/fixtures/test-layout-expected.json`
double registration that `tests/test-layout-tooling.test.ts:248` enforces. React and
click behaviour goes in `gui/tests/*.tsx`, where the existing catalog component tests
already live.

## Correction: docs obligations the plan omitted

`structure/gui-and-management-api.md:304` describes the catalog browser and
`structure/AGENTS.md` obliges updating an owned area's doc when that area changes.
`gui/AGENTS.md:33` asks for `docs-site/` updates on user-facing dashboard changes.
Both land with wp4, once the final shape of the surface is known.

## Resolved: the gui screenshot gate versus the no-local-build rule

`.github/PULL_REQUEST_TEMPLATE.md:8` and `AGENTS.md:283` require a screenshot when a
PR mentions `gui`, and `localhost:10100` serves the installed build's `gui/dist`, not
this worktree's source — so a screenshot taken there would show the old UI.

Asked and answered (2026-09-12): **a GUI build or `vite dev` in this worktree is
allowed; the prohibition covers the test suite only.** So each UI-affecting PR gets a
real screenshot from a dev server running this branch's source. `bun run test`,
`bun test`, and `bun run test:changed` remain forbidden; remote CI is the only test
evidence.

## Also noted

- LM Studio's preset id is `lm-studio`, so the `lmstudio` / `lm studio` aliases are
  required rather than cosmetic.
- Moving search above the tabs changes first focus on open: `AddProviderModal.tsx:111`
  focuses the first focusable element, today the Accounts tab, afterwards the search
  field. That is the desired outcome and is called out so it is not read as a bug.
- Accounts browse ignores `rows` entirely and always maps `accountRows`
  (`ProviderCatalog.tsx:175`); search mode is the first time account rows get filtered.
